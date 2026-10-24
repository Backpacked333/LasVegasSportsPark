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
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import {
  isSuspendedAt,
  personColumns,
  staffAuthorityApplies,
  toAccessGrant,
  toRelationship,
  type PersonRow,
} from '../identity.shared';
import { RelationshipAuthority } from './relationship-authority.service';

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

const SELF_SERVICE_ONLY =
  'Self-service relationships are limited to guardianship of a child you created.';

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
    private readonly authority: RelationshipAuthority,
  ) {}

  async createRelationship(
    principal: Principal,
    input: CreateRelationshipInput,
    correlationId: string | null,
  ): Promise<{ relationship: Relationship; grants: AccessGrant[] }> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      let source: AuthoritySource;
      let actor: PersonRow | null;
      let subject: PersonRow | null;
      if (
        await staffAuthorityApplies(
          this.authorization,
          principal,
          IdentityActions.createRelationship,
          organizationId,
        )
      ) {
        actor = await this.loadPerson(trx, organizationId, input.actorPersonId);
        subject = await this.loadPerson(trx, organizationId, input.subjectPersonId);
        if (!subject) throw errors.protectedNotFound('person');
        if (!actor) throw errors.notFound('person', input.actorPersonId);
        source = 'staff';
      } else {
        // Self-service: only an adult over a child record they created themselves (SPK-IAM-001;
        // guardian verification policy pending §6.6). Anything else needs staff or an invitation.
        // Any person may take this path, including a staff member whose roles do not cover the
        // command (SPK-IAM acceptance example 3). §4.10, §4.7 invariant 1: the checks run in an
        // order that never tells a caller anything about another household's record: first what
        // depends on the input alone, then existence, then provenance, which reads as not-found
        // unless the caller may already read the record.
        if (!principal.personId || input.actorPersonId !== principal.personId) {
          throw errors.participantAuthorityRequired(SELF_SERVICE_ONLY);
        }
        await this.authorization.require(principal, IdentityActions.createRelationshipSelfService, {
          type: 'relationship',
          organizationId,
          subjectPersonIds: [principal.personId],
        });
        subject = await this.loadPerson(trx, organizationId, input.subjectPersonId);
        if (!subject) throw errors.protectedNotFound('person');
        if (subject.created_by_person_id !== principal.personId) {
          const readable = await this.authorization.decide(principal, IdentityActions.readPerson, {
            type: 'person',
            id: subject.id,
            organizationId,
            subjectPersonIds: [subject.id],
            protected: true,
          });
          if (!readable.allowed) throw errors.protectedNotFound('person');
          throw errors.participantAuthorityRequired(SELF_SERVICE_ONLY);
        }
        if (subject.kind !== 'child' || input.kind !== 'guardian') {
          throw errors.participantAuthorityRequired(SELF_SERVICE_ONLY);
        }
        actor = await this.loadPerson(trx, organizationId, principal.personId);
        if (!actor) throw errors.protectedNotFound('person');
        source = 'self_service';
      }
      if (actor.status !== 'active' || subject.status !== 'active') {
        throw errors.invalidTransition('Person', 'inactive', 'relate');
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
      let source: AuthoritySource;
      if (
        await staffAuthorityApplies(
          this.authorization,
          principal,
          IdentityActions.grantAccess,
          organizationId,
        )
      ) {
        source = 'staff';
      } else {
        // Self-service by the person themselves (customer, or staff whose roles do not cover
        // grants, SPK-IAM acceptance example 3): only on their own self-service relationship over
        // a child they created, and never to undo a restriction or a staff revocation.
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
        await this.assertSelfServiceGrantAllowed(
          trx,
          organizationId,
          relationship,
          input.permission,
        );
        source = 'self_service';
      }
      if (relationship.status === 'ended') {
        throw errors.invalidTransition('Relationship', 'ended', 'grant');
      }
      const window = this.grantWindow(relationship, input);
      const grant = await this.insertGrant(trx, principal, organizationId, relationship, {
        permission: input.permission,
        source,
        effectiveFrom: window.effectiveFrom,
        effectiveTo: window.effectiveTo,
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
      // §4.9: locked, so a concurrent revoke waits and then sees this one's outcome.
      const grant = await trx
        .selectFrom('access_grants')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!grant) throw errors.protectedNotFound('access_grant');
      const creatorGuardian = await this.mayRevokeAsCreatorGuardian(
        trx,
        principal,
        organizationId,
        grant,
      );
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
      const updated = await trx
        .updateTable('access_grants')
        .set({
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
          revision: grant.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', grant.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(grant.revision, grant.revision + 1),
      );
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
      const row = await trx
        .selectFrom('access_grants')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toAccessGrant(row, relationship.status, now);
    });
  }

  /**
   * The documented creator-guardian rule, bounded (SPK-IAM-003/005/006, §4.7 invariant 1): the
   * adult who created a self-service child record may remove a delegate or caregiver they invited
   * themselves, and only while they still hold effective authority over the child. Provenance
   * never outranks current authority: a restricted or revoked creator, another guardian's grant,
   * and staff, claim, review or import grants all take the normal decision (staff, or the grant
   * holder giving up their own access). A contested guardianship goes to an access review. Whether
   * a grantor needs an explicit delegation permission is a pending decision (role matrix item 4).
   */
  private async mayRevokeAsCreatorGuardian(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    grant: Selectable<AccessGrantsTable>,
  ): Promise<boolean> {
    const creatorId = principal.kind === 'system' ? null : principal.personId;
    if (!creatorId || creatorId === grant.actor_person_id) return false;
    const subject = await this.loadPerson(trx, organizationId, grant.subject_person_id);
    if (!subject || subject.created_by_person_id !== creatorId) return false;
    const relationship = await trx
      .selectFrom('relationships')
      .select(['kind', 'source'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', grant.relationship_id)
      .executeTakeFirst();
    if (!relationship || relationship.source !== 'invitation') return false;
    const kind = relationship.kind;
    if (kind === 'guardian' || kind === 'self_managed') return false;
    const inGoodStanding = await this.authority.hasPermission(
      organizationId,
      creatorId,
      subject.id,
      'view',
      trx,
    );
    if (!inGoodStanding) return false;
    const invited = await trx
      .selectFrom('invitations')
      .select('invitations.id')
      .where('invitations.organization_id', '=', organizationId)
      .where('invitations.status', '=', 'accepted')
      .where('invitations.invited_by_person_id', '=', creatorId)
      .where('invitations.accepted_by_person_id', '=', grant.actor_person_id)
      .where('invitations.relationship_kind', '=', kind)
      .where((eb) =>
        eb.or([
          eb('invitations.scope_person_id', '=', subject.id),
          eb.exists(
            eb
              .selectFrom('invitation_subjects')
              .select('invitation_subjects.person_id')
              .whereRef('invitation_subjects.organization_id', '=', 'invitations.organization_id')
              .whereRef('invitation_subjects.invitation_id', '=', 'invitations.id')
              .where('invitation_subjects.person_id', '=', subject.id),
          ),
        ]),
      )
      .executeTakeFirst();
    return invited !== undefined;
  }

  /**
   * SPK-IAM-005/006: a creator's self-service additions never undo a restriction or a staff
   * decision. Refused while (a) this actor holds a grant over the subject under a suspension in
   * force (revoking a suspended grant keeps the suspension on the row, so revoke-then-regrant does
   * not clear it), (b) any access review over the subject is not closed (self-service changes
   * freeze during a dispute), or (c) this permission was revoked by anyone other than the holder
   * (staff, the system, a merge). A holder who gave up a permission themselves may take it back.
   * Staff restore access deliberately through the staff grant path.
   */
  private async assertSelfServiceGrantAllowed(
    trx: Trx,
    organizationId: string,
    relationship: Selectable<RelationshipsTable>,
    permission: GrantPermissionValue,
  ): Promise<void> {
    const now = this.clock.now();
    const actorId = relationship.actor_person_id;
    const history = await trx
      .selectFrom('access_grants')
      .select(['permission', 'suspended_at', 'suspended_until', 'revoked_at', 'revoked_by'])
      .where('organization_id', '=', organizationId)
      .where('actor_person_id', '=', actorId)
      .where('subject_person_id', '=', relationship.subject_person_id)
      .execute();
    const restricted = history.some((g) => isSuspendedAt(g, now));
    const revokedByOthers = history.some(
      (g) =>
        g.permission === permission &&
        g.revoked_at !== null &&
        (g.revoked_by as { personId?: string | null } | null)?.personId !== actorId,
    );
    const openReview = await trx
      .selectFrom('access_reviews')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', relationship.subject_person_id)
      .where('status', '<>', 'closed')
      .executeTakeFirst();
    if (restricted || revokedByOthers || openReview) {
      throw errors.participantAuthorityRequired(
        'Access over this person is restricted or was revoked by staff; ask support to change it.',
      );
    }
  }

  /**
   * SPK-IAM-003/006: a grant lies inside its relationship's effective dates. Omitted bounds take
   * the relationship's (starting no earlier than now); explicit bounds outside them are refused.
   */
  private grantWindow(
    relationship: Selectable<RelationshipsTable>,
    input: { effectiveFrom?: string; effectiveTo?: string },
  ): { effectiveFrom: Date; effectiveTo: Date | null } {
    const now = this.clock.now().getTime();
    const relFrom = new Date(relationship.effective_from).getTime();
    const relTo =
      relationship.effective_to === null ? null : new Date(relationship.effective_to).getTime();
    const from = input.effectiveFrom
      ? new Date(input.effectiveFrom).getTime()
      : Math.max(now, relFrom);
    const to = input.effectiveTo ? new Date(input.effectiveTo).getTime() : relTo;
    if (from < relFrom || (relTo !== null && (to === null || to > relTo))) {
      throw errors.validation("A grant cannot extend outside its relationship's effective dates.", {
        relationshipEffectiveFrom: new Date(relFrom).toISOString(),
        relationshipEffectiveTo: relTo === null ? null : new Date(relTo).toISOString(),
      });
    }
    if (to !== null && to <= from) {
      if (relTo !== null && relTo <= now) {
        throw errors.invalidTransition('Relationship', 'expired', 'grant');
      }
      throw errors.validation('effectiveTo must be after effectiveFrom.');
    }
    return { effectiveFrom: new Date(from), effectiveTo: to === null ? null : new Date(to) };
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
    // SPK-IAM-003/006: never wider than the relationship's own dates (an invitation or claim that
    // reuses a time-bounded relationship adds grants that end with it).
    const relFrom = new Date(relationship.effective_from).getTime();
    const relTo =
      relationship.effective_to === null ? null : new Date(relationship.effective_to).getTime();
    const fromMs = Math.max(input.effectiveFrom.getTime(), relFrom);
    const toMs =
      relTo === null
        ? (input.effectiveTo?.getTime() ?? null)
        : Math.min(input.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY, relTo);
    if (toMs !== null && toMs <= fromMs) {
      if (relTo !== null && relTo <= this.clock.now().getTime()) {
        throw errors.invalidTransition('Relationship', 'expired', 'grant');
      }
      throw errors.validation(
        "The grant's dates do not overlap its relationship's effective dates.",
      );
    }
    input = {
      ...input,
      effectiveFrom: new Date(fromMs),
      effectiveTo: toMs === null ? null : new Date(toMs),
    };
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
