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
  assertExpectedRevision,
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { ClaimMachine } from '../identity.machines';
import {
  claimIssuerAssignsStaffRoles,
  hashToken,
  holdsStaffMembership,
  hoursFromNow,
  newToken,
  normalizeContactValue,
  personColumns,
  requireStaffLoginAuthority,
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
      // §4.10: the target is the person, so a denial reads exactly like a missing person.
      await this.authorization.require(principal, IdentityActions.issueClaim, {
        type: 'person',
        organizationId,
        subjectPersonIds: [subjectPersonId],
        protected: true,
      });
      if (subject.status !== 'active') {
        throw errors.invalidTransition('Person', subject.status, 'issue_claim');
      }
      if (input.kind === 'self') {
        // The contract refuses this too; kept here for callers of the exported service.
        if (input.recipientContact) {
          throw errors.validation(
            'A self claim cannot be bound to a contact point until verified provider contact claims are available; hand the token over in person.',
            { path: 'recipientContact' },
          );
        }
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
        // §4.14, SPK-AT-025: a self claim hands the person's login to whoever holds the token, so
        // on a person with a staff membership it needs the authority that assigns staff roles.
        await requireStaffLoginAuthority(
          this.authorization,
          trx,
          principal,
          organizationId,
          subjectPersonId,
          this.clock.now(),
        );
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
      // §4.9, SPK-IAM-002: locked, so a second concurrent claimant waits and then finds the claim
      // already accepted (one token, one acceptance).
      const claim = await trx
        .selectFrom('claims')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('token_hash', '=', hashToken(token))
        .forUpdate()
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
        // SPK-IAM-002, §4.14: a self claim written to a contact point can only be honoured once the
        // claimant's provider-verified contact is known (identity provider, DEC-018); an account
        // without a person holds no verified contact point, so the claim fails closed.
        if (claim.recipient_contact_kind) {
          throw errors.accessDenied(
            'This claim was issued to a contact point your account has not verified.',
          );
        }
        // §4.14, SPK-AT-025: a staff membership may have been added after the claim was issued;
        // the login of a staff person is handed over only on a claim issued with staff-role
        // authority (the claimant learns only that the claim cannot be accepted).
        if (
          account.person_id !== claim.subject_person_id &&
          !claimIssuerAssignsStaffRoles(claim.issued_by) &&
          (await holdsStaffMembership(trx, organizationId, claim.subject_person_id, now))
        ) {
          throw errors.accessDenied(
            'This claim cannot be accepted; ask an administrator to issue a new one.',
          );
        }
        if (account.person_id === claim.subject_person_id) {
          personId = claim.subject_person_id;
        } else if (account.person_id === null) {
          try {
            const linked = await trx
              .updateTable('accounts')
              .set({ person_id: claim.subject_person_id, revision: account.revision + 1 })
              .where('id', '=', account.id)
              .where('revision', '=', account.revision)
              .executeTakeFirst();
            ensureUpdated(linked.numUpdatedRows, () =>
              errors.staleRevision(account.revision, account.revision + 1),
            );
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

      const accepted = await trx
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
        .executeTakeFirst();
      ensureUpdated(accepted.numUpdatedRows, () =>
        errors.staleRevision(claim.revision, claim.revision + 1),
      );
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

  /**
   * SPK-IAM-002 / SPK-IAM-006: staff revoke a pending claim, so a leaked or misdelivered token can
   * no longer be accepted. Locked against a concurrent accept (§4.9).
   */
  async revoke(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision?: number },
    correlationId: string | null,
  ): Promise<Claim> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const claim = await trx
        .selectFrom('claims')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!claim) throw errors.protectedNotFound('claim');
      // §4.10: the claim concerns its subject person; a denial reads like a missing claim.
      await this.authorization.require(principal, IdentityActions.revokeClaim, {
        type: 'claim',
        id,
        organizationId,
        subjectPersonIds: [claim.subject_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, claim.revision);
      const next = ClaimMachine.next(claim.status, 'revoke');
      const now = this.clock.now();
      const revoked = await trx
        .updateTable('claims')
        .set({
          status: next,
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
          revision: claim.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', claim.revision)
        .executeTakeFirst();
      ensureUpdated(revoked.numUpdatedRows, () =>
        errors.staleRevision(claim.revision, claim.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.revokeClaim.id,
        targetType: 'claim',
        targetId: id,
        beforeRevision: claim.revision,
        afterRevision: claim.revision + 1,
        reason: input.reason,
        correlationId,
        details: { subjectPersonId: claim.subject_person_id, kind: claim.kind },
      });
      await this.outbox.enqueue(trx, IdentityEvents.claimRevoked, {
        organizationId,
        aggregateType: 'claim',
        aggregateId: id,
        payload: { claimId: id, subjectPersonId: claim.subject_person_id, reason: input.reason },
        correlationId,
      });
      const updated = await trx
        .selectFrom('claims')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toClaim(updated);
    });
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
    const expired = await trx
      .updateTable('claims')
      .set({ status: next, revision: claim.revision + 1 })
      .where('id', '=', claim.id)
      .where('revision', '=', claim.revision)
      .executeTakeFirst();
    ensureUpdated(expired.numUpdatedRows, () =>
      errors.staleRevision(claim.revision, claim.revision + 1),
    );
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
