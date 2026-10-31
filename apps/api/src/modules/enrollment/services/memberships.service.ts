import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Basket,
  type CreateMembershipSuspensionInput,
  type EndMembershipSuspensionInput,
  type ListMembershipSuspensionsQuery,
  type ListMyMembershipsQuery,
  type Membership,
  type MembershipSuspension,
  type OfferingSession,
  type Page,
  type Principal,
  type RenewMembershipInput,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  json,
  pgErrorCode,
  type Db,
  type MembershipSuspensionsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  FacilityDirectory,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  type OfferingLookupPort,
  type OfferingSnapshot,
} from '../../catalog';
import { NotificationsService } from '../../communications';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentPackageGEvents } from '../enrollment.events';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  enrollmentSystem,
  iso,
  isoOrNull,
  isStaffLike,
  keysetPage,
  organizationOf,
  type Reader,
} from '../enrollment.shared';
import { MembershipSuspensionMachine } from '../enrollment.state-machines';
import {
  addWholeDays,
  benefitPeriodKey,
  localDayStart,
  localMidnightAfter,
  stableId,
} from '../package-g/local-dates';
import { covers, typedScope, type MembershipBenefitScope } from '../package-g/scopes';
import { BasketsService } from './baskets.service';
import { CustomerScope } from './customer-scope';
import { EnrollmentsService, type EnrollmentRow } from './enrollments.service';
import { MembershipLedger } from './membership-ledger';
import { EnrollmentFacilityScope } from './facility-scope';
import { RegistrationEvaluator } from './registration-evaluator';
import type { CreditDisposition } from './package-entitlements.service';
import type { SessionBookingRow } from './session-bookings.service';

type SuspensionRow = Selectable<MembershipSuspensionsTable>;

/** What a membership booking consumes: the benefit period, if the benefit is counted. */
export interface MembershipUse {
  membership: EnrollmentRow;
  periodKey: string | null;
  limitCount: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Memberships (ENR-12; §3.16 Memberships row, SPK-COND-001). A membership is an enrollment with
 * intent `membership`; its term is set when it is confirmed, from the definition's term
 * (`offering_dates` in the facility zone, or `from_confirmation` plus its length). Attendance is
 * strictly what the definition states: `none` books nothing, `included_sessions` books sessions of
 * the offerings it applies to within the term and outside active suspensions, counting each in its
 * period (the database check is the guarantee), and `unlimited` books without a count. A
 * membership never admits anyone by itself: entry admits through bookings and enrollments of the
 * session's own offering. Selling, renewing and booking need the `memberships` switch (DEC-016,
 * DEC-072); suspensions, cancellation, completion and reads never check it.
 */
@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly facilities: FacilityDirectory,
    private readonly exceptions: OperationalExceptions,
    private readonly notifications: NotificationsService,
    private readonly ledger: MembershipLedger,
    private readonly customers: CustomerScope,
    private readonly scope: EnrollmentFacilityScope,
    private readonly enrollments: EnrollmentsService,
    private readonly baskets: BasketsService,
    private readonly evaluator: RegistrationEvaluator,
  ) {}

  private async zoneOf(
    organizationId: string,
    facilityId: string,
    trx?: Trx,
  ): Promise<string | null> {
    return (
      (await this.facilities.describe(organizationId, [facilityId], trx)).get(facilityId)
        ?.timezone ?? null
    );
  }

  private async changed(
    trx: Trx,
    organizationId: string,
    membership: { id: string; participant_person_id: string },
    change: 'started' | 'suspended' | 'resumed' | 'canceled' | 'ended' | 'renewed',
    effectiveAt: Date,
    correlationId: string | null,
  ): Promise<void> {
    await this.outbox.enqueue(trx, EnrollmentPackageGEvents.membershipChanged, {
      organizationId,
      aggregateType: 'enrollment',
      aggregateId: membership.id,
      correlationId,
      payload: {
        enrollmentId: membership.id,
        participantPersonId: membership.participant_person_id,
        change,
        effectiveAt: effectiveAt.toISOString(),
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Term (handler `enrollment.start_membership` on enrollment.enrollment_confirmed)
  // -------------------------------------------------------------------------------------------

  /** The term a definition gives a membership confirmed at `confirmedAt`, or null if unknown. */
  termOf(
    snapshot: OfferingSnapshot,
    scope: MembershipBenefitScope,
    confirmedAt: Date,
    timezone: string,
  ): { startsAt: Date; endsAt: Date } | null {
    if (scope.term.kind === 'from_confirmation') {
      return { startsAt: confirmedAt, endsAt: addWholeDays(confirmedAt, scope.term.lengthDays) };
    }
    const startsAt = localDayStart(snapshot.offering.startsOn, timezone);
    const endsAt = localMidnightAfter(snapshot.offering.endsOn, timezone);
    return startsAt < endsAt ? { startsAt, endsAt } : null;
  }

  async startForEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.enrollments.load(trx, organizationId, enrollmentId, true);
    if (!row || row.intent !== 'membership' || row.status !== 'confirmed') return;
    if (row.membership_starts_at) return; // already started (replay)
    const confirmedAt = row.confirmed_at ? new Date(row.confirmed_at) : this.clock.now();
    const snapshot = await this.offerings.getOffering(
      organizationId,
      row.offering_id,
      confirmedAt,
      trx,
    );
    const scope = snapshot ? typedScope(snapshot, 'membership_benefit') : null;
    const zone = snapshot
      ? await this.zoneOf(organizationId, snapshot.offering.facilityId, trx)
      : null;
    const term = snapshot && scope && zone ? this.termOf(snapshot, scope, confirmedAt, zone) : null;
    if (!term) {
      // Nothing is guessed: without a readable term the membership books nothing (POL-038).
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: snapshot?.offering.facilityId ?? null,
        category: 'enrollment.membership_term_unknown',
        severity: 'high',
        title: 'A confirmed membership has no readable term',
        affectedType: 'enrollment',
        affectedId: row.id,
        ownerQueue: 'program_manager',
        dedupeKey: `membership_term_unknown:${row.id}`,
        details: { enrollmentId: row.id, offeringId: row.offering_id },
      });
      return;
    }
    await trx
      .updateTable('enrollments')
      .set({
        membership_starts_at: term.startsAt,
        membership_ends_at: term.endsAt,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: enrollmentSystem(organizationId, 'enrollment.start_membership'),
      action: 'enrollment.start_membership',
      targetType: 'enrollment',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: {
        termStartsAt: term.startsAt.toISOString(),
        termEndsAt: term.endsAt.toISOString(),
        term: scope?.term ?? null,
        renewedFromEnrollmentId: row.renewed_from_enrollment_id,
      },
    });
    await this.changed(
      trx,
      organizationId,
      row,
      row.renewed_from_enrollment_id ? 'renewed' : 'started',
      term.startsAt,
      correlationId,
    );
  }

  /** enrollment.enrollment_canceled of a membership: its change event (bookings stay). */
  async onCanceled(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.enrollments.load(trx, organizationId, enrollmentId);
    if (!row || row.intent !== 'membership') return;
    await this.changed(
      trx,
      organizationId,
      row,
      'canceled',
      row.canceled_at ? new Date(row.canceled_at) : this.clock.now(),
      correlationId,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Booking with a membership (called by SessionBookingsService.book in its unit of work)
  // -------------------------------------------------------------------------------------------

  /**
   * Locks the membership and checks it includes this session: the participant's own confirmed
   * membership, an attendance effect that includes sessions of this offering, the session's start
   * within the term and outside any active suspension.
   */
  async lockForBooking(
    trx: Trx,
    organizationId: string,
    membershipEnrollmentId: string,
    participantIds: readonly string[],
    sessionOffering: OfferingSnapshot,
    session: OfferingSession,
  ): Promise<MembershipUse> {
    const membership = await this.enrollments.load(
      trx,
      organizationId,
      membershipEnrollmentId,
      true,
    );
    if (
      !membership ||
      membership.intent !== 'membership' ||
      !participantIds.includes(membership.participant_person_id)
    ) {
      throw errors.protectedNotFound('membership');
    }
    if (membership.status !== 'confirmed' || !membership.membership_starts_at) {
      throw errors.resourceConflict('This membership is not active.', {
        code: 'MEMBERSHIP_NOT_ACTIVE',
        status: membership.status,
      });
    }
    const start = new Date(session.scheduledStart);
    const snapshot = await this.offerings.getOffering(
      organizationId,
      membership.offering_id,
      this.clock.now(),
      trx,
    );
    const scope = snapshot ? typedScope(snapshot, 'membership_benefit') : null;
    if (!scope) {
      throw errors.resourceConflict('What this membership includes cannot be read.', {
        code: 'MEMBERSHIP_BENEFIT_UNKNOWN',
      });
    }
    // SPK-COND-001: a membership never implies attendance its definition does not state.
    if (scope.attendance.mode === 'none') {
      throw errors.resourceConflict('This membership includes no sessions.', {
        code: 'MEMBERSHIP_INCLUDES_NO_SESSIONS',
      });
    }
    if (!covers(scope.attendance.appliesTo, sessionOffering.offering)) {
      throw errors.eligibility('This session is not included in the membership.', {
        reasons: [
          {
            code: 'membership_not_applicable',
            severity: 'blocking',
            message:
              'The membership includes sessions only of the offerings and programs it names.',
            source: { type: 'enrollment', id: membership.id },
            requiredAction: 'choose_included_session',
          },
        ],
      });
    }
    if (
      start < new Date(membership.membership_starts_at) ||
      start >= new Date(membership.membership_ends_at as Date)
    ) {
      throw errors.resourceConflict('The session is outside the membership term.', {
        code: 'OUTSIDE_MEMBERSHIP_TERM',
        termStartsAt: iso(membership.membership_starts_at),
        termEndsAt: isoOrNull(membership.membership_ends_at),
      });
    }
    if (await this.ledger.suspendedAt(trx, organizationId, membership.id, start)) {
      throw errors.resourceConflict('The membership is suspended at that time.', {
        code: 'MEMBERSHIP_SUSPENDED',
      });
    }
    if (scope.attendance.mode === 'unlimited') {
      return { membership, periodKey: null, limitCount: null };
    }
    const zone = await this.zoneOf(organizationId, sessionOffering.offering.facilityId, trx);
    if (!zone) throw errors.internal('facility zone unknown for a membership booking');
    return {
      membership,
      periodKey: benefitPeriodKey(scope.attendance.limit, start, zone),
      limitCount: scope.attendance.limit.count,
    };
  }

  /** Counts the booking in its benefit period; the check refuses one beyond the limit. */
  async consume(trx: Trx, organizationId: string, use: MembershipUse): Promise<void> {
    if (!use.periodKey || !use.limitCount) return;
    try {
      await trx
        .insertInto('membership_benefit_uses')
        .values({
          id: newId(),
          organization_id: organizationId,
          enrollment_id: use.membership.id,
          period_key: use.periodKey,
          used_count: 1,
          limit_count: use.limitCount,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'enrollment_id', 'period_key']).doUpdateSet((eb) => ({
            used_count: eb('membership_benefit_uses.used_count', '+', 1),
            revision: eb('membership_benefit_uses.revision', '+', 1),
          })),
        )
        .execute();
    } catch (error) {
      if (isCheckViolation(error)) {
        throw errors.resourceConflict(
          'The membership has used every session it includes for this period.',
          { code: 'MEMBERSHIP_SESSIONS_USED', periodKey: use.periodKey, limit: use.limitCount },
        );
      }
      throw error;
    }
  }

  /**
   * A canceled membership booking: before the session starts its counted use is given back
   * (`returned`); later it stays used (`retained_pending_policy`: no policy returns it). An
   * unlimited membership counts nothing.
   */
  async onBookingCanceled(
    trx: Trx,
    organizationId: string,
    booking: SessionBookingRow,
  ): Promise<CreditDisposition | null> {
    if (!booking.membership_enrollment_id || !booking.membership_period_key) return null;
    if (new Date(booking.scheduled_start).getTime() <= this.clock.now().getTime()) {
      return 'retained_pending_policy';
    }
    await trx
      .updateTable('membership_benefit_uses')
      .set((eb) => ({
        used_count: eb('used_count', '-', 1),
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', booking.membership_enrollment_id)
      .where('period_key', '=', booking.membership_period_key)
      .where('used_count', '>', 0)
      .execute();
    return 'returned';
  }

  // -------------------------------------------------------------------------------------------
  // Suspensions (staff; never gated)
  // -------------------------------------------------------------------------------------------

  private toSuspension(row: SuspensionRow): MembershipSuspension {
    return {
      id: row.id,
      enrollmentId: row.enrollment_id,
      participantPersonId: row.participant_person_id,
      from: iso(row.suspended_from),
      until: isoOrNull(row.suspended_until),
      reason: row.reason,
      status: row.status,
      endedAt: isoOrNull(row.ended_at),
      endedReason: row.ended_reason,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async suspend(
    principal: Principal,
    enrollmentId: string,
    input: CreateMembershipSuspensionInput,
    correlationId: string | null,
  ): Promise<MembershipSuspension> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const membership = await this.enrollments.load(trx, organizationId, enrollmentId, true);
      if (!membership || membership.intent !== 'membership') {
        throw errors.protectedNotFound('membership');
      }
      await this.authorization.require(principal, EnrollmentActions.manageMembershipSuspension, {
        type: 'enrollment',
        id: enrollmentId,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, membership.offering_id, trx),
        subjectPersonIds: [membership.participant_person_id],
        protected: true,
      });
      if (membership.status !== 'confirmed') {
        throw errors.invalidTransition('Membership', membership.status, 'suspend');
      }
      const from = new Date(input.from);
      const until = input.until ? new Date(input.until) : null;
      if (until && until <= from) {
        throw errors.validation('A suspension ends after it starts.', { path: 'until' });
      }
      const id = newId();
      try {
        await trx
          .insertInto('membership_suspensions')
          .values({
            id,
            organization_id: organizationId,
            enrollment_id: enrollmentId,
            participant_person_id: membership.participant_person_id,
            suspended_from: from,
            suspended_until: until,
            reason: input.reason,
            created_by: json(actorSnapshot(principal)),
            created_by_person_id: principal.personId,
          })
          .execute();
      } catch (error) {
        if (pgErrorCode(error) === '23P01') {
          throw errors.resourceConflict('The membership is already suspended in that period.', {
            code: 'SUSPENSION_OVERLAP',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageMembershipSuspension.id,
        targetType: 'membership_suspension',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: {
          enrollmentId,
          from: from.toISOString(),
          until: until?.toISOString() ?? null,
        },
      });
      await this.changed(trx, organizationId, membership, 'suspended', from, correlationId);
      const row = await trx
        .selectFrom('membership_suspensions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return this.toSuspension(row);
    });
  }

  async endSuspension(
    principal: Principal,
    suspensionId: string,
    input: EndMembershipSuspensionInput,
    correlationId: string | null,
  ): Promise<MembershipSuspension> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('membership_suspensions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', suspensionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.protectedNotFound('membership_suspension');
      const membership = await this.enrollments.load(trx, organizationId, row.enrollment_id);
      await this.authorization.require(principal, EnrollmentActions.manageMembershipSuspension, {
        type: 'membership_suspension',
        id: suspensionId,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, membership?.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const ended = await this.endInTrx(trx, organizationId, row, principal, input.reason);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageMembershipSuspension.id,
        targetType: 'membership_suspension',
        targetId: suspensionId,
        beforeRevision: row.revision,
        afterRevision: ended.revision,
        reason: input.reason,
        correlationId,
      });
      if (membership) {
        await this.changed(
          trx,
          organizationId,
          membership,
          'resumed',
          this.clock.now(),
          correlationId,
        );
      }
      return this.toSuspension(ended);
    });
  }

  private async endInTrx(
    trx: Trx,
    organizationId: string,
    row: SuspensionRow,
    actor: Principal,
    reason: string,
  ): Promise<SuspensionRow> {
    const status = MembershipSuspensionMachine.next(row.status, 'end');
    await trx
      .updateTable('membership_suspensions')
      .set({
        status,
        ended_at: this.clock.now(),
        ended_reason: reason,
        ended_by: json(actorSnapshot(actor)),
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    return trx
      .selectFrom('membership_suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
  }

  // -------------------------------------------------------------------------------------------
  // POST /enrollments/{id}/renew (capability memberships)
  // -------------------------------------------------------------------------------------------

  async renew(
    principal: Principal,
    enrollmentId: string,
    input: RenewMembershipInput,
    correlationId: string | null,
  ): Promise<Basket> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const membership = await this.enrollments.load(trx, organizationId, enrollmentId, true);
      if (!membership || membership.intent !== 'membership') {
        throw errors.protectedNotFound('membership');
      }
      await this.authorization.require(principal, EnrollmentActions.renewMembership, {
        type: 'enrollment',
        id: enrollmentId,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, input.targetOfferingId, trx),
        subjectPersonIds: [membership.participant_person_id],
        protected: true,
      });
      await this.capabilities.require(organizationId, 'memberships', trx);
      if (membership.status !== 'confirmed') {
        throw errors.invalidTransition('Membership', membership.status, 'renew');
      }
      const target = await this.evaluator.snapshot(trx, organizationId, input.targetOfferingId);
      if (target.offering.kind !== 'membership') {
        throw errors.validation('A membership renews into a membership offering.', {
          path: 'targetOfferingId',
        });
      }
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        membership.participant_person_id,
      );
      let basket = input.basketId
        ? await this.baskets.load(trx, organizationId, input.basketId, true)
        : undefined;
      if (input.basketId) {
        if (!basket) throw errors.protectedNotFound('basket');
        await this.authorization.require(principal, EnrollmentActions.manageBasket, {
          type: 'basket',
          id: basket.id,
          organizationId,
          subjectPersonIds: [...new Set([basket.owner_person_id, person.id])],
          protected: true,
        });
        if (basket.status !== 'open') {
          throw errors.invalidTransition('Basket', basket.status, 'add_line');
        }
      } else {
        const ownerPersonId = isStaffLike(principal)
          ? (membership.payer_person_id ?? membership.participant_person_id)
          : (principal.personId as string);
        const owner = await this.evaluator.participant(trx, organizationId, ownerPersonId);
        const id = newId();
        await trx
          .insertInto('baskets')
          .values({
            id,
            organization_id: organizationId,
            owner_person_id: owner.id,
            payer_person_id: membership.payer_person_id ?? owner.id,
            created_by: json(actorSnapshot(principal)),
            created_by_person_id: principal.personId,
            assisted_by_person_id: isStaffLike(principal) ? principal.personId : null,
            fulfillment_mode: 'all_or_nothing',
            partial_accepted_at: null,
            status: 'open',
            hold_expires_at: null,
            currency: null,
            order_ref: null,
            last_operation_id: null,
            checkout_started_at: null,
            fulfilled_at: null,
            released_at: null,
            release_reason: null,
          })
          .execute();
        basket = await this.baskets.load(trx, organizationId, id, true);
        if (!basket) throw errors.internal('basket vanished');
      }
      const view = await this.baskets.addLineInTrx(
        trx,
        organizationId,
        principal,
        basket,
        person,
        {
          participantPersonId: person.id,
          offeringId: target.offering.id,
          intent: 'membership',
          quantity: 1,
        } as Parameters<BasketsService['addLineInTrx']>[5],
        null,
        { correlationId, renewedFromEnrollmentId: membership.id },
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.renewMembership.id,
        targetType: 'enrollment',
        targetId: membership.id,
        correlationId,
        details: { basketId: basket.id, targetOfferingId: target.offering.id },
      });
      return view;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle job pieces (enrollment.membership_lifecycle)
  // -------------------------------------------------------------------------------------------

  /** Confirmed memberships whose term has ended, to complete. */
  async endedTerms(now: Date, limit: number) {
    return this.db
      .selectFrom('enrollments')
      .select(['id', 'organization_id'])
      .where('intent', '=', 'membership')
      .where('status', '=', 'confirmed')
      .where('membership_ends_at', '<=', now)
      .orderBy('membership_ends_at')
      .orderBy('id')
      .limit(limit)
      .execute();
  }

  async completeIfEnded(trx: Trx, organizationId: string, id: string): Promise<boolean> {
    const row = await this.enrollments.load(trx, organizationId, id, true);
    const now = this.clock.now();
    if (
      !row ||
      row.intent !== 'membership' ||
      row.status !== 'confirmed' ||
      !row.membership_ends_at ||
      new Date(row.membership_ends_at) > now
    ) {
      return false;
    }
    await this.enrollments.completeInTrx(
      trx,
      organizationId,
      row,
      enrollmentSystem(organizationId, 'enrollment.membership_lifecycle'),
      'membership_term_ended',
      null,
    );
    await this.changed(trx, organizationId, row, 'ended', new Date(row.membership_ends_at), null);
    return true;
  }

  async elapsedSuspensions(now: Date, limit: number) {
    return this.db
      .selectFrom('membership_suspensions')
      .select(['id', 'organization_id'])
      .where('status', '=', 'active')
      .where('suspended_until', 'is not', null)
      .where('suspended_until', '<=', now)
      .orderBy('suspended_until')
      .orderBy('id')
      .limit(limit)
      .execute();
  }

  async endIfElapsed(trx: Trx, organizationId: string, id: string): Promise<boolean> {
    const row = await trx
      .selectFrom('membership_suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    const now = this.clock.now();
    if (
      !row ||
      row.status !== 'active' ||
      !row.suspended_until ||
      new Date(row.suspended_until) > now
    ) {
      return false;
    }
    const system = enrollmentSystem(organizationId, 'enrollment.membership_lifecycle');
    const ended = await this.endInTrx(trx, organizationId, row, system, 'elapsed');
    await this.audit.record(trx, {
      organizationId,
      actor: system,
      action: 'enrollment.end_membership_suspension',
      targetType: 'membership_suspension',
      targetId: id,
      beforeRevision: row.revision,
      afterRevision: ended.revision,
      reason: 'elapsed',
    });
    const membership = await this.enrollments.load(trx, organizationId, row.enrollment_id);
    if (membership) {
      await this.changed(
        trx,
        organizationId,
        membership,
        'resumed',
        new Date(row.suspended_until),
        null,
      );
    }
    return true;
  }

  /**
   * Confirmed memberships whose renewal notice may be due (no notice composed yet): the ones the
   * job never evaluated, then those whose recorded due instant has come (ASYNC-03, 0513). A
   * membership that is not due yet is not re-read until its due instant, so it never occupies
   * the batch ahead of one that is.
   */
  async renewalCandidates(now: Date, limit: number) {
    return (
      this.db
        .selectFrom('enrollments')
        .select(['id', 'organization_id'])
        .where('intent', '=', 'membership')
        .where('status', '=', 'confirmed')
        .where('renewal_notice_at', 'is', null)
        .where('membership_ends_at', '>', now)
        // The longest permitted lead is 365 days; the definition decides the actual one.
        .where('membership_ends_at', '<=', new Date(now.getTime() + 366 * DAY_MS))
        .where((eb) =>
          eb.or([eb('renewal_notice_due_at', 'is', null), eb('renewal_notice_due_at', '<=', now)]),
        )
        .orderBy(sql`renewal_notice_due_at asc nulls first`)
        .orderBy('membership_ends_at')
        .orderBy('id')
        .limit(limit)
        .execute()
    );
  }

  /**
   * Composes the one renewal_opportunity notice (IF-22) of a membership when its definition sets
   * `renewal.noticeLeadDays`, the term ends within that lead and no renewal exists yet. The
   * notice's source id is stable (`renewal:<enrollmentId>`), so a replay composes nothing new.
   * Otherwise it records when the membership is next worth checking (`renewal_notice_due_at`):
   * the instant the lead is reached, the term end when the definition asks for no notice (never
   * due), or a day later while the definition cannot be read, a renewal is pending or the
   * `memberships` switch is off. CAPABILITIES-06 (DEC-016, DEC-072): renewing is a new commitment
   * behind that switch, so while it is off no notice invites a renewal the API would refuse, and
   * nothing is stamped: the one notice owed is still composed once the switch is back on
   * (`resumeRenewalNotices` makes it due at once).
   * Returns `sent`, `deferred` (the due instant was recorded) or `skipped` (nothing to do).
   */
  async renewalNoticeIfDue(
    trx: Trx,
    organizationId: string,
    id: string,
  ): Promise<'sent' | 'deferred' | 'skipped'> {
    const row = await this.enrollments.load(trx, organizationId, id, true);
    const now = this.clock.now();
    if (
      !row ||
      row.status !== 'confirmed' ||
      row.renewal_notice_at ||
      !row.membership_ends_at ||
      new Date(row.membership_ends_at) <= now
    ) {
      return 'skipped';
    }
    const endsAt = new Date(row.membership_ends_at);
    const defer = async (until: Date): Promise<'deferred'> => {
      await trx
        .updateTable('enrollments')
        .set({ renewal_notice_due_at: until })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .execute();
      return 'deferred';
    };
    const recheck = new Date(Math.min(endsAt.getTime(), now.getTime() + DAY_MS));
    const snapshot = await this.offerings.getOffering(organizationId, row.offering_id, now, trx);
    if (!snapshot) return defer(recheck);
    const scope = typedScope(snapshot, 'membership_benefit');
    const lead = scope?.renewal.noticeLeadDays ?? null;
    // No notice asked for: never due during this term.
    if (lead === null) return defer(endsAt);
    const dueAt = new Date(endsAt.getTime() - lead * DAY_MS);
    if (dueAt > now) return defer(dueAt);
    const renewal = await trx
      .selectFrom('enrollments')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('renewed_from_enrollment_id', '=', id)
      .where('status', 'in', ['pending', 'confirmed'])
      .executeTakeFirst();
    const pendingLine = await trx
      .selectFrom('basket_lines')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('renewed_from_enrollment_id', '=', id)
      .where('outcome', 'in', ['pending', 'held'])
      .executeTakeFirst();
    // A renewal is under way; if it is released or cancelled the notice is still due.
    if (renewal || pendingLine) return defer(recheck);
    // CAPABILITIES-06: no renewal can be bought while the switch is off; the notice waits for it.
    if (!(await this.capabilities.isEnabled(organizationId, 'memberships', trx))) {
      return defer(recheck);
    }
    const zone = await this.zoneOf(organizationId, snapshot.offering.facilityId, trx);
    const system = enrollmentSystem(organizationId, 'enrollment.membership_lifecycle');
    await this.notifications.composeAndQueueIn(trx, system, {
      kind: 'renewal_opportunity',
      facilityId: snapshot.offering.facilityId,
      subject: { type: 'enrollment', id: row.id },
      audience: { subjectPersonIds: [row.participant_person_id] },
      protected: true,
      title: 'Membership renewal',
      body: `The membership ${snapshot.offering.name} ends on ${
        zone
          ? new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium' }).format(endsAt)
          : endsAt.toISOString()
      }. It can be renewed in the app.`,
      sourceEventId: stableId(`renewal:${row.id}`),
    });
    await trx
      .updateTable('enrollments')
      .set({ renewal_notice_at: now })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: system,
      action: 'enrollment.renewal_notice',
      targetType: 'enrollment',
      targetId: row.id,
      details: { noticeLeadDays: lead, termEndsAt: endsAt.toISOString() },
    });
    return 'sent';
  }

  /**
   * CAPABILITIES-06: follow-up of `core.capability_changed` when `memberships` is enabled. The
   * renewal notices deferred while it was off become due now (`renewal_notice_due_at` cleared), so
   * the next lifecycle run composes each one still owed instead of waiting out the day's recheck.
   * Only memberships that never had their notice are touched; replay-safe.
   */
  async resumeRenewalNotices(trx: Trx, organizationId: string): Promise<number> {
    const now = this.clock.now();
    const result = await trx
      .updateTable('enrollments')
      .set({ renewal_notice_due_at: null })
      .where('organization_id', '=', organizationId)
      .where('intent', '=', 'membership')
      .where('status', '=', 'confirmed')
      .where('renewal_notice_at', 'is', null)
      .where('membership_ends_at', '>', now)
      .where('renewal_notice_due_at', 'is not', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  // -------------------------------------------------------------------------------------------
  // GET /enrollments/{id}/membership-suspensions (staff; GAPS-TRIAGE-02)
  // -------------------------------------------------------------------------------------------

  /**
   * GAPS-TRIAGE-02 (§4.9, SPK-COND-001): a membership's suspensions, newest first, with the id and
   * revision `POST /membership-suspensions/{id}/end` needs, so staff can end one recorded in an
   * earlier request (an open-ended suspension never ends by itself). Authorized exactly like the
   * suspension commands (`enrollment.manage_membership_suspension` at the offering's facility,
   * protected): a caller who may not suspend this membership learns nothing (NOT_FOUND, §4.10).
   * Never capability-gated (DEC-016: reads continue).
   */
  async listSuspensions(
    principal: Principal,
    enrollmentId: string,
    query: ListMembershipSuspensionsQuery,
  ): Promise<Page<MembershipSuspension>> {
    const organizationId = organizationOf(principal);
    const membership = await this.enrollments.load(this.db, organizationId, enrollmentId);
    if (!membership || membership.intent !== 'membership') {
      throw errors.protectedNotFound('membership');
    }
    await this.authorization.require(principal, EnrollmentActions.manageMembershipSuspension, {
      type: 'enrollment',
      id: enrollmentId,
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, membership.offering_id),
      subjectPersonIds: [membership.participant_person_id],
      protected: true,
    });
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('membership_suspensions')
      .selectAll()
      .select(cursorAt('membership_suspensions').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('membership_suspensions', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map((row) => this.toSuspension(row)), nextCursor: page.nextCursor };
  }

  // -------------------------------------------------------------------------------------------
  // GET /me/memberships
  // -------------------------------------------------------------------------------------------

  async listMine(principal: Principal, query: ListMyMembershipsQuery): Promise<Page<Membership>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.customers.subjectIds(principal, EnrollmentActions.readEnrollment);
    if (subjects.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('enrollments')
      .selectAll()
      .select(cursorAt('enrollments').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', subjects)
      .where('intent', '=', 'membership')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('enrollments', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const items: Membership[] = [];
    for (const row of page.rows) items.push(await this.view(this.db, organizationId, row));
    return { items, nextCursor: page.nextCursor };
  }

  async view(db: Reader, organizationId: string, row: EnrollmentRow): Promise<Membership> {
    const snapshot = await this.offerings.getOffering(
      organizationId,
      row.offering_id,
      this.clock.now(),
    );
    const scope = snapshot ? typedScope(snapshot, 'membership_benefit') : null;
    const suspensions = await db
      .selectFrom('membership_suspensions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', row.id)
      .orderBy('suspended_from')
      .orderBy('id')
      .execute();
    const usage = await db
      .selectFrom('membership_benefit_uses')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', row.id)
      .orderBy('period_key')
      .execute();
    const attendance = scope?.attendance;
    return {
      enrollmentId: row.id,
      participantPersonId: row.participant_person_id,
      offeringId: row.offering_id,
      offeringName: snapshot?.offering.name ?? null,
      status: row.status,
      termStartsAt: isoOrNull(row.membership_starts_at),
      termEndsAt: isoOrNull(row.membership_ends_at),
      attendance: attendance
        ? {
            mode: attendance.mode,
            limit:
              attendance.mode === 'included_sessions'
                ? {
                    count: attendance.limit.count,
                    period: attendance.limit.period,
                    weekStartsOn: attendance.limit.weekStartsOn ?? null,
                  }
                : null,
            appliesTo:
              attendance.mode === 'none'
                ? null
                : {
                    offeringIds: attendance.appliesTo.offeringIds ?? [],
                    programIds: attendance.appliesTo.programIds ?? [],
                  },
          }
        : null,
      renewedFromEnrollmentId: row.renewed_from_enrollment_id,
      suspensions: suspensions.map((s) => this.toSuspension(s)),
      usage: usage.map((u) => ({
        periodKey: u.period_key,
        usedCount: u.used_count,
        limitCount: u.limit_count,
      })),
      revision: row.revision,
      createdAt: iso(row.created_at),
    };
  }
}
