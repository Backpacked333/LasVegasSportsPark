import { Inject, Injectable } from '@nestjs/common';
import {
  EnrollmentMachine,
  SessionBookingMachine,
  errors,
  newId,
  type AcceptedConsequence,
  type CancelEnrollmentInput,
  type CancellationPreview,
  type CompleteEnrollmentInput,
  type EligibilityResult,
  type Enrollment,
  type FinancialConsequence,
  type Hold,
  type ListEnrollmentsQuery,
  type Page,
  type PolicyReferences,
  type PriceSnapshot,
  type Principal,
  type RegistrationIntent,
  type SessionBooking,
  type TransferEnrollmentInput,
  type TransferPreview,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type EnrollmentsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import type { OfferingSnapshot } from '../../catalog';
import { ROSTER_PORT, type RosterPort } from '../../competition';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  FINANCE_POLICY_PORT,
  type ConfirmEnrollmentOptions,
  type EnrollmentPort,
  type FinancePolicyPort,
  type ParticipationSummary,
} from '../enrollment.ports';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  isStaffLike,
  keysetPage,
  organizationOf,
  redactEnrollment,
  toEnrollment,
  toHold,
  toSessionBooking,
  type Reader,
} from '../enrollment.shared';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import { CapacityService, type HoldRow } from './capacity.service';
import { EnrollmentViews } from './enrollment-views';
import { RegistrationEvaluator } from './registration-evaluator';
import { EnrollmentFacilityScope } from './facility-scope';

export type EnrollmentRow = Selectable<EnrollmentsTable>;

export interface CreatePendingEnrollmentInput {
  offeringId: string;
  participantPersonId: string;
  intent: RegistrationIntent;
  entitlementDefinitionId: string | null;
  equivalenceKey: string | null;
  payerPersonId: string | null;
  actor: Principal;
  sourceApplicationId?: string | null;
  basketId?: string | null;
  basketLineId?: string | null;
  placementRequestId?: string | null;
  trialParticipationId?: string | null;
  priceSnapshot: PriceSnapshot | null;
  policyReferences: PolicyReferences;
  eligibilityResult: EligibilityResult | null;
  correlationId: string | null;
}

/**
 * Enrollments (§4.4 Enrollment, SPK-REG-003/010, §4.7 invariant 2, SPK-AT-004/006). An
 * enrollment is pending from the hold until payment facts confirm it; finance confirms or fails it
 * through EnrollmentPort inside its own transaction. Cancellation and transfer keep history: the
 * row is never deleted, a transfer links the old and new enrollments both ways (SPK-REG-010).
 */
@Injectable()
export class EnrollmentsService implements EnrollmentPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly capacity: CapacityService,
    private readonly evaluator: RegistrationEvaluator,
    @Inject(FINANCE_POLICY_PORT) private readonly finance: FinancePolicyPort,
    private readonly exceptions: OperationalExceptions,
    private readonly scope: EnrollmentFacilityScope,
    @Inject(ROSTER_PORT) private readonly rosters: RosterPort,
    private readonly views: EnrollmentViews,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<EnrollmentRow | undefined> {
    let q = db
      .selectFrom('enrollments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async participationsOf(
    organizationId: string,
    participantPersonIds: readonly string[],
    window?: { from: Date; to: Date },
    trx?: Trx,
  ): Promise<ParticipationSummary[]> {
    const db = trx ?? this.uow.reader();
    const ids = [...new Set(participantPersonIds)];
    if (ids.length === 0) return [];
    const enrollments = await this.activeEnrollmentsOf(db, organizationId, ids);
    let bookings = db
      .selectFrom('session_bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', ids)
      .where('status', 'in', ['pending', 'confirmed'])
      .orderBy('scheduled_start')
      .orderBy('id');
    if (window) {
      bookings = bookings
        .where('scheduled_start', '<', window.to)
        .where('scheduled_end', '>', window.from);
    }
    const bookingRows = await bookings.execute();
    return ids.map((participantPersonId) => ({
      participantPersonId,
      enrollments: enrollments
        .filter((e) => e.participant_person_id === participantPersonId)
        .map(toEnrollment),
      sessionBookings: bookingRows
        .filter((b) => b.participant_person_id === participantPersonId)
        .map(toSessionBooking),
    }));
  }

  async getEnrollment(
    organizationId: string,
    enrollmentId: string,
    trx?: Trx,
  ): Promise<Enrollment | null> {
    const row = await this.load(trx ?? this.uow.reader(), organizationId, enrollmentId);
    return row ? toEnrollment(row) : null;
  }

  async holdsForBasket(organizationId: string, basketId: string, trx?: Trx): Promise<Hold[]> {
    const rows = await this.capacity.holdsOfBasket(
      trx ?? this.uow.reader(),
      organizationId,
      basketId,
    );
    return rows.map(toHold);
  }

  /** Protected read: a caller without authority learns nothing about the record (§4.10). */
  async get(principal: Principal, id: string): Promise<Enrollment> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('enrollment');
    await this.authorization.require(principal, EnrollmentActions.readEnrollment, {
      type: 'enrollment',
      id,
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, row.offering_id),
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return this.views.view(this.db, organizationId, principal, row);
  }

  async list(principal: Principal, query: ListEnrollmentsQuery): Promise<Page<Enrollment>> {
    const organizationId = organizationOf(principal);
    if (!isStaffLike(principal) && !query.participantPersonId) {
      throw errors.validation('participantPersonId is required.');
    }
    await this.authorization.require(principal, EnrollmentActions.readEnrollment, {
      type: 'enrollment',
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, query.offeringId),
      subjectPersonIds: query.participantPersonId ? [query.participantPersonId] : undefined,
      protected: !isStaffLike(principal),
    });
    // §4.3, §4.14: facility-scoped staff list only their facilities' registrations.
    const offerings = await this.scope.listOfferings(
      principal,
      EnrollmentActions.readEnrollment,
      organizationId,
      query.participantPersonId,
    );
    if (offerings?.length === 0) return { items: [], nextCursor: null };
    // ENR-02 (§4.5): keyset pages, newest first.
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('enrollments')
      .selectAll()
      .select(cursorAt('enrollments').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.participantPersonId)
      q = q.where('participant_person_id', '=', query.participantPersonId);
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (offerings) q = q.where('offering_id', 'in', offerings);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('enrollments', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return {
      items: await this.views.views(this.db, organizationId, principal, page.rows),
      nextCursor: page.nextCursor,
    };
  }

  /** Enrollments of several participants for the family calendar (authorization done by the caller). */
  async activeEnrollmentsOf(
    db: Reader,
    organizationId: string,
    participantPersonIds: readonly string[],
  ): Promise<EnrollmentRow[]> {
    if (participantPersonIds.length === 0) return [];
    return db
      .selectFrom('enrollments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', [...participantPersonIds])
      .where('status', 'in', ['pending', 'confirmed'])
      .orderBy('created_at')
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Creation (pending, inside a basket hold or a placement) — §4.7 invariant 2 at the database
  // -------------------------------------------------------------------------------------------

  async createPending(
    trx: Trx,
    organizationId: string,
    input: CreatePendingEnrollmentInput,
  ): Promise<EnrollmentRow> {
    const id = newId();
    try {
      await trx
        .insertInto('enrollments')
        .values({
          id,
          organization_id: organizationId,
          offering_id: input.offeringId,
          participant_person_id: input.participantPersonId,
          intent: input.intent,
          entitlement_definition_id: input.entitlementDefinitionId,
          equivalence_key: input.equivalenceKey,
          status: 'pending',
          payer_person_id: input.payerPersonId,
          registered_by: json(actorSnapshot(input.actor)),
          registered_by_person_id: input.actor.personId,
          assisted_by_person_id: isStaffLike(input.actor) ? input.actor.personId : null,
          source_application_id: input.sourceApplicationId ?? null,
          basket_id: input.basketId ?? null,
          basket_line_id: input.basketLineId ?? null,
          placement_request_id: input.placementRequestId ?? null,
          trial_participation_id: input.trialParticipationId ?? null,
          order_ref: null,
          last_operation_id: null,
          price_snapshot: input.priceSnapshot ? json(input.priceSnapshot) : null,
          policy_references: json(input.policyReferences),
          eligibility_result: json(input.eligibilityResult ?? {}),
          confirmed_at: null,
          canceled_at: null,
          cancellation_reason: null,
          cancellation_policy_version_id: null,
          cancellation_consequence: null,
          transferred_at: null,
          transferred_to_enrollment_id: null,
          transferred_from_enrollment_id: null,
          transfer_consequence: null,
          completed_at: null,
        })
        .execute();
    } catch (error) {
      throw this.mapDuplicate(error, input.participantPersonId, input.offeringId);
    }
    await this.outbox.enqueue(trx, EnrollmentEvents.enrollmentCreated, {
      organizationId,
      aggregateType: 'enrollment',
      aggregateId: id,
      correlationId: input.correlationId,
      payload: {
        organizationId,
        enrollmentId: id,
        offeringId: input.offeringId,
        participantPersonId: input.participantPersonId,
        intent: input.intent,
        basketId: input.basketId ?? null,
        status: 'pending',
      },
    });
    const row = await this.load(trx, organizationId, id);
    if (!row) throw errors.internal('enrollment vanished');
    return row;
  }

  /** SPK-AT-004: the message never names the other registrant or payer (payer privacy). */
  mapDuplicate(error: unknown, participantPersonId: string, offeringId: string): unknown {
    if (
      isUniqueViolation(error) &&
      pgConstraintName(error) === 'enrollments_equivalent_active_idx'
    ) {
      return errors.duplicateEntitlement(
        'An equivalent active registration already exists for this participant.',
        { participantPersonId, offeringId },
      );
    }
    return error;
  }

  /** Application-level early feedback for §4.7 invariant 2; the partial unique index is the guarantee. */
  async findEquivalentActive(
    db: Reader,
    organizationId: string,
    participantPersonId: string,
    key: string | null,
  ): Promise<EnrollmentRow | undefined> {
    if (!key) return undefined;
    return db
      .selectFrom('enrollments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', '=', participantPersonId)
      .where('equivalence_key', '=', key)
      .where('status', 'in', ['pending', 'confirmed'])
      .executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // EnrollmentPort: finance confirms or fails after payment facts (§4.11 steps 7–10)
  // -------------------------------------------------------------------------------------------

  /**
   * Converts holds to allocations atomically (§4.11 step 8): every hold is locked in id order (so two
   * coordinators never deadlock), and when any of them is not active — expired, lapsed past its
   * server-owned expiry, released or already committed — CAPACITY_UNAVAILABLE is thrown before
   * anything is written. Each allocation names the record the hold was taken for.
   */
  async commitHolds(trx: Trx, organizationId: string, holdIds: readonly string[]): Promise<Hold[]> {
    const now = this.clock.now();
    const ids = [...new Set(holdIds)].sort();
    const rows: HoldRow[] = [];
    for (const holdId of ids) {
      const hold = await this.capacity.loadHold(trx, organizationId, holdId, true);
      if (!hold) throw errors.notFound('hold', holdId);
      if (hold.status !== 'active' || this.capacity.isLapsed(hold, now)) {
        const status = hold.status === 'active' ? 'expired' : hold.status;
        throw errors.capacityUnavailable(`Hold ${holdId} is ${status}; nothing was committed.`, {
          holdId,
          status,
          poolId: hold.pool_id,
        });
      }
      rows.push(hold);
    }
    const committed = new Map<string, HoldRow>();
    for (const hold of rows) {
      const target = await this.allocationTargetOf(trx, organizationId, hold);
      committed.set(
        hold.id,
        await this.capacity.commitHold(trx, organizationId, hold.id, target, null),
      );
    }
    return holdIds
      .filter((id, index) => holdIds.indexOf(id) === index)
      .map((id) => toHold(committed.get(id) as HoldRow));
  }

  /** The record a hold reserves for: the line's enrollment, the booking or the placement request. */
  private async allocationTargetOf(
    trx: Trx,
    organizationId: string,
    hold: HoldRow,
  ): Promise<{ enrollmentId?: string; sessionBookingId?: string; placementRequestId?: string }> {
    if (hold.owner_kind === 'session_booking' && hold.owner_id) {
      return { sessionBookingId: hold.owner_id };
    }
    if (hold.owner_kind === 'placement' && hold.owner_id) {
      return { placementRequestId: hold.owner_id };
    }
    if (hold.owner_kind === 'basket' && hold.owner_id) {
      const enrollment = await trx
        .selectFrom('enrollments')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('basket_line_id', '=', hold.owner_id)
        .where('status', 'in', ['pending', 'confirmed'])
        .executeTakeFirst();
      if (enrollment) return { enrollmentId: enrollment.id };
    }
    // A waitlist offer's hold or a staff hold reserves for nobody yet: it is accepted into a
    // basket (or a booking) first, which moves the hold to that owner.
    throw errors.resourceConflict(
      `Hold ${hold.id} does not reserve for an enrollment, booking or placement yet.`,
      { code: 'HOLD_WITHOUT_TARGET', holdId: hold.id, ownerKind: hold.owner_kind },
    );
  }

  /**
   * DEC-006 (proposed `waitlistFirst`): a place that came free while people wait goes to them
   * through an offer, even before the offer handler has run, so a payment that arrives after its
   * own hold lapsed cannot take it back (SPK-AT-006).
   */
  private async assertNoneWaiting(
    trx: Trx,
    organizationId: string,
    scope: { offeringId: string; sessionId: string | null },
    participantPersonId: string,
  ): Promise<void> {
    if (!this.evaluator.configuration.waitlistFirst) return;
    const waiting = await this.capacity.othersWaiting(
      trx,
      organizationId,
      scope,
      participantPersonId,
    );
    if (waiting > 0) {
      throw errors.capacityUnavailable(
        'The place was released after the hold expired and is offered to the waitlist first.',
        { ...scope, waitlistFirst: true },
      );
    }
  }

  async confirmEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    options: ConfirmEnrollmentOptions,
  ): Promise<Enrollment> {
    const row = await this.confirmInTrx(trx, organizationId, enrollmentId, options);
    return toEnrollment(row);
  }

  /**
   * Confirms a pending enrollment: commits its active holds; when its hold expired, re-acquires
   * the place only if it is still free, so a late payment never displaces a valid waitlist offer
   * (its hold counts in `held`) — CAPACITY_UNAVAILABLE otherwise (SPK-AT-006). Replay-safe.
   */
  /** The team entry a join_team enrollment applied to (its basket line or application). */
  private async teamEntryOf(
    trx: Trx,
    organizationId: string,
    row: EnrollmentRow,
  ): Promise<string | null> {
    if (row.basket_line_id) {
      const line = await trx
        .selectFrom('basket_lines')
        .select('team_entry_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.basket_line_id)
        .executeTakeFirst();
      if (line?.team_entry_id) return line.team_entry_id;
    }
    if (row.source_application_id) {
      const application = await trx
        .selectFrom('applications')
        .select('team_entry_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.source_application_id)
        .executeTakeFirst();
      if (application?.team_entry_id) return application.team_entry_id;
    }
    return null;
  }

  private async placeOnTeam(
    trx: Trx,
    organizationId: string,
    row: EnrollmentRow,
    options: ConfirmEnrollmentOptions,
  ): Promise<string | null> {
    if (row.intent !== 'join_team') return null;
    const teamEntryId = await this.teamEntryOf(trx, organizationId, row);
    if (!teamEntryId) {
      throw errors.resourceConflict('This team registration names no team entry to join.', {
        code: 'team_entry_missing',
        enrollmentId: row.id,
      });
    }
    const placed = await this.rosters.addRegisteredMember(trx, {
      organizationId,
      teamEntryId,
      personId: row.participant_person_id,
      enrollmentId: row.id,
      correlationId: options.correlationId ?? null,
    });
    return placed.membershipId;
  }

  async confirmInTrx(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    options: ConfirmEnrollmentOptions,
  ): Promise<EnrollmentRow> {
    const now = this.clock.now();
    const row = await this.load(trx, organizationId, enrollmentId, true);
    if (!row) throw errors.notFound('enrollment', enrollmentId);
    if (row.status === 'confirmed') return row;
    const confirmedStatus = EnrollmentMachine.next(row.status, 'confirm');
    if (row.source_application_id) {
      const application = await trx
        .selectFrom('applications')
        .select(['status', 'requires_approval'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.source_application_id)
        .executeTakeFirst();
      if (application?.requires_approval && application.status !== 'accepted') {
        // SPK-REG-007: human approval comes before a new payment is captured and before confirmation.
        throw errors.resourceConflict(
          'This registration awaits human approval before it can be confirmed.',
          {
            code: 'APPROVAL_PENDING',
            applicationId: row.source_application_id,
            applicationStatus: application.status,
          },
        );
      }
    }
    const holds = row.basket_line_id
      ? await this.capacity.holdsOfOwner(trx, organizationId, 'basket', row.basket_line_id)
      : [];
    const reacquire: Array<{ poolId: string; quantity: number }> = [];
    for (const hold of holds) {
      if (hold.status === 'active' && this.capacity.isLapsed(hold, now)) {
        // The server-owned expiry has passed though its timer has not run yet: the hold's one
        // terminal outcome is `expired` (SPK-REG-006); the place is re-acquired below only if free.
        await this.capacity.expireHoldIfDue(
          trx,
          organizationId,
          hold.id,
          options.correlationId ?? null,
        );
        reacquire.push({ poolId: hold.pool_id, quantity: hold.quantity });
      } else if (hold.status === 'active') {
        await this.capacity.commitHold(
          trx,
          organizationId,
          hold.id,
          { enrollmentId },
          options.correlationId ?? null,
        );
      } else if (hold.status !== 'committed') {
        reacquire.push({ poolId: hold.pool_id, quantity: hold.quantity });
      }
    }
    if (reacquire.length > 0) {
      // SPK-AT-006: a late payment never displaces an offer (its hold counts in `held`) nor skips
      // the queue; otherwise it is a tracked valid fulfillment of a still-free place.
      await this.assertNoneWaiting(
        trx,
        organizationId,
        { offeringId: row.offering_id, sessionId: null },
        row.participant_person_id,
      );
      await this.capacity.acquireCommitted(trx, organizationId, reacquire, { enrollmentId });
    }
    // SPK-AT-002, §4.11 step 8: a join_team registration is fulfilled by the roster place it paid
    // for, in this same transaction; a refusal by the competition rules fails the confirmation, so
    // the money received with incomplete fulfillment stays visible (finance's recovery path).
    const rosterMembershipId = await this.placeOnTeam(trx, organizationId, row, options);
    await trx
      .updateTable('enrollments')
      .set({
        status: confirmedStatus,
        confirmed_at: now,
        order_ref: options.orderRef ?? row.order_ref,
        last_operation_id: options.operationId ?? row.last_operation_id,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', enrollmentId)
      .where('revision', '=', row.revision)
      .execute();
    if (row.basket_line_id) {
      await trx
        .updateTable('basket_lines')
        .set((eb) => ({
          outcome: 'confirmed',
          enrollment_id: enrollmentId,
          revision: eb('revision', '+', 1),
        }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.basket_line_id)
        .execute();
    }
    if (row.trial_participation_id) {
      // SPK-AT-019: the trial history stays; the paid entitlement is a separate record linked here.
      await trx
        .updateTable('trial_participations')
        .set((eb) => ({
          status: 'converted',
          converted_enrollment_id: enrollmentId,
          converted_at: now,
          revision: eb('revision', '+', 1),
        }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.trial_participation_id)
        .where('status', 'in', ['scheduled', 'attended', 'no_show'])
        .execute();
      await this.outbox.enqueue(trx, EnrollmentEvents.trialChanged, {
        organizationId,
        aggregateType: 'trial_participation',
        aggregateId: row.trial_participation_id,
        correlationId: options.correlationId ?? null,
        payload: {
          organizationId,
          trialParticipationId: row.trial_participation_id,
          status: 'converted',
          convertedEnrollmentId: enrollmentId,
          convertedBasketId: row.basket_id,
        },
      });
    }
    await this.audit.record(trx, {
      organizationId,
      actor: options.actor,
      action: 'enrollment.confirm',
      targetType: 'enrollment',
      targetId: enrollmentId,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId: options.correlationId ?? null,
      operationId: options.operationId ?? null,
      details: {
        orderRef: options.orderRef ?? null,
        reacquired: reacquire.length > 0,
        ...(rosterMembershipId ? { rosterMembershipId } : {}),
      },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.enrollmentConfirmed, {
      organizationId,
      aggregateType: 'enrollment',
      aggregateId: enrollmentId,
      correlationId: options.correlationId ?? null,
      operationId: options.operationId ?? null,
      payload: {
        organizationId,
        enrollmentId,
        offeringId: row.offering_id,
        participantPersonId: row.participant_person_id,
        orderRef: options.orderRef ?? null,
      },
    });
    const updated = await this.load(trx, organizationId, enrollmentId);
    if (!updated) throw errors.internal('enrollment vanished');
    return updated;
  }

  async failConfirmation(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    reason: string,
    actor: Principal,
    correlationId: string | null = null,
    operationId: string | null = null,
  ): Promise<Enrollment> {
    const row = await this.load(trx, organizationId, enrollmentId, true);
    if (!row) throw errors.notFound('enrollment', enrollmentId);
    if (row.status === 'canceled') return toEnrollment(row);
    // A confirmation that failed concerns a pending enrollment only; a confirmed participation
    // ends through cancellation with its policy and financial consequence (SPK-REG-010).
    if (row.status !== 'pending') {
      throw errors.invalidTransition('Enrollment', row.status, 'fail_confirmation');
    }
    const updated = await this.cancelInTrx(
      trx,
      organizationId,
      row,
      reason,
      actor,
      correlationId,
      null,
      'failed',
      operationId,
    );
    return toEnrollment(updated);
  }

  async confirmSessionBooking(
    trx: Trx,
    organizationId: string,
    bookingId: string,
    options: ConfirmEnrollmentOptions,
  ): Promise<SessionBooking> {
    const now = this.clock.now();
    const row = await trx
      .selectFrom('session_bookings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('session_booking', bookingId);
    if (row.status === 'confirmed') return toSessionBooking(row);
    const status = SessionBookingMachine.next(row.status, 'confirm');
    const reacquire: Array<{ poolId: string; quantity: number }> = [];
    for (const hold of await this.capacity.holdsOfOwner(
      trx,
      organizationId,
      'session_booking',
      bookingId,
    )) {
      if (hold.status === 'active' && this.capacity.isLapsed(hold, now)) {
        await this.capacity.expireHoldIfDue(
          trx,
          organizationId,
          hold.id,
          options.correlationId ?? null,
        );
        reacquire.push({ poolId: hold.pool_id, quantity: hold.quantity });
      } else if (hold.status === 'active') {
        await this.capacity.commitHold(
          trx,
          organizationId,
          hold.id,
          { sessionBookingId: bookingId },
          options.correlationId ?? null,
        );
      } else if (hold.status !== 'committed') {
        reacquire.push({ poolId: hold.pool_id, quantity: hold.quantity });
      }
    }
    if (reacquire.length > 0) {
      await this.assertNoneWaiting(
        trx,
        organizationId,
        { offeringId: row.offering_id, sessionId: row.session_id },
        row.participant_person_id,
      );
      await this.capacity.acquireCommitted(trx, organizationId, reacquire, {
        sessionBookingId: bookingId,
      });
    }
    await trx
      .updateTable('session_bookings')
      .set({ status, confirmed_at: now, revision: row.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', bookingId)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: options.actor,
      action: 'enrollment.confirm_session_booking',
      targetType: 'session_booking',
      targetId: bookingId,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId: options.correlationId ?? null,
      details: { orderRef: options.orderRef ?? null },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.sessionBookingChanged, {
      organizationId,
      aggregateType: 'session_booking',
      aggregateId: bookingId,
      correlationId: options.correlationId ?? null,
      payload: {
        organizationId,
        bookingId,
        sessionId: row.session_id,
        participantPersonId: row.participant_person_id,
        status: 'confirmed',
        reason: null,
      },
    });
    const updated = await trx
      .selectFrom('session_bookings')
      .selectAll()
      .where('id', '=', bookingId)
      .executeTakeFirstOrThrow();
    return toSessionBooking(updated);
  }

  // -------------------------------------------------------------------------------------------
  // Cancellation (SPK-REG-010): releases capacity; the finance consequence is recorded as a fact
  // -------------------------------------------------------------------------------------------

  /** SPK-REG-010: shows what a cancellation would mean before it is committed; writes nothing. */
  async cancellationPreview(principal: Principal, id: string): Promise<CancellationPreview> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('enrollment');
    await this.authorization.require(principal, EnrollmentActions.cancelEnrollment, {
      type: 'enrollment',
      id,
      organizationId,
      facilityId: await this.scope.facilityOf(organizationId, row.offering_id),
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    const now = this.clock.now();
    const snapshot = await this.evaluator.snapshot(undefined, organizationId, row.offering_id, now);
    const released = await this.db
      .selectFrom('allocations')
      .innerJoin('capacity_pools', (join) =>
        join
          .onRef('capacity_pools.id', '=', 'allocations.pool_id')
          .onRef('capacity_pools.organization_id', '=', 'allocations.organization_id'),
      )
      .select([
        'allocations.pool_id as pool_id',
        'capacity_pools.unit as unit',
        'allocations.quantity as quantity',
      ])
      .where('allocations.organization_id', '=', organizationId)
      .where('allocations.enrollment_id', '=', id)
      .where('allocations.status', '=', 'active')
      .execute();
    const cancellationPolicyVersionId =
      (row.policy_references['cancellationPolicyVersionId'] as string | null) ?? null;
    const consequence = await this.finance.cancellationConsequence(organizationId, {
      enrollmentId: id,
      participantPersonId: row.participant_person_id,
      offeringId: row.offering_id,
      cancellationPolicyVersionId,
      price: this.priceOf(row),
      at: now,
    });
    return {
      enrollmentId: id,
      status: row.status,
      existing: this.participation(
        snapshot,
        (row.price_snapshot as unknown as PriceSnapshot) ?? null,
      ),
      affectedDates: { startsOn: snapshot.offering.startsOn, endsOn: snapshot.offering.endsOn },
      capacity: {
        released: released.map((r) => ({ poolId: r.pool_id, unit: r.unit, quantity: r.quantity })),
      },
      cancellationPolicyVersionId,
      financialConsequence: consequence,
      // Cancelling needs no human approval under the proposed defaults (DEC-009 governs money).
      requiredApproval: false,
      permitted: EnrollmentMachine.can(row.status, 'cancel'),
    };
  }

  async cancel(
    principal: Principal,
    id: string,
    input: CancelEnrollmentInput,
    correlationId: string | null,
  ): Promise<Enrollment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('enrollment');
      await this.authorization.require(principal, EnrollmentActions.cancelEnrollment, {
        type: 'enrollment',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status === 'pending' && row.basket_id) {
        const basket = await trx
          .selectFrom('baskets')
          .select(['status', 'order_ref'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.basket_id)
          .forUpdate()
          .executeTakeFirst();
        if (basket?.status === 'checking_out') {
          // §4.11, SPK-PAY-007: finance's checkout owns this pending enrollment while money may be
          // moving; it confirms or fails it. The customer cancels the checkout instead.
          throw errors.resourceConflict(
            'A checkout is in progress for this registration; cancel the checkout instead.',
            { code: 'CHECKOUT_IN_PROGRESS', orderRef: basket.order_ref },
          );
        }
      }
      const consequence = await this.finance.cancellationConsequence(
        organizationId,
        {
          enrollmentId: id,
          participantPersonId: row.participant_person_id,
          offeringId: row.offering_id,
          cancellationPolicyVersionId:
            (row.policy_references['cancellationPolicyVersionId'] as string | null) ?? null,
          price: this.priceOf(row),
          at: this.clock.now(),
        },
        trx,
      );
      // ENR-03: the consequence recomputed now is committed only as the customer accepted it.
      this.assertConsequenceAccepted(consequence, input.acceptedConsequence);
      const updated = await this.cancelInTrx(
        trx,
        organizationId,
        row,
        input.reason,
        principal,
        correlationId,
        consequence,
        'released',
      );
      return this.views.view(trx, organizationId, principal, updated);
    });
  }

  /** EnrollmentMachine `complete` (staff): the participation ended as planned; capacity stays history. */
  async complete(
    principal: Principal,
    id: string,
    input: CompleteEnrollmentInput,
    correlationId: string | null,
  ): Promise<Enrollment> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('enrollment');
      await this.authorization.require(principal, EnrollmentActions.completeEnrollment, {
        type: 'enrollment',
        id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const status = EnrollmentMachine.next(row.status, 'complete');
      await trx
        .updateTable('enrollments')
        .set({ status, completed_at: now, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.completeEnrollment.id,
        targetType: 'enrollment',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.enrollmentCompleted, {
        organizationId,
        aggregateType: 'enrollment',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          enrollmentId: id,
          offeringId: row.offering_id,
          participantPersonId: row.participant_person_id,
        },
      });
      return toEnrollment((await this.load(trx, organizationId, id))!);
    });
  }

  /** Shared cancellation body: machine guard, capacity release, line outcome, audit, events. */
  async cancelInTrx(
    trx: Trx,
    organizationId: string,
    row: EnrollmentRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
    consequence: FinancialConsequence | null,
    lineOutcome: 'failed' | 'released',
    /** ENR-06 (§4.11 step 4): the checkout or compensation operation that ended it, if any. */
    operationId: string | null = null,
  ): Promise<EnrollmentRow> {
    const now = this.clock.now();
    const canceledStatus = EnrollmentMachine.next(row.status, 'cancel');
    const freed = await this.capacity.releaseAllocationsFor(
      trx,
      organizationId,
      { enrollmentId: row.id },
      reason,
    );
    if (row.basket_line_id) {
      for (const hold of await this.capacity.holdsOfOwner(
        trx,
        organizationId,
        'basket',
        row.basket_line_id,
      )) {
        if (hold.status === 'active')
          await this.capacity.releaseHoldRow(trx, organizationId, hold.id, reason, correlationId);
      }
      await trx
        .updateTable('basket_lines')
        .set((eb) => ({
          outcome: lineOutcome,
          outcome_reason: reason,
          revision: eb('revision', '+', 1),
        }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.basket_line_id)
        .execute();
    }
    await trx
      .updateTable('enrollments')
      .set({
        status: canceledStatus,
        canceled_at: now,
        cancellation_reason: reason,
        cancellation_policy_version_id:
          (row.policy_references['cancellationPolicyVersionId'] as string | null) ?? null,
        cancellation_consequence: consequence ? json(consequence) : null,
        last_operation_id: operationId ?? row.last_operation_id,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: EnrollmentActions.cancelEnrollment.id,
      targetType: 'enrollment',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason,
      correlationId,
      details: { previousStatus: row.status, consequence: consequence?.kind ?? null },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.enrollmentCanceled, {
      organizationId,
      aggregateType: 'enrollment',
      aggregateId: row.id,
      correlationId,
      payload: {
        organizationId,
        enrollmentId: row.id,
        offeringId: row.offering_id,
        participantPersonId: row.participant_person_id,
        reason,
        previousStatus: row.status,
      },
    });
    await this.capacity.enqueueCapacityReleased(
      trx,
      organizationId,
      freed,
      'enrollment_canceled',
      correlationId,
    );
    const updated = await this.load(trx, organizationId, row.id);
    if (!updated) throw errors.internal('enrollment vanished');
    return updated;
  }

  // -------------------------------------------------------------------------------------------
  // Transfer (§4.8 POST /enrollments/{id}/transfer, SPK-REG-010): preview, then commit
  // -------------------------------------------------------------------------------------------

  /**
   * ENR-03 (SPK-REG-010): the read-only transfer preview against the target offering as it is now
   * (never a replayed answer), with the transfer's own authorization. Nothing is written: pools
   * the target does not have yet are shown from its catalog limits (`poolId` null).
   */
  async transferPreview(
    principal: Principal,
    id: string,
    targetOfferingId: string,
  ): Promise<TransferPreview> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('enrollment');
    await this.requireTransferAuthority(principal, organizationId, row, targetOfferingId);
    const facts = await this.transferFacts(
      this.db,
      undefined,
      organizationId,
      principal,
      row,
      targetOfferingId,
      this.clock.now(),
      'read',
    );
    return facts.preview;
  }

  private async requireTransferAuthority(
    principal: Principal,
    organizationId: string,
    row: EnrollmentRow,
    targetOfferingId: string,
    trx?: Trx,
  ): Promise<void> {
    // §4.3: a transfer acts at the source and the target offering's facility.
    await this.scope.requireAt(
      principal,
      EnrollmentActions.transferEnrollment,
      {
        type: 'enrollment',
        id: row.id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      },
      await this.scope.facilitiesOf(organizationId, [row.offering_id, targetOfferingId], trx),
    );
    if (targetOfferingId === row.offering_id) {
      throw errors.validation('The target offering must differ from the current one.');
    }
  }

  /**
   * Everything a transfer decision rests on, computed once for the preview and the commit:
   * eligibility, capacity (with the waitlist ahead, DEC-006), the price and the financial
   * consequence finance answers (DEC-009). `read` never writes; `commit` creates the target pools.
   */
  private async transferFacts(
    db: Reader,
    trx: Trx | undefined,
    organizationId: string,
    principal: Principal,
    row: EnrollmentRow,
    targetOfferingId: string,
    now: Date,
    mode: 'read' | 'commit',
  ) {
    const source = await this.evaluator.snapshot(trx, organizationId, row.offering_id, now);
    const target = await this.evaluator.snapshot(trx, organizationId, targetOfferingId, now);
    const person = await this.evaluator.participant(trx, organizationId, row.participant_person_id);
    const evaluation = await this.evaluator.evaluate(
      trx,
      organizationId,
      { snapshot: target, person, intent: row.intent },
      now,
    );
    const targetPools =
      mode === 'commit' && trx
        ? this.capacity.poolsForIntent(
            await this.capacity.ensurePoolsForOffering(trx, organizationId, target, principal),
            row.intent,
          )
        : await this.capacity.previewPoolsForIntent(db, organizationId, target, row.intent);
    const released = await db
      .selectFrom('allocations')
      .innerJoin('capacity_pools', (join) =>
        join
          .onRef('capacity_pools.id', '=', 'allocations.pool_id')
          .onRef('capacity_pools.organization_id', '=', 'allocations.organization_id'),
      )
      .select([
        'allocations.pool_id as pool_id',
        'capacity_pools.unit as unit',
        'allocations.quantity as quantity',
      ])
      .where('allocations.organization_id', '=', organizationId)
      .where('allocations.enrollment_id', '=', row.id)
      .where('allocations.status', '=', 'active')
      .execute();
    const targetPrice = await this.evaluator.priceSnapshot(
      trx,
      organizationId,
      target.offering.id,
      now,
    );
    const fromPrice = this.priceOf(row);
    const consequence = await this.finance.transferConsequence(
      organizationId,
      {
        enrollmentId: row.id,
        participantPersonId: row.participant_person_id,
        fromOfferingId: row.offering_id,
        toOfferingId: target.offering.id,
        fromPrice,
        toPrice: targetPrice
          ? { amountMinor: targetPrice.basePriceMinor, currency: targetPrice.currency }
          : null,
        at: now,
      },
      trx,
    );
    const required = targetPools.map((p) => ({
      poolId: p.id,
      unit: p.unit,
      constraintKind: p.constraint_kind,
      available: p.capacity - p.committed - p.held,
    }));
    // DEC-006 (proposed `waitlistFirst`): a transfer does not skip people waiting for the target.
    const waitlistAhead = this.evaluator.configuration.waitlistFirst
      ? await this.capacity.othersWaiting(
          db,
          organizationId,
          { offeringId: target.offering.id, sessionId: null },
          row.participant_person_id,
        )
      : 0;
    const preview: TransferPreview = {
      enrollmentId: row.id,
      existing: this.participation(
        source,
        fromPrice ? (row.price_snapshot as unknown as PriceSnapshot) : null,
      ),
      proposed: this.participation(target, targetPrice),
      affectedDates: {
        existingRange: { startsOn: source.offering.startsOn, endsOn: source.offering.endsOn },
        proposedRange: { startsOn: target.offering.startsOn, endsOn: target.offering.endsOn },
        overlapping:
          source.offering.startsOn <= target.offering.endsOn &&
          target.offering.startsOn <= source.offering.endsOn,
      },
      capacity: {
        released: released.map((r) => ({ poolId: r.pool_id, unit: r.unit })),
        required,
        waitlistAhead,
        sufficient: waitlistAhead === 0 && required.every((r) => r.available >= 1),
      },
      eligibility: evaluation.result,
      financialConsequence: consequence,
      requiredApproval: evaluation.requiresApproval,
      committed: false,
      newEnrollment: null,
      previousEnrollment: null,
    };
    return { preview, target, evaluation, targetPools, targetPrice, consequence, waitlistAhead };
  }

  /**
   * ENR-03 (SPK-REG-010, §4.9, §4.11): a refund, credit or charge is committed only as the customer
   * accepted it. The consequence was recomputed in the command's transaction; when it is not
   * `none`, the accepted one must be present and equal in kind, amount and currency, or nothing is
   * committed and the caller gets the current consequence to review again.
   */
  private assertConsequenceAccepted(
    consequence: FinancialConsequence,
    accepted: AcceptedConsequence | undefined,
  ): void {
    if (consequence.kind === 'none') return;
    if (!accepted) {
      throw errors.resourceConflict(
        'Review and accept the financial consequence before committing.',
        { code: 'CONSEQUENCE_ACCEPTANCE_REQUIRED', consequence },
      );
    }
    if (
      accepted.kind !== consequence.kind ||
      accepted.amountMinor !== consequence.amountMinor ||
      accepted.currency !== consequence.currency
    ) {
      throw errors.resourceConflict(
        'The financial consequence changed since it was previewed; review and accept it again.',
        { code: 'CONSEQUENCE_CHANGED', consequence },
      );
    }
  }

  async transfer(
    principal: Principal,
    id: string,
    input: TransferEnrollmentInput,
    correlationId: string | null,
  ): Promise<TransferPreview> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, input.commit);
      if (!row) throw errors.protectedNotFound('enrollment');
      await this.requireTransferAuthority(
        principal,
        organizationId,
        row,
        input.targetOfferingId,
        trx,
      );
      assertExpectedRevision(input.expectedRevision, row.revision);
      const facts = await this.transferFacts(
        trx,
        trx,
        organizationId,
        principal,
        row,
        input.targetOfferingId,
        now,
        input.commit ? 'commit' : 'read',
      );
      const { preview, target, evaluation, targetPrice, consequence, waitlistAhead } = facts;
      // Deprecated (ENR-03): `commit: false` still previews; GET .../transfer-preview is read-only.
      if (!input.commit) return preview;
      const targetPools = facts.targetPools.filter(
        (p): p is (typeof facts.targetPools)[number] & { id: string } => p.id !== null,
      );

      // ---- commit -------------------------------------------------------------------------
      const transferredStatus = EnrollmentMachine.next(row.status, 'transfer');
      if (!evaluation.result.eligible) {
        throw errors.eligibility('The participant is not eligible for the target offering.', {
          reasons: evaluation.result.reasons,
          alternatives: evaluation.result.alternatives,
        });
      }
      const missing = missingAcknowledgments(evaluation.result);
      if (missing.length > 0) {
        throw errors.missingAcknowledgment(
          'Required forms of the target offering are not acknowledged.',
          {
            policyVersionIds: missing,
          },
        );
      }
      if (evaluation.requiresApproval && !isStaffLike(principal)) {
        throw errors.resourceConflict(
          'The target offering requires staff approval; ask staff to transfer.',
          {
            code: 'APPROVAL_REQUIRED',
          },
        );
      }
      if (waitlistAhead > 0) {
        throw errors.capacityUnavailable(
          'Places of the target offering are offered to its waitlist first.',
          { offeringId: target.offering.id, waitlistFirst: true, waitlistAhead },
        );
      }
      this.assertConsequenceAccepted(consequence, input.acceptedConsequence);
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'enrollment.transfer',
        requestedBy: principal,
        correlationId,
        input: { enrollmentId: id, targetOfferingId: target.offering.id },
        status: 'running',
      });
      const equivalence = this.evaluator.equivalence(target, row.participant_person_id);
      // The new record starts without its equivalence key so a program-scoped key can move from the
      // old enrollment (released below) to the new one without tripping the active-entitlement index.
      const created = await this.createPending(trx, organizationId, {
        offeringId: target.offering.id,
        participantPersonId: row.participant_person_id,
        intent: row.intent,
        entitlementDefinitionId: target.entitlementDefinition?.id ?? null,
        equivalenceKey: null,
        payerPersonId: row.payer_person_id,
        actor: principal,
        sourceApplicationId: row.source_application_id,
        priceSnapshot: targetPrice,
        policyReferences: this.evaluator.policyReferences(target, evaluation.approvalPolicy),
        eligibilityResult: evaluation.result,
        correlationId,
      });
      const freed = await this.capacity.releaseAllocationsFor(
        trx,
        organizationId,
        { enrollmentId: id },
        'transferred',
      );
      await trx
        .updateTable('enrollments')
        .set({
          status: transferredStatus,
          transferred_at: now,
          transferred_to_enrollment_id: created.id,
          // SPK-REG-010, §4.7 invariant 12: the accepted refund, credit or charge is a recorded fact.
          transfer_consequence: json(consequence),
          last_operation_id: operationId,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.capacity.acquireCommitted(
        trx,
        organizationId,
        targetPools.map((p) => ({ poolId: p.id, quantity: 1 })),
        { enrollmentId: created.id },
      );
      try {
        await trx
          .updateTable('enrollments')
          .set({
            status: EnrollmentMachine.next(created.status, 'confirm'),
            confirmed_at: now,
            equivalence_key: equivalence,
            transferred_from_enrollment_id: id,
            order_ref: row.order_ref,
            last_operation_id: operationId,
            revision: created.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', created.id)
          .where('revision', '=', created.revision)
          .execute();
      } catch (error) {
        throw this.mapDuplicate(error, row.participant_person_id, target.offering.id);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.transferEnrollment.id,
        targetType: 'enrollment',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        operationId,
        details: {
          toEnrollmentId: created.id,
          toOfferingId: target.offering.id,
          consequence,
          consequenceAccepted: consequence.kind !== 'none',
          acceptedConsequence: input.acceptedConsequence ?? null,
        },
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.transferEnrollment.id,
        targetType: 'enrollment',
        targetId: created.id,
        afterRevision: created.revision + 1,
        correlationId,
        operationId,
        details: { fromEnrollmentId: id, fromOfferingId: row.offering_id },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.enrollmentTransferred, {
        organizationId,
        aggregateType: 'enrollment',
        aggregateId: id,
        correlationId,
        operationId,
        payload: {
          organizationId,
          fromEnrollmentId: id,
          toEnrollmentId: created.id,
          fromOfferingId: row.offering_id,
          toOfferingId: target.offering.id,
          participantPersonId: row.participant_person_id,
          financialConsequence: consequence,
        },
      });
      if (consequence.kind !== 'none') {
        // §4.7 invariant 12, §4.12: the money side of the transfer has an owner. How finance settles
        // it (an obligation, a credit or a refund, or keeping the new place pending until paid) is
        // DEC-009 (pending); until then finance resolves it from this follow-up.
        await this.exceptions.raise(trx, {
          organizationId,
          category: 'enrollment.transfer_consequence_pending',
          severity: 'warning',
          title: `Transfer accepted with a ${consequence.kind}${
            consequence.amountMinor !== null
              ? ` of ${consequence.amountMinor} ${consequence.currency ?? ''}`.trimEnd()
              : ''
          } to settle`,
          affectedType: 'enrollment',
          affectedId: id,
          ownerQueue: 'finance_operator',
          dedupeKey: `transfer_consequence:${id}`,
          details: {
            consequence,
            fromEnrollmentId: id,
            toEnrollmentId: created.id,
            orderRef: row.order_ref,
            payerPersonId: row.payer_person_id,
            operationId,
          },
        });
      }
      await this.capacity.enqueueCapacityReleased(
        trx,
        organizationId,
        freed,
        'enrollment_transferred',
        correlationId,
      );
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          fromEnrollmentId: id,
          toEnrollmentId: created.id,
          financialConsequence: consequence,
        },
      });
      const previous = await this.load(trx, organizationId, id);
      const next = await this.load(trx, organizationId, created.id);
      if (!previous || !next) throw errors.internal('enrollment vanished');
      return {
        ...preview,
        committed: true,
        previousEnrollment: redactEnrollment(principal, toEnrollment(previous)),
        newEnrollment: redactEnrollment(principal, toEnrollment(next)),
      };
    });
  }

  private participation(
    snapshot: OfferingSnapshot,
    price: PriceSnapshot | null,
  ): TransferPreview['existing'] {
    return {
      offeringId: snapshot.offering.id,
      offeringName: snapshot.offering.name,
      startsOn: snapshot.offering.startsOn,
      endsOn: snapshot.offering.endsOn,
      entitlementDefinitionId: snapshot.entitlementDefinition?.id ?? null,
      price,
    };
  }

  private priceOf(row: EnrollmentRow): { amountMinor: number; currency: string } | null {
    const snapshot = row.price_snapshot as { basePriceMinor?: number; currency?: string } | null;
    if (!snapshot || typeof snapshot.basePriceMinor !== 'number' || !snapshot.currency) return null;
    return { amountMinor: snapshot.basePriceMinor, currency: snapshot.currency };
  }
}
