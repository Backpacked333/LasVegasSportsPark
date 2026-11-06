import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AcceptStaffInvitationInput,
  type CreateStaffInvitationInput,
  type ListStaffAccessReviewsQueryInput,
  type ListStaffInvitationsQueryInput,
  type Page,
  type Principal,
  type RecordStaffAccessReviewInput,
  type RevokeStaffInvitationInput,
  type StaffAccessReview,
  type StaffAccessSummary,
  type StaffInvitation,
  type StaffInvitationAccepted,
  type StaffInvitationIssued,
  type StaffRole,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type Db,
  type StaffAccessReviewsTable,
  type StaffInvitationsTable,
  type StaffInvitationStatus,
} from '@sportspark/db';
import { sql, type Selectable, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  KeysetInstant,
  Outbox,
  UnitOfWork,
  afterKeyset,
  assertExpectedRevision,
  ensureUpdated,
  exactInstantOf,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { IdentityEvents } from '../identity.events';
import { StaffInvitationMachine } from '../identity.machines';
import {
  assignmentScopeCovers,
  displayNamesOf,
  hashToken,
  hoursFromNow,
  newToken,
  normalizeContactValue,
  requireStaffAssignmentScope,
} from '../identity.shared';
import { StaffMembershipsService } from './staff-memberships.service';

type InvitationRow = Selectable<StaffInvitationsTable>;
type ReviewRow = Selectable<StaffAccessReviewsTable>;

const ListCursor = z.object({ c: KeysetInstant, id: z.uuid() });
const iso = (v: Date | string): string => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v ? iso(v) : null);

/** A pending invitation past its expiry reads as expired before any write (as ID-03 does). */
export function effectiveStaffInvitationStatus(
  row: Pick<InvitationRow, 'status' | 'expires_at'>,
  now: Date,
): StaffInvitationStatus {
  return row.status === 'pending' && new Date(row.expires_at).getTime() <= now.getTime()
    ? 'expired'
    : row.status;
}

function toReview(row: ReviewRow): StaffAccessReview {
  return {
    id: row.id,
    personId: row.person_id,
    outcome: row.outcome,
    notes: row.notes,
    rolesReviewed: row.roles_reviewed as StaffRole[],
    reviewedByPersonId: row.reviewed_by_person_id,
    reviewedAt: iso(row.reviewed_at),
    nextReviewDueAt: iso(row.next_review_due_at),
  };
}

/**
 * Staff access reviews and staff invitations (migration 0181; §2.1 the system administrator owns
 * accounts and permissions, §4.14 least privilege and audited privileged actions, SPK-IAM-004).
 *
 * Reviews: a system administrator, never the person reviewed (the database refuses a self review),
 * records that another staff member's roles in effect were reviewed, with the outcome and the date
 * the next review is due. The review interval is not an operator policy, so the reviewer sets the
 * next date every time; nothing defaults it. Reviews are append-only.
 *
 * Invitations: an administrator invites an email address to take roles at a facility scope it
 * administers (the same R3-SECURITY-01 rule as assigning roles directly). The token is returned
 * once. Acceptance needs that token and the email as a verified contact point of the accepting
 * adult, and creates exactly one staff membership; the inviter must still administer the scope at
 * that moment, so a revoked administrator's invitations grant nothing. No messaging channel is
 * selected (DEC-012, DEC-062): issuing records `identity.staff_invitation_created` for delivery,
 * without the address or the token.
 */
@Injectable()
export class StaffAccessService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly memberships: StaffMembershipsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Access reviews
  // -------------------------------------------------------------------------------------------

  async recordReview(
    principal: Principal,
    input: RecordStaffAccessReviewInput,
    correlationId: string | null,
  ): Promise<StaffAccessReview> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.recordStaffAccessReview, {
      type: 'staff_access_review',
      organizationId,
    });
    if (!principal.personId) {
      throw errors.accessDenied('A review is recorded by a person; link your account first.');
    }
    if (principal.personId === input.personId) {
      throw errors.accessDenied('Nobody reviews their own access; another administrator does.', {
        action: IdentityActions.recordStaffAccessReview.id,
      });
    }
    const reviewerPersonId = principal.personId;
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const inEffect = await trx
        .selectFrom('staff_memberships')
        .select(['roles', 'facility_ids'])
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', input.personId)
        .where('status', '=', 'active')
        .where('effective_from', '<=', now)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
        .execute();
      if (inEffect.length === 0) {
        throw errors.validation('This person holds no staff role in effect to review.', {
          path: 'personId',
        });
      }
      // §2.1, §4.3 (R3-SECURITY-01): only an administrator of every facility the roles cover.
      requireStaffAssignmentScope(
        principal,
        inEffect.map((m) => m.facility_ids),
      );
      const due = new Date(input.nextReviewDueAt);
      if (due.getTime() <= now.getTime()) {
        throw errors.validation('The next review date must be in the future.', {
          path: 'nextReviewDueAt',
        });
      }
      const roles = [...new Set(inEffect.flatMap((m) => m.roles))].sort();
      const id = newId();
      await trx
        .insertInto('staff_access_reviews')
        .values({
          id,
          organization_id: organizationId,
          person_id: input.personId,
          outcome: input.outcome,
          notes: input.notes ?? null,
          roles_reviewed: roles,
          reviewed_by: json(snapshotActor(principal)),
          reviewed_by_person_id: reviewerPersonId,
          reviewed_at: now,
          next_review_due_at: due,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.recordStaffAccessReview.id,
        targetType: 'staff_access_review',
        targetId: id,
        reason: input.reason ?? null,
        correlationId,
        details: { personId: input.personId, outcome: input.outcome, rolesReviewed: roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffAccessReviewed, {
        organizationId,
        aggregateType: 'staff_access_review',
        aggregateId: id,
        payload: {
          reviewId: id,
          personId: input.personId,
          outcome: input.outcome,
          nextReviewDueAt: due.toISOString(),
        },
        correlationId,
      });
      const row = await trx
        .selectFrom('staff_access_reviews')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toReview(row);
    });
  }

  async listReviews(
    principal: Principal,
    query: ListStaffAccessReviewsQueryInput,
  ): Promise<Page<StaffAccessReview>> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.readStaffAccessReviews, {
      type: 'staff_access_review',
      organizationId,
    });
    let rows = this.db
      .selectFrom('staff_access_reviews')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (query.personId) rows = rows.where('person_id', '=', query.personId);
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (cursor) {
      rows = rows.where(
        afterKeyset(
          'staff_access_reviews.created_at',
          'staff_access_reviews.id',
          cursor.c,
          cursor.id,
        ),
      );
    }
    const found = await rows
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toReview),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({
              c: await exactInstantOf(
                this.db,
                'staff_access_reviews',
                'created_at',
                last.id,
                last.created_at,
              ),
              id: last.id,
            })
          : null,
    };
  }

  /** GET /v1/staff-access-summary: the review status of everyone holding a staff role now. */
  async summary(principal: Principal): Promise<StaffAccessSummary> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.readStaffAccessReviews, {
      type: 'staff_access_review',
      organizationId,
    });
    const now = this.clock.now();
    const staff = await this.db
      .selectFrom('staff_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'staff_memberships.organization_id')
          .onRef('persons.id', '=', 'staff_memberships.person_id'),
      )
      .select('staff_memberships.person_id')
      .distinct()
      .where('staff_memberships.organization_id', '=', organizationId)
      .where('staff_memberships.status', '=', 'active')
      .where('staff_memberships.effective_from', '<=', now)
      .where((eb) =>
        eb.or([
          eb('staff_memberships.effective_to', 'is', null),
          eb('staff_memberships.effective_to', '>', now),
        ]),
      )
      .where('persons.status', '=', 'active')
      .execute();
    const ids = staff.map((s) => s.person_id);
    const latest = ids.length
      ? await this.db
          .selectFrom('staff_access_reviews')
          .select(['person_id', 'next_review_due_at'])
          .distinctOn('person_id')
          .where('organization_id', '=', organizationId)
          .where('person_id', 'in', ids)
          .orderBy('person_id')
          .orderBy('reviewed_at', 'desc')
          .orderBy('id', 'desc')
          .execute()
      : [];
    const dues = latest.map((l) => new Date(l.next_review_due_at).getTime());
    const upcoming = dues.filter((d) => d > now.getTime());
    const nextDue = (upcoming.length ? upcoming : dues).sort((a, b) => a - b)[0];
    return {
      asOf: now.toISOString(),
      staffInEffect: ids.length,
      neverReviewed: ids.length - latest.length,
      overdue: dues.filter((d) => d <= now.getTime()).length,
      nextReviewDueAt: nextDue !== undefined ? new Date(nextDue).toISOString() : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------------------------

  async createInvitation(
    principal: Principal,
    input: CreateStaffInvitationInput,
    correlationId: string | null,
  ): Promise<StaffInvitationIssued> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.manageStaffInvitation, {
      type: 'staff_invitation',
      organizationId,
    });
    // §2.1, §4.3 (R3-SECURITY-01): never an invitation wider than the inviter administers.
    requireStaffAssignmentScope(principal, [input.facilityIds]);
    if (!principal.personId) {
      throw errors.accessDenied('An invitation is issued by a person; link your account first.');
    }
    const inviterPersonId = principal.personId;
    const email = normalizeContactValue('email', input.email);
    const roles = [...new Set(input.roles)].sort();
    const facilityIds = [...new Set(input.facilityIds)].sort();
    try {
      return await this.uow.run(async ({ trx }) => {
        const now = this.clock.now();
        await this.assertFacilities(trx, organizationId, facilityIds);
        // A pending invitation to the address that has passed its expiry is recorded as expired, so
        // the one-pending-per-address index admits the new one (§4.6: the move goes through the
        // machine).
        const stale = await trx
          .selectFrom('staff_invitations')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('recipient_email', '=', email)
          .where('status', '=', 'pending')
          .where('expires_at', '<=', now)
          .forUpdate()
          .execute();
        for (const row of stale) await this.expire(trx, principal, row, correlationId, 'reissue');
        const id = newId();
        const token = newToken();
        const expiresAt = hoursFromNow(now, input.expiresInHours);
        await trx
          .insertInto('staff_invitations')
          .values({
            id,
            organization_id: organizationId,
            recipient_email: email,
            roles,
            facility_ids: facilityIds,
            invited_by: json(snapshotActor(principal)),
            invited_by_person_id: inviterPersonId,
            token_hash: hashToken(token),
            expires_at: expiresAt,
            accepted_at: null,
            accepted_by_person_id: null,
            staff_membership_id: null,
            revoked_at: null,
            revoked_by: null,
            revocation_reason: null,
            expired_at: null,
            // From the injected clock (CLAUDE.md): the row's check compares expires_at with
            // created_at, so both must come from the same clock, never the database's now().
            created_at: now,
            updated_at: now,
          })
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: IdentityActions.manageStaffInvitation.id,
          targetType: 'staff_invitation',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: { operation: 'create', roles, facilityIds, recipientContactKind: 'email' },
        });
        await this.outbox.enqueue(trx, IdentityEvents.staffInvitationCreated, {
          organizationId,
          aggregateType: 'staff_invitation',
          aggregateId: id,
          payload: {
            invitationId: id,
            recipientContactKind: 'email',
            roles,
            facilityIds,
            expiresAt: expiresAt.toISOString(),
          },
          correlationId,
        });
        const row = await this.load(trx, organizationId, id);
        const [view] = await this.views(trx, organizationId, [row!], now);
        return { ...view!, token };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict(
          'A pending staff invitation to this address already exists; revoke it first.',
          { code: 'staff_invitation_pending' },
        );
      }
      throw error;
    }
  }

  async listInvitations(
    principal: Principal,
    query: ListStaffInvitationsQueryInput,
  ): Promise<Page<StaffInvitation>> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.readStaffInvitations, {
      type: 'staff_invitation',
      organizationId,
    });
    const now = this.clock.now();
    let rows = this.db
      .selectFrom('staff_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId);
    // The filter applies the effective status (a pending row past expiry is expired).
    if (query.status === 'pending') {
      rows = rows.where('status', '=', 'pending').where('expires_at', '>', now);
    } else if (query.status === 'expired') {
      rows = rows.where((eb) =>
        eb.or([
          eb('status', '=', 'expired'),
          eb.and([eb('status', '=', 'pending'), eb('expires_at', '<=', now)]),
        ]),
      );
    } else if (query.status) {
      rows = rows.where('status', '=', query.status);
    }
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (cursor) {
      rows = rows.where(
        afterKeyset('staff_invitations.created_at', 'staff_invitations.id', cursor.c, cursor.id),
      );
    }
    const found = await rows
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: await this.views(this.db, organizationId, page, now),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({
              c: await exactInstantOf(
                this.db,
                'staff_invitations',
                'created_at',
                last.id,
                last.created_at,
              ),
              id: last.id,
            })
          : null,
    };
  }

  async acceptInvitation(
    principal: Principal,
    id: string,
    input: AcceptStaffInvitationInput,
    correlationId: string | null,
  ): Promise<StaffInvitationAccepted> {
    const organizationId = this.organizationOf(principal);
    const personId = principal.personId;
    const outcome = await this.uow.run(async ({ trx }) => {
      // §4.9: locked, so a concurrent accept or revoke waits and then sees this one's outcome.
      const row = await this.load(trx, organizationId, id, true);
      // A token mismatch and a missing invitation read the same (§4.10).
      if (!row || row.token_hash !== hashToken(input.token)) {
        throw errors.protectedNotFound('staff_invitation');
      }
      if (!personId) {
        throw errors.accessDenied('Link your account to a person before accepting invitations.');
      }
      await this.authorization.require(principal, IdentityActions.acceptStaffInvitation, {
        type: 'staff_invitation',
        id,
        organizationId,
        subjectPersonIds: [personId],
        protected: true,
      });
      const verified = await trx
        .selectFrom('contact_points')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('person_id', '=', personId)
        .where('kind', '=', 'email')
        .where('value', '=', row.recipient_email)
        .where('verified_at', 'is not', null)
        .executeTakeFirst();
      if (!verified) {
        throw errors.accessDenied(
          'This invitation was sent to an email address your account has not verified.',
        );
      }
      const now = this.clock.now();
      if (effectiveStaffInvitationStatus(row, now) === 'expired' && row.status === 'pending') {
        await this.expire(trx, principal, row, correlationId, 'acceptance_attempt');
        return { expired: true as const };
      }
      const next = StaffInvitationMachine.next(row.status, 'accept');
      const person = await trx
        .selectFrom('persons')
        .select(['kind', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', personId)
        .executeTakeFirst();
      if (!person || person.status !== 'active' || person.kind !== 'adult') {
        throw errors.accessDenied('Only an active adult can take staff roles.');
      }
      // SPK-IAM-004 "accepting grants only the authorized scope": the inviter must still
      // administer every facility of the invitation now.
      if (!(await this.inviterStillAdministers(trx, organizationId, row, now))) {
        throw errors.accessDenied(
          'The administrator who issued this invitation no longer administers its scope.',
          { reason: 'inviter_scope_lapsed' },
        );
      }
      const membership = await this.memberships.createFromInvitationIn(trx, principal, {
        organizationId,
        personId,
        roles: row.roles,
        facilityIds: row.facility_ids,
        invitationId: id,
        invitedBy: row.invited_by as Record<string, unknown>,
        correlationId,
      });
      const updated = await trx
        .updateTable('staff_invitations')
        .set({
          status: next,
          accepted_at: now,
          accepted_by_person_id: personId,
          staff_membership_id: membership.id,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(row.revision, row.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.acceptStaffInvitation.id,
        targetType: 'staff_invitation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId,
        details: { staffMembershipId: membership.id, roles: row.roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffInvitationAccepted, {
        organizationId,
        aggregateType: 'staff_invitation',
        aggregateId: id,
        payload: {
          invitationId: id,
          acceptedByPersonId: personId,
          staffMembershipId: membership.id,
        },
        correlationId,
      });
      const after = await this.load(trx, organizationId, id);
      const [view] = await this.views(trx, organizationId, [after!], now);
      return {
        expired: false as const,
        result: { invitation: view!, staffMembershipId: membership.id },
      };
    });
    if (outcome.expired) throw errors.invalidTransition('StaffInvitation', 'expired', 'accept');
    return outcome.result;
  }

  async revokeInvitation(
    principal: Principal,
    id: string,
    input: RevokeStaffInvitationInput,
    correlationId: string | null,
  ): Promise<StaffInvitation> {
    const organizationId = this.organizationOf(principal);
    await this.authorization.require(principal, IdentityActions.manageStaffInvitation, {
      type: 'staff_invitation',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.notFound('staff_invitation', id);
      requireStaffAssignmentScope(principal, [row.facility_ids]);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const now = this.clock.now();
      if (effectiveStaffInvitationStatus(row, now) === 'expired' && row.status === 'pending') {
        throw errors.invalidTransition('StaffInvitation', 'expired', 'revoke');
      }
      const next = StaffInvitationMachine.next(row.status, 'revoke');
      const updated = await trx
        .updateTable('staff_invitations')
        .set({
          status: next,
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revocation_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(row.revision, row.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffInvitation.id,
        targetType: 'staff_invitation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
        details: { operation: 'revoke' },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffInvitationRevoked, {
        organizationId,
        aggregateType: 'staff_invitation',
        aggregateId: id,
        payload: { invitationId: id, reason: input.reason },
        correlationId,
      });
      const after = await this.load(trx, organizationId, id);
      const [view] = await this.views(trx, organizationId, [after!], now);
      return view!;
    });
  }

  // -------------------------------------------------------------------------------------------

  private async expire(
    trx: Trx,
    principal: Principal,
    row: InvitationRow,
    correlationId: string | null,
    via: 'acceptance_attempt' | 'reissue',
  ): Promise<void> {
    const next = StaffInvitationMachine.next(row.status, 'expire');
    const now = this.clock.now();
    const updated = await trx
      .updateTable('staff_invitations')
      .set({ status: next, expired_at: now, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirst();
    ensureUpdated(updated.numUpdatedRows, () =>
      errors.staleRevision(row.revision, row.revision + 1),
    );
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action: IdentityActions.manageStaffInvitation.id,
      targetType: 'staff_invitation',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: { operation: 'expire', via },
    });
    await this.outbox.enqueue(trx, IdentityEvents.staffInvitationExpired, {
      organizationId: row.organization_id,
      aggregateType: 'staff_invitation',
      aggregateId: row.id,
      payload: { invitationId: row.id, via },
      correlationId,
    });
  }

  private async inviterStillAdministers(
    trx: Trx,
    organizationId: string,
    row: InvitationRow,
    now: Date,
  ): Promise<boolean> {
    const admin = await trx
      .selectFrom('staff_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'staff_memberships.organization_id')
          .onRef('persons.id', '=', 'staff_memberships.person_id'),
      )
      .select(['staff_memberships.facility_ids'])
      .where('staff_memberships.organization_id', '=', organizationId)
      .where('staff_memberships.person_id', '=', row.invited_by_person_id)
      .where('staff_memberships.status', '=', 'active')
      .where('persons.status', '=', 'active')
      .where('staff_memberships.effective_from', '<=', now)
      .where((eb) =>
        eb.or([
          eb('staff_memberships.effective_to', 'is', null),
          eb('staff_memberships.effective_to', '>', now),
        ]),
      )
      .where(sql<SqlBool>`'system_administrator' = any(staff_memberships.roles)`)
      .execute();
    if (admin.length === 0) return false;
    const scope = admin.some((m) => m.facility_ids.length === 0)
      ? null
      : [...new Set(admin.flatMap((m) => m.facility_ids))];
    return assignmentScopeCovers(scope, row.facility_ids);
  }

  private async views(
    db: Db | Trx,
    organizationId: string,
    rows: readonly InvitationRow[],
    now: Date,
  ): Promise<StaffInvitation[]> {
    const names = await displayNamesOf(
      db,
      organizationId,
      rows.map((r) => r.invited_by_person_id),
    );
    return rows.map((r) => ({
      id: r.id,
      recipientEmail: r.recipient_email,
      roles: r.roles as StaffRole[],
      facilityIds: [...r.facility_ids],
      status: effectiveStaffInvitationStatus(r, now),
      invitedByPersonId: r.invited_by_person_id,
      invitedByDisplayName: names.get(r.invited_by_person_id) ?? null,
      expiresAt: iso(r.expires_at),
      acceptedAt: isoOrNull(r.accepted_at),
      acceptedByPersonId: r.accepted_by_person_id,
      staffMembershipId: r.staff_membership_id,
      revokedAt: isoOrNull(r.revoked_at),
      revision: r.revision,
      createdAt: iso(r.created_at),
    }));
  }

  private async assertFacilities(trx: Trx, organizationId: string, facilityIds: string[]) {
    if (facilityIds.length === 0) return;
    const rows = await trx
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', facilityIds)
      .execute();
    if (rows.length !== facilityIds.length) {
      throw errors.validation('Every facilityId must belong to this organization.', {
        facilityIds,
      });
    }
  }

  private async load(trx: Trx, organizationId: string, id: string, lock = false) {
    let query = trx
      .selectFrom('staff_invitations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  private organizationOf(principal: Principal): string {
    if (!principal.organizationId) throw errors.authenticationRequired();
    return principal.organizationId;
  }
}
