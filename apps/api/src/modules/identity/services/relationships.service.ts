import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AccessGrant,
  type CreateAccessGrantInput,
  type CreateRelationshipInput,
  type Principal,
  type Relationship,
  type RevokeAccessGrantInput,
} from '@sportspark/contracts';
import {
  isExclusionViolation,
  isUniqueViolation,
  json,
  type AuthoritySource,
  type Db,
  type GrantPermissionValue,
  type RelationshipKind,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { AccessGrantsTable, RelationshipsTable } from '@sportspark/db';
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
import { personColumns, toAccessGrant, toRelationship, type PersonRow } from '../identity.shared';

export interface EnsureAuthorityInput {
  actorPersonId: string;
  subjectPersonId: string;
  kind: RelationshipKind;
  permissions: readonly GrantPermissionValue[];
  source: AuthoritySource;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  correlationId: string | null;
}

export interface EnsureAuthorityResult {
  relationship: Selectable<RelationshipsTable>;
  relationshipCreated: boolean;
  grants: Selectable<AccessGrantsTable>[];
  createdGrantIds: string[];
}

/**
 * Relationships and access grants (SPK-IAM-001/003/006). A relationship states a capacity; each
 * permission is a separate grant row created explicitly and revoked individually. Revocation is a
 * timestamp on the row: the next authority check (same transaction or later) already denies.
 */
@Injectable()
export class RelationshipsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async createRelationship(
    principal: Principal,
    input: CreateRelationshipInput,
    correlationId: string | null,
  ): Promise<{ relationship: Relationship; grants: AccessGrant[] }> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const actor = await this.loadPerson(trx, organizationId, input.actorPersonId);
      const subject = await this.loadPerson(trx, organizationId, input.subjectPersonId);
      if (!subject) throw errors.protectedNotFound('person');
      if (!actor) throw errors.notFound('person', input.actorPersonId);
      if (actor.status !== 'active' || subject.status !== 'active') {
        throw errors.invalidTransition('Person', 'inactive', 'relate');
      }
      let source: AuthoritySource;
      if (principal.kind === 'staff' || principal.kind === 'system') {
        await this.authorization.require(principal, IdentityActions.createRelationship, {
          type: 'relationship',
          organizationId,
        });
        source = 'staff';
      } else {
        // Self-service: only an adult over a child record they created themselves (SPK-IAM-001;
        // guardian verification policy pending §6.6). Anything else needs staff or an invitation.
        if (
          !principal.personId ||
          input.actorPersonId !== principal.personId ||
          subject.kind !== 'child' ||
          subject.created_by_person_id !== principal.personId ||
          input.kind !== 'guardian'
        ) {
          throw errors.participantAuthorityRequired(
            'Self-service relationships are limited to guardianship of a child you created.',
          );
        }
        await this.authorization.require(principal, IdentityActions.createRelationshipSelfService, {
          type: 'relationship',
          organizationId,
          subjectPersonIds: [principal.personId],
        });
        source = 'self_service';
      }
      if (input.kind !== 'self_managed' && actor.kind === 'child') {
        throw errors.validation('A child cannot hold authority over another person.');
      }
      const existing = await this.findLiveRelationship(
        trx,
        organizationId,
        input.actorPersonId,
        input.subjectPersonId,
        input.kind,
      );
      if (existing) {
        throw errors.resourceConflict('This relationship already exists.', {
          relationshipId: existing.id,
        });
      }
      const result = await this.ensureAuthority(trx, principal, organizationId, {
        actorPersonId: input.actorPersonId,
        subjectPersonId: input.subjectPersonId,
        kind: input.kind,
        permissions: input.permissions,
        source,
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        correlationId,
      });
      return this.present(result);
    });
  }

  async grantAccess(
    principal: Principal,
    input: CreateAccessGrantInput,
    correlationId: string | null,
  ): Promise<AccessGrant> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const relationship = await trx
        .selectFrom('relationships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.relationshipId)
        .executeTakeFirst();
      if (!relationship) throw errors.protectedNotFound('relationship');
      if (principal.kind === 'staff' || principal.kind === 'system') {
        await this.authorization.require(principal, IdentityActions.grantAccess, {
          type: 'relationship',
          id: relationship.id,
          organizationId,
        });
      } else {
        const subject = await this.loadPerson(trx, organizationId, relationship.subject_person_id);
        if (
          !principal.personId ||
          relationship.actor_person_id !== principal.personId ||
          relationship.source !== 'self_service' ||
          subject?.created_by_person_id !== principal.personId
        ) {
          throw errors.protectedNotFound('relationship');
        }
        await this.authorization.require(principal, IdentityActions.createRelationshipSelfService, {
          type: 'relationship',
          id: relationship.id,
          organizationId,
          subjectPersonIds: [principal.personId],
          protected: true,
        });
      }
      if (relationship.status === 'ended') {
        throw errors.invalidTransition('Relationship', 'ended', 'grant');
      }
      const grant = await this.insertGrant(trx, principal, organizationId, relationship, {
        permission: input.permission,
        source: principal.kind === 'customer' ? 'self_service' : 'staff',
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : this.clock.now(),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        correlationId,
      });
      return toAccessGrant(grant.row, relationship.status, this.clock.now());
    });
  }

  /** SPK-IAM-006: revocation takes effect on the next authority check; the row is kept for audit. */
  async revokeGrant(
    principal: Principal,
    id: string,
    input: RevokeAccessGrantInput,
    correlationId: string | null,
  ): Promise<AccessGrant> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const grant = await trx
        .selectFrom('access_grants')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!grant) throw errors.protectedNotFound('access_grant');
      const subject = await this.loadPerson(trx, organizationId, grant.subject_person_id);
      const creatorGuardian =
        principal.kind === 'customer' &&
        principal.personId !== null &&
        subject?.created_by_person_id === principal.personId;
      if (!creatorGuardian) {
        // Staff by role, or the grant holder giving up their own access (allowSelf on the actor).
        await this.authorization.require(principal, IdentityActions.revokeAccess, {
          type: 'access_grant',
          id,
          organizationId,
          subjectPersonIds: [grant.actor_person_id],
          protected: true,
        });
      }
      assertExpectedRevision(input.expectedRevision, grant.revision);
      if (grant.revoked_at !== null) {
        throw errors.invalidTransition('AccessGrant', 'revoked', 'revoke');
      }
      const now = this.clock.now();
      await trx
        .updateTable('access_grants')
        .set({
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
          revision: grant.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', grant.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.revokeAccess.id,
        targetType: 'access_grant',
        targetId: id,
        beforeRevision: grant.revision,
        afterRevision: grant.revision + 1,
        reason: input.reason,
        correlationId,
        details: {
          actorPersonId: grant.actor_person_id,
          subjectPersonId: grant.subject_person_id,
          permission: grant.permission,
          basis: creatorGuardian ? 'creator_guardian' : 'authorized',
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.accessGrantRevoked, {
        organizationId,
        aggregateType: 'access_grant',
        aggregateId: id,
        payload: {
          grantId: id,
          actorPersonId: grant.actor_person_id,
          subjectPersonId: grant.subject_person_id,
          permission: grant.permission,
          reason: input.reason,
        },
        correlationId,
      });
      const relationship = await trx
        .selectFrom('relationships')
        .select('status')
        .where('id', '=', grant.relationship_id)
        .executeTakeFirstOrThrow();
      const updated = await trx
        .selectFrom('access_grants')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toAccessGrant(updated, relationship.status, now);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Shared with invitations and claims: find-or-create a relationship, then grant each permission
  // that is not already effective. Never grants anything the caller did not pass in.
  // -------------------------------------------------------------------------------------------
  async ensureAuthority(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    input: EnsureAuthorityInput,
  ): Promise<EnsureAuthorityResult> {
    if (input.kind !== 'self_managed' && input.actorPersonId === input.subjectPersonId) {
      throw errors.validation('actorPersonId and subjectPersonId must differ.');
    }
    const now = this.clock.now();
    const effectiveFrom = input.effectiveFrom ?? now;
    const effectiveTo = input.effectiveTo ?? null;
    if (effectiveTo !== null && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw errors.validation('effectiveTo must be after effectiveFrom.');
    }
    let relationship = await this.findLiveRelationship(
      trx,
      organizationId,
      input.actorPersonId,
      input.subjectPersonId,
      input.kind,
    );
    let relationshipCreated = false;
    if (!relationship) {
      const id = newId();
      try {
        await trx
          .insertInto('relationships')
          .values({
            id,
            organization_id: organizationId,
            actor_person_id: input.actorPersonId,
            subject_person_id: input.subjectPersonId,
            kind: input.kind,
            effective_from: effectiveFrom,
            effective_to: effectiveTo,
            source: input.source,
            created_by: json(snapshotActor(principal)),
            ended_at: null,
            ended_reason: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error))
          throw errors.resourceConflict('This relationship already exists.');
        throw error;
      }
      relationship = await trx
        .selectFrom('relationships')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      relationshipCreated = true;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.createRelationship.id,
        targetType: 'relationship',
        targetId: id,
        afterRevision: 1,
        correlationId: input.correlationId,
        details: {
          actorPersonId: input.actorPersonId,
          subjectPersonId: input.subjectPersonId,
          kind: input.kind,
          source: input.source,
        },
      });
      await this.outbox.enqueue(trx, IdentityEvents.relationshipCreated, {
        organizationId,
        aggregateType: 'relationship',
        aggregateId: id,
        payload: {
          relationshipId: id,
          actorPersonId: input.actorPersonId,
          subjectPersonId: input.subjectPersonId,
          kind: input.kind,
          source: input.source,
        },
        correlationId: input.correlationId,
      });
    } else if (relationship.status === 'ended') {
      throw errors.invalidTransition('Relationship', 'ended', 'grant');
    }
    const grants: Selectable<AccessGrantsTable>[] = [];
    const createdGrantIds: string[] = [];
    for (const permission of new Set(input.permissions)) {
      const grant = await this.insertGrant(trx, principal, organizationId, relationship, {
        permission,
        source: input.source,
        effectiveFrom,
        effectiveTo,
        correlationId: input.correlationId,
      });
      grants.push(grant.row);
      if (grant.created) createdGrantIds.push(grant.row.id);
    }
    return { relationship, relationshipCreated, grants, createdGrantIds };
  }

  private async insertGrant(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    relationship: Selectable<RelationshipsTable>,
    input: {
      permission: GrantPermissionValue;
      source: AuthoritySource;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      correlationId: string | null;
    },
  ): Promise<{ row: Selectable<AccessGrantsTable>; created: boolean }> {
    // Idempotent: an unrevoked grant for the same permission that overlaps the requested period
    // is returned as-is. The exclusion constraint is the final guard against duplicates.
    const existing = await trx
      .selectFrom('access_grants')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('actor_person_id', '=', relationship.actor_person_id)
      .where('subject_person_id', '=', relationship.subject_person_id)
      .where('permission', '=', input.permission)
      .where('revoked_at', 'is', null)
      .where((eb) =>
        eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', input.effectiveFrom)]),
      )
      .where((eb) =>
        input.effectiveTo === null
          ? eb.lit(true)
          : eb('effective_from', '<', input.effectiveTo as Date),
      )
      .executeTakeFirst();
    if (existing) return { row: existing, created: false };
    const id = newId();
    try {
      await trx
        .insertInto('access_grants')
        .values({
          id,
          organization_id: organizationId,
          relationship_id: relationship.id,
          actor_person_id: relationship.actor_person_id,
          subject_person_id: relationship.subject_person_id,
          permission: input.permission,
          source: input.source,
          granted_by: json(snapshotActor(principal)),
          effective_from: input.effectiveFrom,
          effective_to: input.effectiveTo,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
          suspended_at: null,
          suspended_by_review_id: null,
          suspension_reason: null,
        })
        .execute();
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw errors.resourceConflict('An overlapping grant for this permission already exists.');
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: IdentityActions.grantAccess.id,
      targetType: 'access_grant',
      targetId: id,
      afterRevision: 1,
      correlationId: input.correlationId,
      details: {
        relationshipId: relationship.id,
        actorPersonId: relationship.actor_person_id,
        subjectPersonId: relationship.subject_person_id,
        permission: input.permission,
        source: input.source,
      },
    });
    await this.outbox.enqueue(trx, IdentityEvents.accessGranted, {
      organizationId,
      aggregateType: 'access_grant',
      aggregateId: id,
      payload: {
        grantId: id,
        relationshipId: relationship.id,
        actorPersonId: relationship.actor_person_id,
        subjectPersonId: relationship.subject_person_id,
        permission: input.permission,
        source: input.source,
      },
      correlationId: input.correlationId,
    });
    const row = await trx
      .selectFrom('access_grants')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { row, created: true };
  }

  async findLiveRelationship(
    db: Db | Trx,
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    kind: RelationshipKind,
  ): Promise<Selectable<RelationshipsTable> | undefined> {
    return db
      .selectFrom('relationships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('actor_person_id', '=', actorPersonId)
      .where('subject_person_id', '=', subjectPersonId)
      .where('kind', '=', kind)
      .where('status', 'in', ['active', 'suspended'])
      .executeTakeFirst();
  }

  present(result: EnsureAuthorityResult): { relationship: Relationship; grants: AccessGrant[] } {
    const now = this.clock.now();
    return {
      relationship: toRelationship(result.relationship),
      grants: result.grants.map((g) => toAccessGrant(g, result.relationship.status, now)),
    };
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
