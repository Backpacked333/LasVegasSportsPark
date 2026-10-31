import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  SessionBookingMachine,
  errors,
  newId,
  type CancelSessionBookingInput,
  type ConfirmSessionBookingInput,
  type CreateSessionBookingInput,
  type EligibilityResult,
  type ListSessionBookingsQuery,
  type OfferingSession,
  type PriceSnapshot,
  type Principal,
  type SessionBooking,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type SessionBookingKind,
  type SessionBookingsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import type { OfferingSnapshot } from '../../catalog';
import {
  PERSON_DIRECTORY_PORT,
  type PersonDirectoryPort,
  type PersonSummary,
} from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  actorSnapshot,
  isStaffLike,
  minutesFrom,
  organizationOf,
  owesNothing as owesNothingFor,
  redactSessionBooking,
  resolveCustomerPayer,
  toSessionBooking,
  type Reader,
} from '../enrollment.shared';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import { CapacityService, type HoldRow } from './capacity.service';
import { CatalogSessions } from './catalog-sessions';
import { EnrollmentsService } from './enrollments.service';
import { EnrollmentFacilityScope } from './facility-scope';
import { MembershipsService, type MembershipUse } from './memberships.service';
import {
  PackageEntitlementsService,
  type CreditDisposition,
  type PackageEntitlementRow,
} from './package-entitlements.service';
import { RegistrationEvaluator, type Evaluation } from './registration-evaluator';

export type SessionBookingRow = Selectable<SessionBookingsTable>;

export interface CreateBookingInTrx {
  kind: SessionBookingKind;
  snapshot: OfferingSnapshot;
  session: OfferingSession;
  person: PersonSummary;
  evaluation: Evaluation;
  payerPersonId: string | null;
  actor: Principal;
  /** Holds already reserving the seat (an accepted waitlist offer); otherwise new holds are taken. */
  existingHoldIds?: readonly string[];
  /** Makeups are never money (SPK-YOUTH-004): no price, confirmed at once. */
  free?: boolean;
  makeupEntitlementId?: string | null;
  /** ENR-11, ENR-12: a booking a package credit or a membership pays for. */
  basis?:
    | { kind: 'package'; packageEntitlementId: string }
    | { kind: 'membership'; membershipEnrollmentId: string; periodKey: string | null };
  correlationId: string | null;
}

/**
 * GAPS-TRIAGE-01 (§6.7): the decisions a payment path for a single session of this kind waits for.
 * Pickup payment rules are POL-045 under DEC-082 (SPK-PLACE-004) and trial rules DEC-003
 * (SPK-YOUTH-003). A makeup seat is never money (SPK-YOUTH-004: it is redeemed from its
 * entitlement), and a session booked with a package credit or membership is paid by it, so neither
 * names a pickup or trial decision.
 */
export function sessionPaymentDecisions(kind: SessionBookingKind): string[] {
  if (kind === 'pickup') return ['POL-045', 'DEC-082'];
  if (kind === 'trial') return ['DEC-003'];
  return [];
}

/** What the family can do instead, per booking kind (plain operational copy). */
const SESSION_PAYMENT_REMEDY: Record<SessionBookingKind, string> = {
  pickup: 'book a session that owes nothing, or one a package credit or membership covers',
  trial: 'choose a trial that owes nothing',
  makeup:
    'redeem the makeup entitlement for the session (POST /v1/makeup-entitlements/{id}/redeem)',
  session: 'book the session with a package credit or membership that covers it',
};

/**
 * GAPS-TRIAGE-01 (SPK-PLACE-004 payment rules, SPK-YOUTH-003, SPK-PAY-001/002, §6.7): the refusal
 * of a session booking that would owe money. No payment path exists for a single session: the
 * finance checkout pays held basket lines that each carry an enrollment, and a pickup or trial seat
 * is never an enrollment (SPK-PLACE-004, SPK-YOUTH-003). The rules such a path would implement are
 * pending (`sessionPaymentDecisions`), so the booking is refused before any seat is held, any offer
 * consumed or any record written, instead of answering 201 for a booking nobody can pay that then
 * expires.
 */
export function sessionPaymentUnavailable(
  kind: SessionBookingKind,
  price: PriceSnapshot | null,
): DomainError {
  return errors.resourceConflict(
    `This ${kind === 'trial' ? 'trial' : 'session'} has a price, and a single session cannot be paid for yet: ${SESSION_PAYMENT_REMEDY[kind]}.`,
    {
      code: 'SESSION_PAYMENT_UNAVAILABLE',
      kind,
      amountMinor: price?.basePriceMinor ?? null,
      currency: price?.currency ?? null,
      pendingDecisions: sessionPaymentDecisions(kind),
    },
  );
}

/**
 * Session bookings (§4.4 SessionBooking, SessionBookingMachine §4.6, SPK-PLACE-004 pickup,
 * SPK-YOUTH-003 trial seats, SPK-YOUTH-004 makeup seats). Every booking takes a seat in the
 * session's own capacity pools (and its staffing pool, SPK-YOUTH-002) through a server-owned hold.
 * A booking that owes nothing (base price, approved fees and taxes), or that a package credit, a
 * membership or a makeup entitlement pays for, is confirmed at once. A booking that would owe
 * money is refused with 409 RESOURCE_CONFLICT `SESSION_PAYMENT_UNAVAILABLE` (see
 * `sessionPaymentUnavailable`): there is no payment step for a single session yet. Nothing here
 * touches a roster: pickup attendance never creates league membership (SPK-PLACE-004).
 */
@Injectable()
export class SessionBookingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly evaluator: RegistrationEvaluator,
    private readonly capacity: CapacityService,
    private readonly enrollments: EnrollmentsService,
    private readonly sessions: CatalogSessions,
    private readonly scope: EnrollmentFacilityScope,
    private readonly capabilities: CapabilityService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly packages: PackageEntitlementsService,
    private readonly memberships: MembershipsService,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<SessionBookingRow | undefined> {
    let q = db
      .selectFrom('session_bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // POST /session-bookings (pickup, SPK-PLACE-004)
  // -------------------------------------------------------------------------------------------

  async book(
    principal: Principal,
    input: CreateSessionBookingInput,
    correlationId: string | null,
  ): Promise<SessionBooking> {
    const organizationId = organizationOf(principal);
    const session = await this.sessions.get(organizationId, input.offeringId, input.sessionId);
    return this.uow.run(async ({ trx }) => {
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      await this.authorization.require(principal, EnrollmentActions.bookSession, {
        type: 'session_booking',
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, input.offeringId, trx),
        subjectPersonIds: [person.id],
      });
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const basis = input.packageEntitlementId
        ? 'package'
        : input.membershipEnrollmentId
          ? 'membership'
          : 'purchase';
      if (basis === 'purchase' && snapshot.offering.kind !== 'pickup') {
        throw errors.validation(
          'Session bookings are for pickup sessions; trials and makeups have their own commands.',
          { path: 'offeringId' },
        );
      }
      // ENR-10, ENR-11, ENR-12 (DEC-016): a new booking paid by a package or a membership needs
      // that switch, and any new pickup booking needs pickup_sessions (DEC-082); cancellation,
      // expiry and payment outcomes never check them.
      if (basis === 'package') {
        await this.capabilities.require(organizationId, 'session_packages', trx);
      }
      if (basis === 'membership') {
        await this.capabilities.require(organizationId, 'memberships', trx);
      }
      if (snapshot.offering.kind === 'pickup') {
        await this.capabilities.require(organizationId, 'pickup_sessions', trx);
      }
      const participantIds = await this.persons.personIdsResolvingTo(
        organizationId,
        person.id,
        trx,
      );
      const ids = participantIds.length > 0 ? participantIds : [person.id];
      let entitlement: PackageEntitlementRow | null = null;
      let membershipUse: MembershipUse | null = null;
      if (input.packageEntitlementId) {
        entitlement = await this.packages.lockForRedemption(
          trx,
          organizationId,
          input.packageEntitlementId,
          ids,
          snapshot,
        );
      }
      if (input.membershipEnrollmentId) {
        membershipUse = await this.memberships.lockForBooking(
          trx,
          organizationId,
          input.membershipEnrollmentId,
          ids,
          snapshot,
          session,
        );
      }
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: snapshot.offering.kind === 'pickup' ? 'pickup' : 'makeup',
        session,
      });
      if (basis !== 'purchase') {
        // The package or membership already decided which offerings it covers; the remaining
        // checks (registration open, age, forms, session status) still apply.
        evaluation.result.reasons = evaluation.result.reasons.filter(
          (r) => r.code !== 'intent_offering_mismatch',
        );
        evaluation.result.eligible = evaluation.result.reasons.every(
          (r) => r.severity === 'warning' || r.severity === 'info',
        );
      }
      this.assertBookable(evaluation.result, person.id);
      const row = await this.createInTrx(trx, organizationId, {
        kind: snapshot.offering.kind === 'pickup' ? 'pickup' : 'session',
        snapshot,
        session,
        person,
        evaluation,
        // §4.7 (1), SPK-REG-009: a customer books as their own payer; staff may name one. A
        // package or membership booking is already paid for.
        payerPersonId:
          basis !== 'purchase'
            ? null
            : (resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
              (isStaffLike(principal) ? null : principal.personId)),
        actor: principal,
        free: basis !== 'purchase',
        basis: entitlement
          ? { kind: 'package', packageEntitlementId: entitlement.id }
          : membershipUse
            ? {
                kind: 'membership',
                membershipEnrollmentId: membershipUse.membership.id,
                periodKey: membershipUse.periodKey,
              }
            : undefined,
        correlationId,
      });
      if (entitlement) {
        await this.packages.recordRedemption(
          trx,
          organizationId,
          entitlement,
          row,
          principal,
          correlationId,
        );
      }
      if (membershipUse) await this.memberships.consume(trx, organizationId, membershipUse);
      return redactSessionBooking(principal, toSessionBooking(row));
    });
  }

  /** Blocking eligibility and outstanding forms stop a booking (SPK-PLACE-004 entry requirements). */
  assertBookable(result: EligibilityResult, participantPersonId: string): void {
    if (!result.eligible) {
      throw errors.eligibility('The participant is not eligible for this session.', {
        participantPersonId,
        reasons: result.reasons,
        alternatives: result.alternatives,
      });
    }
    const missing = missingAcknowledgments(result);
    if (missing.length > 0) {
      throw errors.missingAcknowledgment('Required forms must be acknowledged before booking.', {
        participantPersonId,
        policyVersionIds: missing,
      });
    }
  }

  /**
   * GAPS-TRIAGE-01: the price a new booking of the offering would carry, refusing one that would
   * owe money (`SESSION_PAYMENT_UNAVAILABLE`). Pickup and trial waitlists call it before an entry
   * joins or an offer is made or accepted, so nobody waits for, or is offered, a seat that cannot be
   * booked (offer generation retires such waiters with a notice; see `WaitlistService`).
   */
  async assertSessionPayable(
    trx: Trx,
    organizationId: string,
    offeringId: string,
    kind: SessionBookingKind,
  ): Promise<PriceSnapshot | null> {
    const price = await this.evaluator.priceSnapshot(
      trx,
      organizationId,
      offeringId,
      this.clock.now(),
    );
    // SPK-PAY-001/002: approved non-inclusive fees and taxes are owed too (a fee-only booking owes).
    if (!owesNothingFor(price, 1)) throw sessionPaymentUnavailable(kind, price);
    return price;
  }

  /**
   * Shared booking body: refuses a booking that would owe money (GAPS-TRIAGE-01) before anything
   * is held, takes (or adopts) the seat in every pool of the session, writes the booking and
   * confirms it at once (nothing is owed).
   */
  async createInTrx(
    trx: Trx,
    organizationId: string,
    input: CreateBookingInTrx,
  ): Promise<SessionBookingRow> {
    const now = this.clock.now();
    const id = newId();
    const policy = this.evaluator.configuration;
    const expiresAt = minutesFrom(now, policy.holdMinutes);
    const price: PriceSnapshot | null = input.free
      ? null
      : await this.assertSessionPayable(
          trx,
          organizationId,
          input.snapshot.offering.id,
          input.kind,
        );

    let holds: HoldRow[] = [];
    if (input.existingHoldIds && input.existingHoldIds.length > 0) {
      for (const holdId of input.existingHoldIds) {
        holds.push(
          await this.capacity.reassignHold(
            trx,
            organizationId,
            holdId,
            { ownerKind: 'session_booking', ownerId: id, basketId: null },
            expiresAt,
            input.correlationId,
          ),
        );
      }
    } else {
      const pools = (
        await this.capacity.ensureSessionPool(
          trx,
          organizationId,
          input.snapshot,
          input.session,
          input.actor,
        )
      ).filter((p) => p.status === 'active');
      if (pools.length === 0) {
        // SPK-PLACE-004: a session needs its own capacity before anyone can book it.
        throw errors.validation('This session has no capacity configured.', {
          sessionId: input.session.id,
        });
      }
      if (
        policy.waitlistFirst &&
        (await this.capacity.othersWaiting(
          trx,
          organizationId,
          { offeringId: input.snapshot.offering.id, sessionId: input.session.id },
          input.person.id,
        )) > 0
      ) {
        throw errors.capacityUnavailable(
          'Seats of this session are offered to its waitlist first.',
          {
            sessionId: input.session.id,
            waitlistFirst: true,
          },
        );
      }
      const acquired = await this.capacity.acquireHolds(trx, organizationId, {
        pools: pools.map((p) => ({ poolId: p.id, quantity: 1 })),
        ownerKind: 'session_booking',
        ownerId: id,
        actor: input.actor,
        expiresAt,
        correlationId: input.correlationId,
      });
      holds = [];
      for (const hold of acquired) {
        const row = await this.capacity.loadHold(trx, organizationId, hold.id);
        if (row) holds.push(row);
      }
    }
    const primary = holds[0] ?? null;
    try {
      await trx
        .insertInto('session_bookings')
        .values({
          id,
          organization_id: organizationId,
          offering_id: input.snapshot.offering.id,
          session_id: input.session.id,
          participant_person_id: input.person.id,
          kind: input.kind,
          status: 'pending',
          pool_id: primary?.pool_id ?? null,
          hold_id: primary?.id ?? null,
          makeup_entitlement_id: input.makeupEntitlementId ?? null,
          entitlement_basis: input.makeupEntitlementId
            ? 'makeup'
            : (input.basis?.kind ?? 'purchase'),
          package_entitlement_id:
            input.basis?.kind === 'package' ? input.basis.packageEntitlementId : null,
          membership_enrollment_id:
            input.basis?.kind === 'membership' ? input.basis.membershipEnrollmentId : null,
          membership_period_key: input.basis?.kind === 'membership' ? input.basis.periodKey : null,
          scheduled_start: input.session.scheduledStart,
          scheduled_end: input.session.scheduledEnd,
          booked_by: json(actorSnapshot(input.actor)),
          booked_by_person_id: input.actor.personId,
          // SPK-REG-009: the staff actor is recorded apart from participant and payer.
          assisted_by_person_id: isStaffLike(input.actor) ? input.actor.personId : null,
          payer_person_id: input.payerPersonId,
          price_snapshot: price ? json(price) : null,
          policy_references: json(
            this.evaluator.policyReferences(input.snapshot, input.evaluation.approvalPolicy),
          ),
          eligibility_result: json(input.evaluation.result),
          // Nothing is owed, so the booking is confirmed below and its seat holds never lapse.
          expires_at: null,
          confirmed_at: null,
          canceled_at: null,
          cancel_reason: null,
          expired_at: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error) && pgConstraintName(error) === 'session_bookings_live_idx') {
        throw errors.duplicateEntitlement(
          'The participant already has a booking for this session.',
          {
            participantPersonId: input.person.id,
            sessionId: input.session.id,
          },
        );
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId,
      actor: input.actor,
      action: EnrollmentActions.bookSession.id,
      targetType: 'session_booking',
      targetId: id,
      afterRevision: 1,
      correlationId: input.correlationId,
      details: {
        kind: input.kind,
        offeringId: input.snapshot.offering.id,
        sessionId: input.session.id,
        holdIds: holds.map((h) => h.id),
        assistedByStaff: isStaffLike(input.actor),
        priceRuleId: price?.priceRuleId ?? null,
      },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.sessionBooked, {
      organizationId,
      aggregateType: 'session_booking',
      aggregateId: id,
      correlationId: input.correlationId,
      payload: {
        organizationId,
        bookingId: id,
        offeringId: input.snapshot.offering.id,
        sessionId: input.session.id,
        participantPersonId: input.person.id,
        kind: input.kind,
        status: 'confirmed',
      },
    });
    // Nothing is owed: the seat is committed now (SessionBookingMachine pending → confirmed).
    for (const hold of holds) {
      await this.capacity.commitHold(
        trx,
        organizationId,
        hold.id,
        { sessionBookingId: id },
        input.correlationId,
      );
    }
    await trx
      .updateTable('session_bookings')
      .set({
        status: SessionBookingMachine.next('pending', 'confirm'),
        confirmed_at: now,
        revision: 2,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .execute();
    const row = await this.load(trx, organizationId, id);
    if (!row) throw errors.internal('session booking vanished');
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<SessionBooking> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('session_booking');
    await this.authorization.require(principal, EnrollmentActions.readSessionBooking, {
      type: 'session_booking',
      id,
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, row.offering_id),
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return redactSessionBooking(principal, toSessionBooking(row));
  }

  async list(principal: Principal, query: ListSessionBookingsQuery): Promise<SessionBooking[]> {
    const organizationId = organizationOf(principal);
    if (!query.participantPersonId) {
      // A whole session's list is a staff view (entry, organizers).
      await this.authorization.require(principal, EnrollmentActions.readCapacity, {
        type: 'session_booking',
        organizationId,
      });
      if (!query.sessionId)
        throw errors.validation('sessionId or participantPersonId is required.');
    } else {
      await this.authorization.require(principal, EnrollmentActions.readSessionBooking, {
        type: 'session_booking',
        organizationId,
        subjectPersonIds: [query.participantPersonId],
        protected: true,
      });
    }
    // §4.3, §4.14: facility-scoped staff list only their facilities' bookings.
    const offerings = await this.scope.listOfferings(
      principal,
      query.participantPersonId
        ? EnrollmentActions.readSessionBooking
        : EnrollmentActions.readCapacity,
      organizationId,
      query.participantPersonId,
    );
    if (offerings?.length === 0) return [];
    let q = this.db
      .selectFrom('session_bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('scheduled_start')
      .orderBy('id');
    if (query.participantPersonId)
      q = q.where('participant_person_id', '=', query.participantPersonId);
    if (query.sessionId) q = q.where('session_id', '=', query.sessionId);
    if (offerings) q = q.where('offering_id', 'in', offerings);
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map((r) => redactSessionBooking(principal, toSessionBooking(r)));
  }

  // -------------------------------------------------------------------------------------------
  // Confirm (owes nothing) and cancel
  // -------------------------------------------------------------------------------------------

  async confirm(
    principal: Principal,
    id: string,
    input: ConfirmSessionBookingInput,
    correlationId: string | null,
  ): Promise<SessionBooking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('session_booking');
      await this.authorization.require(principal, EnrollmentActions.bookSession, {
        type: 'session_booking',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      SessionBookingMachine.next(row.status, 'confirm');
      // SPK-PAY-001/002: the booking's price basis (base plus approved fees and taxes) and the rule
      // effective now must both owe nothing; a makeup redemption is free by its entitlement.
      const price = row.price_snapshot as unknown as PriceSnapshot | null;
      const current = row.makeup_entitlement_id
        ? null
        : await this.evaluator.priceSnapshot(trx, organizationId, row.offering_id);
      if (!owesNothingFor(price, 1) || !owesNothingFor(current, 1)) {
        // GAPS-TRIAGE-01: no checkout takes a session booking (a priced one is refused when it is
        // made); a pending one recorded earlier owes money nobody can take, so it is cancelled or
        // left to expire with its hold.
        throw errors.resourceConflict(
          'This booking owes a payment, and a single session cannot be paid for yet; cancel it or let its hold expire.',
          {
            code: 'PAYMENT_REQUIRED',
            amountMinor: (current ?? price)?.basePriceMinor ?? null,
            currency: (current ?? price)?.currency ?? null,
            pendingDecisions: sessionPaymentDecisions(row.kind),
          },
        );
      }
      const booking = await this.enrollments.confirmSessionBooking(trx, organizationId, id, {
        actor: principal,
        correlationId,
      });
      return redactSessionBooking(principal, booking);
    });
  }

  async cancel(
    principal: Principal,
    id: string,
    input: CancelSessionBookingInput,
    correlationId: string | null,
  ): Promise<SessionBooking> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('session_booking');
      await this.authorization.require(principal, EnrollmentActions.bookSession, {
        type: 'session_booking',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const updated = await this.cancelInTrx(
        trx,
        organizationId,
        row,
        input.reason,
        principal,
        correlationId,
      );
      return redactSessionBooking(principal, toSessionBooking(updated));
    });
  }

  /**
   * Cancels a pending or confirmed booking: its seat goes back to the session pools, a makeup
   * redemption is reversed while the session has not started (a new history row, never an
   * update), and a linked trial is canceled with it.
   */
  async cancelInTrx(
    trx: Trx,
    organizationId: string,
    row: SessionBookingRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<SessionBookingRow> {
    const now = this.clock.now();
    const status = SessionBookingMachine.next(row.status, 'cancel');
    const freed = await this.capacity.releaseAllocationsFor(
      trx,
      organizationId,
      { sessionBookingId: row.id },
      reason,
    );
    for (const hold of await this.capacity.holdsOfOwner(
      trx,
      organizationId,
      'session_booking',
      row.id,
    )) {
      if (hold.status === 'active') {
        await this.capacity.releaseHoldRow(trx, organizationId, hold.id, reason, correlationId);
      }
    }
    // ENR-11, ENR-12: what happens to the package credit or membership session (POL-007, POL-039).
    let disposition: CreditDisposition | null = null;
    if (row.entitlement_basis === 'package') {
      disposition = await this.packages.onBookingCanceled(
        trx,
        organizationId,
        row,
        actor,
        reason,
        correlationId,
      );
    } else if (row.entitlement_basis === 'membership') {
      disposition = await this.memberships.onBookingCanceled(trx, organizationId, row);
    }
    await trx
      .updateTable('session_bookings')
      .set({
        status,
        canceled_at: now,
        cancel_reason: reason,
        credit_disposition: disposition,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    if (row.makeup_entitlement_id && new Date(row.scheduled_start).getTime() > now.getTime()) {
      const redemption = await trx
        .selectFrom('makeup_redemptions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('session_booking_id', '=', row.id)
        .where('kind', '=', 'redeem')
        .executeTakeFirst();
      if (redemption) {
        await trx
          .insertInto('makeup_redemptions')
          .values({
            id: newId(),
            organization_id: organizationId,
            makeup_entitlement_id: row.makeup_entitlement_id,
            session_booking_id: row.id,
            participant_person_id: row.participant_person_id,
            kind: 'reversal',
            reverses_redemption_id: redemption.id,
            actor: json(actorSnapshot(actor)),
            redeemed_at: now,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
    await trx
      .updateTable('trial_participations')
      .set((eb) => ({
        status: 'canceled',
        canceled_at: now,
        cancel_reason: reason,
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('session_booking_id', '=', row.id)
      .where('status', '=', 'scheduled')
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'enrollment.cancel_session_booking',
      targetType: 'session_booking',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason,
      correlationId,
      details: {
        previousStatus: row.status,
        kind: row.kind,
        entitlementBasis: row.entitlement_basis,
        creditDisposition: disposition,
      },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.sessionBookingChanged, {
      organizationId,
      aggregateType: 'session_booking',
      aggregateId: row.id,
      correlationId,
      payload: {
        organizationId,
        bookingId: row.id,
        sessionId: row.session_id,
        participantPersonId: row.participant_person_id,
        status,
        reason,
      },
    });
    await this.capacity.enqueueCapacityReleased(
      trx,
      organizationId,
      freed,
      'session_booking_canceled',
      correlationId,
    );
    const updated = await this.load(trx, organizationId, row.id);
    if (!updated) throw errors.internal('session booking vanished');
    return updated;
  }

  /** Hold-expiry follow-up: a pending (unpaid) booking whose seat expired becomes `expired`. */
  async onHoldExpired(
    trx: Trx,
    organizationId: string,
    hold: HoldRow,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (!hold.owner_id) return;
    const row = await this.load(trx, organizationId, hold.owner_id, true);
    if (!row || row.status !== 'pending') return;
    const now = this.clock.now();
    for (const other of await this.capacity.holdsOfOwner(
      trx,
      organizationId,
      'session_booking',
      row.id,
    )) {
      if (other.status === 'active') {
        await this.capacity.releaseHoldRow(
          trx,
          organizationId,
          other.id,
          'hold_expired',
          correlationId,
        );
      }
    }
    await trx
      .updateTable('session_bookings')
      .set({
        status: SessionBookingMachine.next(row.status, 'expire'),
        expired_at: now,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await trx
      .updateTable('trial_participations')
      .set((eb) => ({
        status: 'canceled',
        canceled_at: now,
        cancel_reason: 'hold_expired',
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('session_booking_id', '=', row.id)
      .where('status', '=', 'scheduled')
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'enrollment.expire_session_booking',
      targetType: 'session_booking',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason: 'hold_expired',
      correlationId,
      details: { holdId: hold.id },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.sessionBookingChanged, {
      organizationId,
      aggregateType: 'session_booking',
      aggregateId: row.id,
      correlationId,
      payload: {
        organizationId,
        bookingId: row.id,
        sessionId: row.session_id,
        participantPersonId: row.participant_person_id,
        status: 'expired',
        reason: 'hold_expired',
      },
    });
  }
}
