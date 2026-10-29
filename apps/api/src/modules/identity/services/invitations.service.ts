import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AccessGrant,
  type CreateInvitationInput,
  type DeclineInvitationInput,
  type Invitation,
  type InvitationView,
  type ListInvitationsQueryInput,
  type ListMyInvitationsQueryInput,
  type Page,
  type Principal,
  type Relationship,
} from '@sportspark/contracts';
import {
  json,
  type Database,
  type Db,
  type GrantPermissionValue,
  type InvitationStatus,
} from '@sportspark/db';
import type { InvitationsTable } from '@sportspark/db';
import { sql, type SelectQueryBuilder, type Selectable, type SqlBool } from 'kysely';
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
import { InvitationMachine } from '../identity.machines';
import {
  displayNamesOf,
  hashToken,
  hoursFromNow,
  iso,
  newToken,
  normalizeContactValue,
  personColumns,
  staffAuthorityApplies,
  toAccessGrant,
  toInvitation,
  toRelationship,
  type PersonRow,
} from '../identity.shared';
import { buildPrincipal } from './principal-resolver.service';
import { RelationshipAuthority } from './relationship-authority.service';
import { RelationshipsService } from './relationships.service';

export interface InvitationAccepted {
  invitation: Invitation;
  relationships: Relationship[];
  grants: AccessGrant[];
  droppedPermissions: GrantPermissionValue[];
}

type InvitationScope =
  { type: 'person'; personId: string } | { type: 'household'; householdId: string };

/** How the inviter was authorized when the invitation was issued (stored on `invited_by`). */
type InvitationBasis = 'staff_role' | 'delegated';

/** Which path recorded an expiry (IF-25): the background sweep or a lazy check on a command. */
export type ExpiryPath = 'sweep' | 'acceptance_attempt';

const ListCursor = z.object({ c: z.iso.datetime(), id: z.uuid() });

type InvitationRow = Selectable<InvitationsTable>;

/** A pending invitation past its expiry reads as expired before any write (ID-03). */
export function effectiveInvitationStatus(
  row: Pick<InvitationRow, 'status' | 'expires_at'>,
  now: Date,
): InvitationStatus {
  return row.status === 'pending' && new Date(row.expires_at).getTime() <= now.getTime()
    ? 'expired'
    : row.status;
}

/**
 * Invitations (SPK-IAM-004). The record keeps the inviting actor, recipient, scope, requested
 * permissions, expiry, acceptance and revocation; the people the scope covers are fixed at issue
 * (`invitation_subjects`, §4.5). Acceptance grants only to those people, and only the requested
 * permissions the inviter is still authorized for at that moment: a staff inviter must still hold
 * a staff role that covers invitations, a customer inviter must still hold each permission as a
 * guardian. The rest are dropped and reported, never silently implied.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly relationships: RelationshipsService,
    private readonly authority: RelationshipAuthority,
  ) {}

  async create(
    principal: Principal,
    input: CreateInvitationInput,
    correlationId: string | null,
  ): Promise<Invitation & { token: string }> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    // The branch follows the authority actually used, not principal.kind (SPK-IAM acceptance
    // example 3): a coach who is also a parent invites as a parent.
    const viaStaffRole = await staffAuthorityApplies(
      this.authorization,
      principal,
      IdentityActions.createInvitation,
      organizationId,
    );
    return runInTransaction(this.uow, async ({ trx }) => {
      let subjects: string[];
      if (viaStaffRole) {
        subjects = await this.scopeSubjects(trx, organizationId, input.scope);
      } else {
        if (!principal.personId) throw errors.protectedNotFound(input.scope.type);
        subjects = await this.scopeSubjects(trx, organizationId, input.scope, principal.personId);
        // §4.10: the target names the scope record, so a denial reads exactly like a missing one.
        await this.authorization.require(principal, IdentityActions.createInvitation, {
          type: input.scope.type,
          organizationId,
          subjectPersonIds: subjects,
          protected: true,
        });
        // Delegation (SPK-IAM-001/003/004; DEC-089 proposed default, pending): only a guardian
        // may invite others, and only into permissions they hold as guardian. A delegate or
        // caregiver cannot pass their access on, and nobody can mint a guardian relationship from
        // a delegate's grant.
        for (const subject of subjects) {
          for (const permission of input.requestedPermissions) {
            const held = await this.authority.hasPermissionAsGuardian(
              organizationId,
              principal.personId,
              subject,
              permission,
              trx,
            );
            if (!held) {
              throw errors.participantAuthorityRequired(
                `Only a guardian may invite others, and only into permissions held as guardian ('${permission}').`,
              );
            }
          }
        }
      }
      let recipientPersonId: string | null = null;
      if (input.recipientPersonId) {
        const recipient = await this.loadPerson(trx, organizationId, input.recipientPersonId);
        if (viaStaffRole) {
          if (!recipient || recipient.status !== 'active') {
            throw errors.notFound('person', input.recipientPersonId);
          }
          if (recipient.kind !== 'adult') {
            throw errors.validation('Only an adult can be invited to hold authority.');
          }
        } else if (!recipient || recipient.status !== 'active' || recipient.kind !== 'adult') {
          // §4.10: a customer learns nothing about a person they cannot invite (missing,
          // inactive or a child all read the same).
          throw errors.protectedNotFound('person');
        }
        if (subjects.includes(recipient.id)) {
          throw errors.validation('A person cannot be invited over themselves.');
        }
        recipientPersonId = recipient.id;
      }
      const basis: InvitationBasis = viaStaffRole ? 'staff_role' : 'delegated';
      const id = newId();
      const token = newToken();
      const now = this.clock.now();
      await trx
        .insertInto('invitations')
        .values({
          id,
          organization_id: organizationId,
          invited_by: json({ ...snapshotActor(principal), basis }),
          invited_by_person_id: principal.personId,
          recipient_person_id: recipientPersonId,
          recipient_contact_kind: input.recipientContact?.kind ?? null,
          recipient_contact_value: input.recipientContact
            ? normalizeContactValue(input.recipientContact.kind, input.recipientContact.value)
            : null,
          scope_type: input.scope.type,
          scope_person_id: input.scope.type === 'person' ? input.scope.personId : null,
          scope_household_id: input.scope.type === 'household' ? input.scope.householdId : null,
          relationship_kind: input.relationshipKind,
          requested_permissions: [...new Set(input.requestedPermissions)],
          token_hash: hashToken(token),
          expires_at: hoursFromNow(now, input.expiresInHours),
          accepted_at: null,
          accepted_by_person_id: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
        })
        .execute();
      // SPK-IAM-004, §4.5: the inviter authorized exactly these people; acceptance never widens it.
      await trx
        .insertInto('invitation_subjects')
        .values(
          subjects.map((personId) => ({
            organization_id: organizationId,
            invitation_id: id,
            person_id: personId,
          })),
        )
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.createInvitation.id,
        targetType: 'invitation',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          scope: input.scope,
          subjects,
          basis,
          relationshipKind: input.relationshipKind,
          requestedPermissions: input.requestedPermissions,
          recipientPersonId,
          recipientContactKind: input.recipientContact?.kind ?? null,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.invitationCreated, {
        organizationId,
        aggregateType: 'invitation',
        aggregateId: id,
        payload: {
          invitationId: id,
          recipientPersonId,
          recipientContactKind: input.recipientContact?.kind ?? null,
          expiresAt: hoursFromNow(now, input.expiresInHours).toISOString(),
        },
        correlationId,
      });
      const row = await this.load(trx, organizationId, id);
      if (!row) throw errors.internal('Invitation was not persisted.');
      return { ...toInvitation(row), token };
    });
  }

  async accept(
    principal: Principal,
    id: string,
    token: string,
    correlationId: string | null,
  ): Promise<InvitationAccepted> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const outcome = await runInTransaction(this.uow, async ({ trx }) => {
      // §4.9, SPK-IAM-004: locked, so a concurrent accept or revoke waits and then sees this
      // one's outcome (an invitation is accepted once, by one person).
      const invitation = await this.load(trx, organizationId, id, { lock: true });
      // Token mismatch and cross-organization ids look identical: not found (§4.10).
      if (!invitation || invitation.token_hash !== hashToken(token)) {
        throw errors.protectedNotFound('invitation');
      }
      if (!principal.personId) {
        throw errors.accessDenied('Link your account to a person before accepting invitations.');
      }
      if (invitation.recipient_person_id) {
        await this.authorization.require(principal, IdentityActions.acceptInvitation, {
          type: 'invitation',
          id,
          organizationId,
          subjectPersonIds: [invitation.recipient_person_id],
          protected: true,
        });
      } else {
        await this.assertVerifiedContact(
          trx,
          organizationId,
          principal.personId,
          invitation.recipient_contact_kind as 'email' | 'phone',
          invitation.recipient_contact_value as string,
        );
      }
      const now = this.clock.now();
      if (
        invitation.status === 'pending' &&
        new Date(invitation.expires_at).getTime() <= now.getTime()
      ) {
        await this.expire(trx, principal, invitation, correlationId, 'acceptance_attempt');
        return { expired: true as const };
      }
      const next = InvitationMachine.next(invitation.status, 'accept');
      const acceptor = await this.loadPerson(trx, organizationId, principal.personId);
      if (!acceptor || acceptor.status !== 'active' || acceptor.kind !== 'adult') {
        throw errors.accessDenied(
          'Only an active adult can accept an invitation to hold authority.',
        );
      }
      // SPK-IAM-004, §4.5: only the people fixed at issue, minus any that left the scope since.
      const { subjects, droppedSubjects } = await this.acceptanceSubjects(
        trx,
        organizationId,
        invitation,
      );
      if (subjects.length === 0) {
        throw errors.validation('Nobody this invitation was issued for is still in its scope.', {
          droppedSubjects,
        });
      }
      if (subjects.includes(acceptor.id)) {
        throw errors.validation('A person cannot accept authority over themselves.');
      }

      const inviter = await this.inviterAuthority(trx, organizationId, invitation);
      const inviterId = invitation.invited_by_person_id;
      const relationships: Relationship[] = [];
      const grants: AccessGrant[] = [];
      const grantIds: string[] = [];
      const grantedUnion = new Set<GrantPermissionValue>();
      const dropped = new Set<GrantPermissionValue>();
      for (const subject of subjects) {
        const authorized: GrantPermissionValue[] = [];
        for (const permission of invitation.requested_permissions) {
          const ok =
            inviter === 'authorized' ||
            (inviter === 'delegated' &&
              inviterId !== null &&
              (await this.authority.hasPermissionAsGuardian(
                organizationId,
                inviterId,
                subject,
                permission,
                trx,
              )));
          if (ok) authorized.push(permission);
          else dropped.add(permission);
        }
        // Nothing authorized for this person: no relationship either (nothing is implied).
        if (authorized.length === 0) continue;
        const result = await this.relationships.ensureAuthority(trx, principal, organizationId, {
          actorPersonId: acceptor.id,
          subjectPersonId: subject,
          kind: invitation.relationship_kind,
          permissions: authorized,
          source: 'invitation',
          correlationId,
        });
        relationships.push(toRelationship(result.relationship));
        for (const g of result.grants) {
          grants.push(toAccessGrant(g, result.relationship.status, now));
          grantedUnion.add(g.permission);
        }
        grantIds.push(...result.createdGrantIds);
      }
      const accepted = await trx
        .updateTable('invitations')
        .set({
          status: next,
          accepted_at: now,
          accepted_by_person_id: acceptor.id,
          granted_permissions: [...grantedUnion],
          revision: invitation.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', invitation.revision)
        .executeTakeFirst();
      ensureUpdated(accepted.numUpdatedRows, () =>
        errors.staleRevision(invitation.revision, invitation.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.acceptInvitation.id,
        targetType: 'invitation',
        targetId: id,
        beforeRevision: invitation.revision,
        afterRevision: invitation.revision + 1,
        correlationId,
        details: {
          granted: [...grantedUnion],
          dropped: [...dropped],
          subjects,
          droppedSubjects,
          inviterAuthority: inviter,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.invitationAccepted, {
        organizationId,
        aggregateType: 'invitation',
        aggregateId: id,
        payload: {
          invitationId: id,
          acceptedByPersonId: acceptor.id,
          grantIds,
          droppedPermissions: [...dropped],
        },
        correlationId,
      });
      const updated = await this.load(trx, organizationId, id);
      return {
        expired: false as const,
        result: {
          invitation: toInvitation(updated as Selectable<InvitationsTable>),
          relationships,
          grants,
          droppedPermissions: [...dropped],
        },
      };
    });
    if (outcome.expired) throw errors.invalidTransition('Invitation', 'expired', 'accept');
    return outcome.result;
  }

  async revoke(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision?: number },
    correlationId: string | null,
  ): Promise<Invitation> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked against a concurrent accept (a revoked invitation never grants anything).
      const invitation = await this.load(trx, organizationId, id, { lock: true });
      if (!invitation) throw errors.protectedNotFound('invitation');
      await this.authorization.require(principal, IdentityActions.revokeInvitation, {
        type: 'invitation',
        id,
        organizationId,
        subjectPersonIds: invitation.invited_by_person_id ? [invitation.invited_by_person_id] : [],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, invitation.revision);
      const next = InvitationMachine.next(invitation.status, 'revoke');
      const now = this.clock.now();
      const revoked = await trx
        .updateTable('invitations')
        .set({
          status: next,
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
          revision: invitation.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', invitation.revision)
        .executeTakeFirst();
      ensureUpdated(revoked.numUpdatedRows, () =>
        errors.staleRevision(invitation.revision, invitation.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.revokeInvitation.id,
        targetType: 'invitation',
        targetId: id,
        beforeRevision: invitation.revision,
        afterRevision: invitation.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, IdentityEvents.invitationRevoked, {
        organizationId,
        aggregateType: 'invitation',
        aggregateId: id,
        payload: { invitationId: id, reason: input.reason },
        correlationId,
      });
      const updated = await this.load(trx, organizationId, id);
      return toInvitation(updated as Selectable<InvitationsTable>);
    });
  }

  /**
   * POST /v1/invitations/{id}/decline (ID-03, SPK-IAM-004): the recipient declines with the same
   * proof acceptance needs (the token, and being the recipient person or holding the verified
   * contact point it was sent to). The row is locked against a concurrent accept or revoke; an
   * invitation past its expiry is recorded as expired first and the decline answers
   * INVALID_TRANSITION. A declined invitation can never be accepted (InvitationMachine).
   */
  async decline(
    principal: Principal,
    id: string,
    input: DeclineInvitationInput,
    correlationId: string | null,
  ): Promise<Invitation> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const outcome = await runInTransaction(this.uow, async ({ trx }) => {
      const invitation = await this.load(trx, organizationId, id, { lock: true });
      if (!invitation || invitation.token_hash !== hashToken(input.token)) {
        throw errors.protectedNotFound('invitation');
      }
      const me = principal.personId;
      if (!me) {
        throw errors.accessDenied('Link your account to a person before declining invitations.');
      }
      if (invitation.recipient_person_id) {
        await this.authorization.require(principal, IdentityActions.declineInvitation, {
          type: 'invitation',
          id,
          organizationId,
          subjectPersonIds: [invitation.recipient_person_id],
          protected: true,
        });
      } else {
        await this.assertVerifiedContact(
          trx,
          organizationId,
          me,
          invitation.recipient_contact_kind as 'email' | 'phone',
          invitation.recipient_contact_value as string,
        );
        await this.authorization.require(principal, IdentityActions.declineInvitation, {
          type: 'invitation',
          id,
          organizationId,
          subjectPersonIds: [me],
          protected: true,
        });
      }
      const now = this.clock.now();
      if (
        effectiveInvitationStatus(invitation, now) === 'expired' &&
        invitation.status === 'pending'
      ) {
        await this.expire(trx, principal, invitation, correlationId, 'acceptance_attempt');
        return { expired: true as const };
      }
      const next = InvitationMachine.next(invitation.status, 'decline');
      const declined = await trx
        .updateTable('invitations')
        .set({
          status: next,
          declined_at: now,
          declined_by_person_id: me,
          decline_reason: input.reason ?? null,
          revision: invitation.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', invitation.revision)
        .executeTakeFirst();
      ensureUpdated(declined.numUpdatedRows, () =>
        errors.staleRevision(invitation.revision, invitation.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.declineInvitation.id,
        targetType: 'invitation',
        targetId: id,
        beforeRevision: invitation.revision,
        afterRevision: invitation.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, IdentityEvents.invitationDeclined, {
        organizationId,
        aggregateType: 'invitation',
        aggregateId: id,
        payload: { invitationId: id, declinedByPersonId: me },
        correlationId,
      });
      const updated = await this.load(trx, organizationId, id);
      return { expired: false as const, invitation: toInvitation(updated as InvitationRow) };
    });
    if (outcome.expired) throw errors.invalidTransition('Invitation', 'expired', 'decline');
    return outcome.invitation;
  }

  /**
   * GET /v1/me/invitations (ID-03, SPK-IAM-004): `received` lists invitations addressed to me or
   * to one of my verified contact points; `sent` the ones I issued. Keyset (created_at desc, id
   * desc); `status` filters on the effective status. The token is never returned.
   */
  async listMine(
    principal: Principal,
    query: ListMyInvitationsQueryInput,
  ): Promise<Page<InvitationView>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const me = principal.personId;
    if (!me) return { items: [], nextCursor: null };
    let base = this.db
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if ((query.direction ?? 'received') === 'sent') {
      base = base.where('invited_by_person_id', '=', me);
    } else {
      const contacts = await this.verifiedContacts(this.db, organizationId, me);
      base = base.where((eb) =>
        eb.or([
          eb('recipient_person_id', '=', me),
          ...contacts.map((c) =>
            eb.and([
              eb('recipient_contact_kind', '=', c.kind),
              eb('recipient_contact_value', '=', c.value),
            ]),
          ),
        ]),
      );
    }
    return this.page(organizationId, base, query.status, query.cursor, query.limit);
  }

  /**
   * GET /v1/me/invitations/{id} (ID-03, SPK-IAM-004): the recipient (the person, or the holder of
   * the verified contact point it was sent to) or the inviter reads the sender, the people covered,
   * the permissions requested and the expiry before accepting; anyone else gets a protected
   * NOT_FOUND (§4.10).
   */
  async getMine(principal: Principal, id: string): Promise<InvitationView> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const me = principal.personId;
    const row = await this.db
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || !me) throw errors.protectedNotFound('invitation');
    let related = row.recipient_person_id === me || row.invited_by_person_id === me;
    if (!related && row.recipient_contact_kind && row.recipient_contact_value) {
      const contacts = await this.verifiedContacts(this.db, organizationId, me);
      related = contacts.some(
        (c) => c.kind === row.recipient_contact_kind && c.value === row.recipient_contact_value,
      );
    }
    if (!related) throw errors.protectedNotFound('invitation');
    await this.authorization.require(principal, IdentityActions.acceptInvitation, {
      type: 'invitation',
      id,
      organizationId,
      subjectPersonIds: [me],
      protected: true,
    });
    const [view] = await this.views(this.db, organizationId, [row]);
    return view as InvitationView;
  }

  /**
   * GET /v1/invitations (ID-03): staff list, optionally of the invitations covering one person
   * (fixed at issue), with identity.read_invitations. Keyset (created_at desc, id desc).
   */
  async listForStaff(
    principal: Principal,
    query: ListInvitationsQueryInput,
  ): Promise<Page<InvitationView>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readInvitations, {
      type: 'invitation',
      organizationId,
    });
    let base = this.db
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (query.scopePersonId) {
      const personId = query.scopePersonId;
      base = base.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('invitation_subjects as s')
            .select('s.invitation_id')
            .whereRef('s.organization_id', '=', 'invitations.organization_id')
            .whereRef('s.invitation_id', '=', 'invitations.id')
            .where('s.person_id', '=', personId),
        ),
      );
    }
    return this.page(organizationId, base, query.status, query.cursor, query.limit);
  }

  /**
   * ID-04: invitations still pending (and not past expiry) that concern the person: covering
   * them, addressed to them, or issued by them. For staff with identity.read_authority.
   */
  async pendingConcerning(
    db: Db | Trx,
    organizationId: string,
    personId: string,
  ): Promise<InvitationView[]> {
    const now = this.clock.now();
    const rows = await db
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .where((eb) =>
        eb.or([
          eb('recipient_person_id', '=', personId),
          eb('invited_by_person_id', '=', personId),
          eb.exists(
            eb
              .selectFrom('invitation_subjects as s')
              .select('s.invitation_id')
              .whereRef('s.organization_id', '=', 'invitations.organization_id')
              .whereRef('s.invitation_id', '=', 'invitations.id')
              .where('s.person_id', '=', personId),
          ),
        ]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(100)
      .execute();
    return this.views(db, organizationId, rows);
  }

  // -------------------------------------------------------------------------------------------
  private async page(
    organizationId: string,
    base: SelectQueryBuilder<Database, 'invitations', InvitationRow>,
    status: InvitationStatus | undefined,
    cursorValue: string | undefined,
    limit: number,
  ): Promise<Page<InvitationView>> {
    const now = this.clock.now();
    let query = base;
    if (status === 'pending') {
      query = query.where('status', '=', 'pending').where('expires_at', '>', now);
    } else if (status === 'expired') {
      query = query.where((eb) =>
        eb.or([
          eb('status', '=', 'expired'),
          eb.and([eb('status', '=', 'pending'), eb('expires_at', '<=', now)]),
        ]),
      );
    } else if (status) {
      query = query.where('status', '=', status);
    }
    const cursor = decodeCursor(cursorValue, ListCursor);
    if (cursor) {
      query = query.where(
        sql<SqlBool>`(invitations.created_at, invitations.id) < (${new Date(cursor.c)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: await this.views(this.db, organizationId, pageRows),
      nextCursor:
        rows.length > limit && last ? encodeCursor({ c: iso(last.created_at), id: last.id }) : null,
    };
  }

  /** InvitationView: the invitation plus the inviter's and the covered people's names (ID-03). */
  private async views(
    db: Db | Trx,
    organizationId: string,
    rows: InvitationRow[],
  ): Promise<InvitationView[]> {
    if (rows.length === 0) return [];
    const subjects = await db
      .selectFrom('invitation_subjects')
      .select(['invitation_id', 'person_id'])
      .where('organization_id', '=', organizationId)
      .where(
        'invitation_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('person_id')
      .execute();
    const names = await displayNamesOf(db, organizationId, [
      ...subjects.map((s) => s.person_id),
      ...rows.flatMap((r) => (r.invited_by_person_id ? [r.invited_by_person_id] : [])),
    ]);
    const now = this.clock.now();
    return rows.map((row) => ({
      ...toInvitation(row),
      inviter: row.invited_by_person_id
        ? {
            personId: row.invited_by_person_id,
            displayName: names.get(row.invited_by_person_id) ?? '',
          }
        : null,
      subjects: subjects
        .filter((s) => s.invitation_id === row.id)
        .map((s) => ({ personId: s.person_id, displayName: names.get(s.person_id) ?? '' })),
      effectiveStatus: effectiveInvitationStatus(row, now),
    }));
  }

  private async verifiedContacts(
    db: Db | Trx,
    organizationId: string,
    personId: string,
  ): Promise<Array<{ kind: 'email' | 'phone'; value: string }>> {
    return db
      .selectFrom('contact_points')
      .select(['kind', 'value'])
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('verified_at', 'is not', null)
      .execute();
  }

  /**
   * Records the expiry of a pending invitation (ID-07, IF-25) under the caller's row lock, with
   * the system-only action identity.expire_invitation and one identity.invitation_expired event:
   * whichever path holds the lock first (the sweep or a lazy check on accept/decline) records it.
   */
  async expire(
    trx: Trx,
    principal: Principal,
    invitation: InvitationRow,
    correlationId: string | null,
    via: ExpiryPath,
  ): Promise<void> {
    const next = InvitationMachine.next(invitation.status, 'expire');
    const expired = await trx
      .updateTable('invitations')
      .set({ status: next, revision: invitation.revision + 1 })
      .where('organization_id', '=', invitation.organization_id)
      .where('id', '=', invitation.id)
      .where('revision', '=', invitation.revision)
      .executeTakeFirst();
    ensureUpdated(expired.numUpdatedRows, () =>
      errors.staleRevision(invitation.revision, invitation.revision + 1),
    );
    await this.audit.record(trx, {
      organizationId: invitation.organization_id,
      actor: principal,
      action: IdentityActions.expireInvitation.id,
      targetType: 'invitation',
      targetId: invitation.id,
      beforeRevision: invitation.revision,
      afterRevision: invitation.revision + 1,
      correlationId,
      details: { outcome: 'expired', via, expiresAt: iso(invitation.expires_at) },
    });
    await this.outbox.enqueue(trx, IdentityEvents.invitationExpired, {
      organizationId: invitation.organization_id,
      aggregateType: 'invitation',
      aggregateId: invitation.id,
      payload: { invitationId: invitation.id, via },
      correlationId,
    });
  }

  /**
   * The people an invitation scope covers now: one person, or the child members of a household.
   * `memberPersonId` is set for a customer: an empty household then reads as not-found unless the
   * customer belongs to it (§4.10).
   */
  private async scopeSubjects(
    trx: Trx,
    organizationId: string,
    scope: InvitationScope,
    memberPersonId?: string,
  ): Promise<string[]> {
    if (scope.type === 'person') {
      const person = await this.loadPerson(trx, organizationId, scope.personId);
      if (!person || person.status !== 'active') throw errors.protectedNotFound('person');
      return [person.id];
    }
    const household = await trx
      .selectFrom('households')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', scope.householdId)
      .executeTakeFirst();
    if (!household) throw errors.protectedNotFound('household');
    const members = await this.householdChildMembers(trx, organizationId, scope.householdId);
    if (members.length === 0) {
      if (memberPersonId !== undefined) {
        const member = await trx
          .selectFrom('household_memberships')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('household_id', '=', scope.householdId)
          .where('person_id', '=', memberPersonId)
          .executeTakeFirst();
        if (!member) throw errors.protectedNotFound('household');
      }
      throw errors.validation('The household has no child members to hold authority over.');
    }
    return members;
  }

  private async householdChildMembers(
    trx: Trx,
    organizationId: string,
    householdId: string,
  ): Promise<string[]> {
    const members = await trx
      .selectFrom('household_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'household_memberships.organization_id')
          .onRef('persons.id', '=', 'household_memberships.person_id'),
      )
      .select('persons.id')
      .where('household_memberships.organization_id', '=', organizationId)
      .where('household_memberships.household_id', '=', householdId)
      .where('persons.kind', '=', 'child')
      .where('persons.status', '=', 'active')
      .orderBy('persons.id')
      .execute();
    return members.map((m) => m.id);
  }

  /**
   * SPK-IAM-004, §4.5: the subjects fixed at issue that are still in scope at acceptance (still
   * active; for a household scope, still a child member). A child added to the household after
   * issue is never included; the ones that left are reported as dropped.
   */
  private async acceptanceSubjects(
    trx: Trx,
    organizationId: string,
    invitation: Selectable<InvitationsTable>,
  ): Promise<{ subjects: string[]; droppedSubjects: string[] }> {
    const snapshot = (
      await trx
        .selectFrom('invitation_subjects')
        .select('person_id')
        .where('organization_id', '=', organizationId)
        .where('invitation_id', '=', invitation.id)
        .orderBy('person_id')
        .execute()
    ).map((r) => r.person_id);
    let inScope: Set<string>;
    if (invitation.scope_type === 'household') {
      inScope = new Set(
        await this.householdChildMembers(
          trx,
          organizationId,
          invitation.scope_household_id as string,
        ),
      );
    } else {
      const active =
        snapshot.length === 0
          ? []
          : await trx
              .selectFrom('persons')
              .select('id')
              .where('organization_id', '=', organizationId)
              .where('id', 'in', snapshot)
              .where('status', '=', 'active')
              .execute();
      inScope = new Set(active.map((p) => p.id));
    }
    return {
      subjects: snapshot.filter((p) => inScope.has(p)),
      droppedSubjects: snapshot.filter((p) => !inScope.has(p)),
    };
  }

  /**
   * Whether the inviter is still authorized at acceptance (SPK-IAM-004). A staff-role invitation
   * needs the inviter to still hold a staff role covering invitations at the clock, exactly as a
   * customer inviter must still hold each permission ('delegated': checked per permission by the
   * caller). The system is always authorized.
   */
  private async inviterAuthority(
    trx: Trx,
    organizationId: string,
    invitation: Selectable<InvitationsTable>,
  ): Promise<'authorized' | 'delegated' | 'lapsed'> {
    const by = invitation.invited_by as {
      kind?: string;
      basis?: InvitationBasis;
      accountId?: string | null;
    };
    // Rows written before `basis` existed: a non-customer inviter could only pass the staff-role
    // check, so it means 'staff_role'.
    const basis: InvitationBasis =
      by.basis ?? (by.kind === 'customer' ? 'delegated' : 'staff_role');
    if (basis === 'delegated') return 'delegated';
    if (by.kind === 'system') return 'authorized';
    const inviterId = invitation.invited_by_person_id;
    if (!inviterId) return 'lapsed';
    const now = this.clock.now();
    const person = await trx
      .selectFrom('persons')
      .select('status')
      .where('organization_id', '=', organizationId)
      .where('id', '=', inviterId)
      .executeTakeFirst();
    if (!person || person.status !== 'active') return 'lapsed';
    const memberships = await trx
      .selectFrom('staff_memberships')
      .select(['roles', 'facility_ids'])
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', inviterId)
      .where('status', '=', 'active')
      .where('effective_from', '<=', now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .execute();
    const inviterPrincipal = buildPrincipal(
      { id: by.accountId ?? inviterId, organizationId, personId: inviterId },
      memberships.map((m) => ({ roles: m.roles, facilityIds: m.facility_ids })),
      null,
    );
    const still = await staffAuthorityApplies(
      this.authorization,
      inviterPrincipal,
      IdentityActions.createInvitation,
      organizationId,
    );
    return still ? 'authorized' : 'lapsed';
  }

  private async assertVerifiedContact(
    trx: Trx,
    organizationId: string,
    personId: string,
    kind: 'email' | 'phone',
    value: string,
  ): Promise<void> {
    const match = await trx
      .selectFrom('contact_points')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('kind', '=', kind)
      .where('value', '=', value)
      .where('verified_at', 'is not', null)
      .executeTakeFirst();
    if (!match) {
      throw errors.accessDenied(
        'This invitation was sent to a contact point your account has not verified.',
      );
    }
  }

  private async load(
    trx: Trx,
    organizationId: string,
    id: string,
    options: { lock?: boolean } = {},
  ) {
    let query = trx
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.lock) query = query.forUpdate();
    return query.executeTakeFirst();
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
