import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AccessGrant,
  type Claim,
  type IssueClaimInput,
  type Principal,
  type Relationship,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import type { ClaimsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { ClaimMachine } from '../identity.machines';
import {
  hashToken,
  hoursFromNow,
  newToken,
  normalizeContactValue,
  personColumns,
  toAccessGrant,
  toClaim,
  toRelationship,
  type PersonRow,
} from '../identity.shared';
import { RelationshipsService } from './relationships.service';

export interface ClaimAccepted {
  claim: Claim;
  accountId: string;
  personId: string;
  relationship: Relationship | null;
  grants: AccessGrant[];
}

/**
 * Claims (SPK-IAM-002): a registration entered by staff is later claimable by the correct verified
 * customer without creating another participant. A `self` claim links the claimant's account to
 * the existing person; a `guardian` claim creates guardianship over the existing child. No person
 * row is ever created here, and nothing is granted beyond what staff wrote on the claim.
 */
@Injectable()
export class ClaimsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly relationships: RelationshipsService,
  ) {}

  async issue(
    principal: Principal,
    subjectPersonId: string,
    input: IssueClaimInput,
    correlationId: string | null,
  ): Promise<Claim & { token: string }> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const subject = await this.loadPerson(trx, organizationId, subjectPersonId);
      if (!subject) throw errors.protectedNotFound('person');
      await this.authorization.require(principal, IdentityActions.issueClaim, {
        type: 'claim',
        organizationId,
        subjectPersonIds: [subjectPersonId],
        protected: true,
      });
      if (subject.status !== 'active') {
        throw errors.invalidTransition('Person', subject.status, 'issue_claim');
      }
      if (input.kind === 'self') {
        if (subject.kind !== 'adult') {
          throw errors.validation('A child record cannot be self-claimed; issue a guardian claim.');
        }
        const linked = await trx
          .selectFrom('accounts')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('person_id', '=', subjectPersonId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (linked) throw errors.resourceConflict('This person already has an active account.');
      }
      const id = newId();
      const token = newToken();
      const now = this.clock.now();
      await trx
        .insertInto('claims')
        .values({
          id,
          organization_id: organizationId,
          subject_person_id: subjectPersonId,
          kind: input.kind,
          requested_permissions: [...new Set(input.requestedPermissions)],
          issued_by: json(snapshotActor(principal)),
          recipient_contact_kind: input.recipientContact?.kind ?? null,
          recipient_contact_value: input.recipientContact
            ? normalizeContactValue(input.recipientContact.kind, input.recipientContact.value)
            : null,
          token_hash: hashToken(token),
          expires_at: hoursFromNow(now, input.expiresInHours),
          accepted_at: null,
          accepted_by_account_id: null,
          accepted_by_person_id: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.issueClaim.id,
        targetType: 'claim',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          subjectPersonId,
          kind: input.kind,
          requestedPermissions: input.requestedPermissions,
          recipientContactKind: input.recipientContact?.kind ?? null,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.claimIssued, {
        organizationId,
        aggregateType: 'claim',
        aggregateId: id,
        payload: { claimId: id, subjectPersonId, kind: input.kind },
        correlationId,
      });
      const row = await trx
        .selectFrom('claims')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return { ...toClaim(row), token };
    });
  }

  async accept(
    principal: Principal,
    token: string,
    correlationId: string | null,
  ): Promise<ClaimAccepted> {
    const organizationId = principal.organizationId;
    const accountId = principal.accountId;
    if (!organizationId || !accountId) throw errors.authenticationRequired();
    const outcome = await runInTransaction(this.uow, async ({ trx }) => {
      const claim = await trx
        .selectFrom('claims')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('token_hash', '=', hashToken(token))
        .executeTakeFirst();
      if (!claim) throw errors.protectedNotFound('claim');
      const now = this.clock.now();
      if (claim.status === 'pending' && new Date(claim.expires_at).getTime() <= now.getTime()) {
        await this.expire(trx, principal, claim, correlationId);
        return { expired: true as const };
      }
      const next = ClaimMachine.next(claim.status, 'accept');
      const account = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!account) throw errors.authenticationRequired('No active account matches this token.');

      let personId: string;
      let relationship: Relationship | null = null;
      let grants: AccessGrant[] = [];
      if (claim.kind === 'self') {
        if (account.person_id === claim.subject_person_id) {
          personId = claim.subject_person_id;
        } else if (account.person_id === null) {
          try {
            await trx
              .updateTable('accounts')
              .set({ person_id: claim.subject_person_id, revision: account.revision + 1 })
              .where('id', '=', account.id)
              .where('revision', '=', account.revision)
              .execute();
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw errors.resourceConflict('This person already has an active account.');
            }
            throw error;
          }
          personId = claim.subject_person_id;
          await this.audit.record(trx, {
            organizationId,
            actor: principal,
            action: IdentityActions.manageAccount.id,
            targetType: 'account',
            targetId: account.id,
            beforeRevision: account.revision,
            afterRevision: account.revision + 1,
            correlationId,
            details: { operation: 'link', personId, via: 'claim', claimId: claim.id },
          });
          await this.outbox.enqueue(trx, IdentityEvents.accountLinked, {
            organizationId,
            aggregateType: 'account',
            aggregateId: account.id,
            payload: { accountId: account.id, personId, via: 'claim' },
            correlationId,
          });
        } else {
          // The account already represents a different person: never create a second person and
          // never silently merge. Staff review the pair as a duplicate candidate (SPK-IAM-007).
          return {
            expired: false as const,
            conflict: {
              existingPersonId: account.person_id,
              subjectPersonId: claim.subject_person_id,
            },
          };
        }
      } else {
        if (!account.person_id) {
          throw errors.accessDenied('Link your account to a person before claiming guardianship.');
        }
        const claimant = await this.loadPerson(trx, organizationId, account.person_id);
        if (!claimant || claimant.status !== 'active' || claimant.kind !== 'adult') {
          throw errors.accessDenied('Only an active adult can claim guardianship.');
        }
        if (claimant.id === claim.subject_person_id) {
          throw errors.validation('A person cannot claim guardianship over themselves.');
        }
        if (claim.recipient_contact_kind && claim.recipient_contact_value) {
          const verified = await trx
            .selectFrom('contact_points')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('person_id', '=', claimant.id)
            .where('kind', '=', claim.recipient_contact_kind)
            .where('value', '=', claim.recipient_contact_value)
            .where('verified_at', 'is not', null)
            .executeTakeFirst();
          if (!verified) {
            throw errors.accessDenied(
              'This claim was issued to a contact point your account has not verified.',
            );
          }
        }
        personId = claimant.id;
        const result = await this.relationships.ensureAuthority(trx, principal, organizationId, {
          actorPersonId: claimant.id,
          subjectPersonId: claim.subject_person_id,
          kind: 'guardian',
          permissions: claim.requested_permissions,
          source: 'claim',
          correlationId,
        });
        relationship = toRelationship(result.relationship);
        grants = result.grants.map((g) => toAccessGrant(g, result.relationship.status, now));
      }

      await trx
        .updateTable('claims')
        .set({
          status: next,
          accepted_at: now,
          accepted_by_account_id: account.id,
          accepted_by_person_id: personId,
          revision: claim.revision + 1,
        })
        .where('id', '=', claim.id)
        .where('revision', '=', claim.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.acceptClaim.id,
        targetType: 'claim',
        targetId: claim.id,
        beforeRevision: claim.revision,
        afterRevision: claim.revision + 1,
        correlationId,
        details: { kind: claim.kind, subjectPersonId: claim.subject_person_id, personId },
      });
      await this.outbox.enqueue(trx, IdentityEvents.claimAccepted, {
        organizationId,
        aggregateType: 'claim',
        aggregateId: claim.id,
        payload: {
          claimId: claim.id,
          subjectPersonId: claim.subject_person_id,
          accountId: account.id,
          personId,
          kind: claim.kind,
        },
        correlationId,
      });
      const updated = await trx
        .selectFrom('claims')
        .selectAll()
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow();
      return {
        expired: false as const,
        result: { claim: toClaim(updated), accountId: account.id, personId, relationship, grants },
      };
    });
    if (outcome.expired) throw errors.invalidTransition('Claim', 'expired', 'accept');
    if ('conflict' in outcome && outcome.conflict) {
      await this.flagConflict(principal, organizationId, outcome.conflict, correlationId);
      throw errors.resourceConflict(
        'Your account already represents a person. A duplicate review has been opened for staff.',
        outcome.conflict,
      );
    }
    return outcome.result;
  }

  private async flagConflict(
    principal: Principal,
    organizationId: string,
    pair: { existingPersonId: string; subjectPersonId: string },
    correlationId: string | null,
  ): Promise<void> {
    const [a, b] =
      pair.existingPersonId < pair.subjectPersonId
        ? [pair.existingPersonId, pair.subjectPersonId]
        : [pair.subjectPersonId, pair.existingPersonId];
    await runInTransaction(this.uow, async ({ trx }) => {
      const id = newId();
      const inserted = await trx
        .insertInto('duplicate_candidates')
        .values({
          id,
          organization_id: organizationId,
          person_a_id: a,
          person_b_id: b,
          reasons: ['claim_by_account_with_existing_person'],
          score: 60,
          flagged_by: json(snapshotActor(principal)),
          decision: null,
          decided_by: null,
          decided_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'person_a_id', 'person_b_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.flagDuplicate.id,
        targetType: 'duplicate_candidate',
        targetId: id,
        correlationId,
        details: { personAId: a, personBId: b, reasons: ['claim_by_account_with_existing_person'] },
      });
      await this.outbox.enqueue(trx, IdentityEvents.duplicateCandidateFlagged, {
        organizationId,
        aggregateType: 'duplicate_candidate',
        aggregateId: id,
        payload: { candidateId: id, personAId: a, personBId: b, score: 60 },
        correlationId,
      });
    });
  }

  private async expire(
    trx: Trx,
    principal: Principal,
    claim: Selectable<ClaimsTable>,
    correlationId: string | null,
  ): Promise<void> {
    const next = ClaimMachine.next(claim.status, 'expire');
    await trx
      .updateTable('claims')
      .set({ status: next, revision: claim.revision + 1 })
      .where('id', '=', claim.id)
      .where('revision', '=', claim.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: claim.organization_id,
      actor: principal,
      action: IdentityActions.acceptClaim.id,
      targetType: 'claim',
      targetId: claim.id,
      beforeRevision: claim.revision,
      afterRevision: claim.revision + 1,
      correlationId,
      details: { outcome: 'expired' },
    });
  }

  private async loadPerson(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<PersonRow | null> {
    const row = await trx
      .selectFrom('persons')
      .select(personColumns)
      .where('persons.organization_id', '=', organizationId)
      .where('persons.id', '=', id)
      .executeTakeFirst();
    return (row as PersonRow | undefined) ?? null;
  }
}
