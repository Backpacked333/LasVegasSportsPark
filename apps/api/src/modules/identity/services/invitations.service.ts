import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AccessGrant,
  type CreateInvitationInput,
  type Invitation,
  type Principal,
  type Relationship,
} from '@sportspark/contracts';
import { json, type Db, type GrantPermissionValue } from '@sportspark/db';
import type { InvitationsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { InvitationMachine } from '../identity.machines';
import {
  hashToken,
  hoursFromNow,
  newToken,
  normalizeContactValue,
  personColumns,
  toAccessGrant,
  toInvitation,
  toRelationship,
  type PersonRow,
} from '../identity.shared';
import { RelationshipAuthority } from './relationship-authority.service';
import { RelationshipsService } from './relationships.service';

export interface InvitationAccepted {
  invitation: Invitation;
  relationships: Relationship[];
  grants: AccessGrant[];
  droppedPermissions: GrantPermissionValue[];
}

/**
 * Invitations (SPK-IAM-004). The record keeps the inviting actor, recipient, scope, requested
 * permissions, expiry, acceptance and revocation. Acceptance grants only the requested
 * permissions the inviter still holds at that moment (staff may grant any); the rest are dropped
 * and reported, never silently implied.
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
    const isStaff = principal.kind === 'staff' || principal.kind === 'system';
    return runInTransaction(this.uow, async ({ trx }) => {
      const subjects = await this.scopeSubjects(trx, organizationId, input.scope);
      if (isStaff) {
        await this.authorization.require(principal, IdentityActions.createInvitation, {
          type: 'invitation',
          organizationId,
        });
      } else {
        if (!principal.personId) throw errors.protectedNotFound('person');
        await this.authorization.require(principal, IdentityActions.createInvitation, {
          type: 'invitation',
          organizationId,
          subjectPersonIds: subjects,
          protected: true,
        });
        // Delegation: a customer may only invite others into permissions they hold themselves.
        for (const subject of subjects) {
          for (const permission of input.requestedPermissions) {
            const held = await this.authority.hasPermission(
              organizationId,
              principal.personId,
              subject,
              permission,
              trx,
            );
            if (!held) {
              throw errors.participantAuthorityRequired(
                `You do not hold '${permission}' over this person and cannot delegate it.`,
              );
            }
          }
        }
      }
      let recipientPersonId: string | null = null;
      if (input.recipientPersonId) {
        const recipient = await this.loadPerson(trx, organizationId, input.recipientPersonId);
        if (!recipient || recipient.status !== 'active') {
          throw errors.notFound('person', input.recipientPersonId);
        }
        if (recipient.kind !== 'adult') {
          throw errors.validation('Only an adult can be invited to hold authority.');
        }
        if (subjects.includes(recipient.id)) {
          throw errors.validation('A person cannot be invited over themselves.');
        }
        recipientPersonId = recipient.id;
      }
      const id = newId();
      const token = newToken();
      const now = this.clock.now();
      await trx
        .insertInto('invitations')
        .values({
          id,
          organization_id: organizationId,
          invited_by: json(snapshotActor(principal)),
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
      const invitation = await this.load(trx, organizationId, id);
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
        await this.expire(trx, principal, invitation, correlationId);
        return { expired: true as const };
      }
      const next = InvitationMachine.next(invitation.status, 'accept');
      const acceptor = await this.loadPerson(trx, organizationId, principal.personId);
      if (!acceptor || acceptor.status !== 'active' || acceptor.kind !== 'adult') {
        throw errors.accessDenied(
          'Only an active adult can accept an invitation to hold authority.',
        );
      }
      const subjects = await this.scopeSubjects(
        trx,
        organizationId,
        invitation.scope_type === 'person'
          ? { type: 'person', personId: invitation.scope_person_id as string }
          : { type: 'household', householdId: invitation.scope_household_id as string },
      );
      if (subjects.includes(acceptor.id)) {
        throw errors.validation('A person cannot accept authority over themselves.');
      }

      const inviterIsStaff = (invitation.invited_by as { kind?: string }).kind !== 'customer';
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
            inviterIsStaff ||
            (inviterId !== null &&
              (await this.authority.hasPermission(
                organizationId,
                inviterId,
                subject,
                permission,
                trx,
              )));
          if (ok) authorized.push(permission);
          else dropped.add(permission);
        }
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
      await trx
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
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.acceptInvitation.id,
        targetType: 'invitation',
        targetId: id,
        beforeRevision: invitation.revision,
        afterRevision: invitation.revision + 1,
        correlationId,
        details: { granted: [...grantedUnion], dropped: [...dropped], subjects },
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
      const invitation = await this.load(trx, organizationId, id);
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
      await trx
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
        .execute();
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

  // -------------------------------------------------------------------------------------------
  private async expire(
    trx: Trx,
    principal: Principal,
    invitation: Selectable<InvitationsTable>,
    correlationId: string | null,
  ): Promise<void> {
    const next = InvitationMachine.next(invitation.status, 'expire');
    await trx
      .updateTable('invitations')
      .set({ status: next, revision: invitation.revision + 1 })
      .where('id', '=', invitation.id)
      .where('revision', '=', invitation.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: invitation.organization_id,
      actor: principal,
      action: IdentityActions.acceptInvitation.id,
      targetType: 'invitation',
      targetId: invitation.id,
      beforeRevision: invitation.revision,
      afterRevision: invitation.revision + 1,
      correlationId,
      details: { outcome: 'expired' },
    });
  }

  /** The people an invitation scope covers: one person, or the child members of a household. */
  private async scopeSubjects(
    trx: Trx,
    organizationId: string,
    scope: { type: 'person'; personId: string } | { type: 'household'; householdId: string },
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
    const members = await trx
      .selectFrom('household_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'household_memberships.organization_id')
          .onRef('persons.id', '=', 'household_memberships.person_id'),
      )
      .select('persons.id')
      .where('household_memberships.organization_id', '=', organizationId)
      .where('household_memberships.household_id', '=', scope.householdId)
      .where('persons.kind', '=', 'child')
      .where('persons.status', '=', 'active')
      .orderBy('persons.id')
      .execute();
    if (members.length === 0) {
      throw errors.validation('The household has no child members to hold authority over.');
    }
    return members.map((m) => m.id);
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

  private async load(trx: Trx, organizationId: string, id: string) {
    return trx
      .selectFrom('invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
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
