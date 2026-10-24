import { Inject, Injectable } from '@nestjs/common';
import {
  EnrollmentMachine,
  errors,
  newId,
  type CancelEnrollmentInput,
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
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import type { OfferingSnapshot } from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  FINANCE_POLICY_PORT,
  type ConfirmEnrollmentOptions,
  type EnrollmentPort,
  type FinancePolicyPort,
} from '../enrollment.ports';
import {
  actorSnapshot,
  isStaffLike,
  organizationOf,
  toEnrollment,
  toHold,
  toSessionBooking,
  type Reader,
} from '../enrollment.shared';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import { CapacityService, type HoldRow } from './capacity.service';
import { RegistrationEvaluator } from './registration-evaluator';

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
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async load(db: Reader, organizationId: string, id: string, forUpdate = false): Promise<EnrollmentRow | undefined> {
    let q = db.selectFrom('enrollments').selectAll().where('organization_id', '=', organizationId).where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async getEnrollment(organizationId: string, enrollmentId: string, trx?: Trx): Promise<Enrollment | null> {
    const row = await this.load(trx ?? this.uow.reader(), organizationId, enrollmentId);
    return row ? toEnrollment(row) : null;
  }

  async holdsForBasket(organizationId: string, basketId: string, trx?: Trx): Promise<Hold[]> {
    const rows = await this.capacity.holdsOfBasket(trx ?? this.uow.reader(), organizationId, basketId);
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
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return toEnrollment(row);
  }

  async list(principal: Principal, query: ListEnrollmentsQuery): Promise<Page<Enrollment>> {
    const organizationId = organizationOf(principal);
    if (!isStaffLike(principal) && !query.participantPersonId) {
      throw errors.validation('participantPersonId is required.');
    }
    await this.authorization.require(principal, EnrollmentActions.readEnrollment, {
      type: 'enrollment',
      organizationId,
      subjectPersonIds: query.participantPersonId ? [query.participantPersonId] : undefined,
      protected: !isStaffLike(principal),
    });
    let q = this.db
      .selectFrom('enrollments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit);
    if (query.participantPersonId) q = q.where('participant_person_id', '=', query.participantPersonId);
    if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    return { items: rows.map(toEnrollment), nextCursor: null };
  }

  /** Enrollments of several participants for the family calendar (authorization done by the caller). */
  async activeEnrollmentsOf(db: Reader, organizationId: string, participantPersonIds: readonly string[]): Promise<EnrollmentRow[]> {
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

  async createPending(trx: Trx, organizationId: string, input: CreatePendingEnrollmentInput): Promise<EnrollmentRow> {
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
    if (isUniqueViolation(error) && pgConstraintName(error) === 'enrollments_equivalent_active_idx') {
      return errors.duplicateEntitlement(
        'An equivalent active registration already exists for this participant.',
        { participantPersonId, offeringId },
      );
    }
    return error;
  }

  /** Application-level early feedback for §4.7 invariant 2; the partial unique index is the guarantee. */
  async findEquivalentActive(db: Reader, organizationId: string, participantPersonId: string, key: string | null): Promise<EnrollmentRow | undefined> {
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

  async commitHolds(trx: Trx, organizationId: string, holdIds: readonly string[]): Promise<Hold[]> {
    const rows: HoldRow[] = [];
    for (const holdId of holdIds) {
      const hold = await this.capacity.loadHold(trx, organizationId, holdId, true);
      if (!hold) throw errors.notFound('hold', holdId);
      if (hold.status !== 'active') {
        throw errors.capacityUnavailable(`Hold ${holdId} is ${hold.status}; nothing was committed.`, {
          holdId,
          status: hold.status,
          poolId: hold.pool_id,
        });
      }
      rows.push(hold);
    }
    const committed: HoldRow[] = [];
    for (const hold of rows) {
      const enrollmentId =
        hold.owner_kind === 'basket' && hold.owner_id
          ? ((
              await trx
                .selectFrom('enrollments')
                .select('id')
                .where('organization_id', '=', organizationId)
                .where('basket_line_id', '=', hold.owner_id)
                .where('status', 'in', ['pending', 'confirmed'])
                .executeTakeFirst()
            )?.id ?? null)
          : null;
      committed.push(await this.capacity.commitHold(trx, organizationId, hold.id, { enrollmentId }, null));
    }
    return committed.map(toHold);
  }

  async confirmEnrollment(trx: Trx, organizationId: string, enrollmentId: string, options: ConfirmEnrollmentOptions): Promise<Enrollment> {
    const row = await this.confirmInTrx(trx, organizationId, enrollmentId, options);
    return toEnrollment(row);
  }

  /**
   * Confirms a pending enrollment: commits its active holds; when its hold expired, re-acquires
   * the place only if it is still free, so a late payment never displaces a valid waitlist offer
   * (its hold counts in `held`) — CAPACITY_UNAVAILABLE otherwise (SPK-AT-006). Replay-safe.
   */
  async confirmInTrx(trx: Trx, organizationId: string, enrollmentId: string, options: ConfirmEnrollmentOptions): Promise<EnrollmentRow> {
    const now = this.clock.now();
    const row = await this.load(trx, organizationId, enrollmentId, true);
    if (!row) throw errors.notFound('enrollment', enrollmentId);
    if (row.status === 'confirmed') return row;
    EnrollmentMachine.next(row.status, 'confirm');
    if (row.source_application_id) {
      const application = await trx
        .selectFrom('applications')
        .select(['status', 'requires_approval'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.source_application_id)
        .executeTakeFirst();
      if (application?.requires_approval && application.status !== 'accepted') {
        // SPK-REG-007: human approval comes before a new payment is captured and before confirmation.
        throw errors.resourceConflict('This registration awaits human approval before it can be confirmed.', {
          code: 'APPROVAL_PENDING',
          applicationId: row.source_application_id,
          applicationStatus: application.status,
        });
      }
    }
    const holds = row.basket_line_id
      ? await this.capacity.holdsOfOwner(trx, organizationId, 'basket', row.basket_line_id)
      : [];
    const reacquire: Array<{ poolId: string; quantity: number }> = [];
    for (const hold of holds) {
      if (hold.status === 'active') {
        await this.capacity.commitHold(trx, organizationId, hold.id, { enrollmentId }, options.correlationId ?? null);
      } else if (hold.status !== 'committed') {
        reacquire.push({ poolId: hold.pool_id, quantity: hold.quantity });
      }
    }
    if (reacquire.length > 0) {
      await this.capacity.acquireCommitted(trx, organizationId, reacquire, { enrollmentId });
    }
    await trx
      .updateTable('enrollments')
      .set({
        status: 'confirmed',
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
        .set((eb) => ({ outcome: 'confirmed', enrollment_id: enrollmentId, revision: eb('revision', '+', 1) }))
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
        .where('status', '<>', 'converted')
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
      details: { orderRef: options.orderRef ?? null, reacquired: reacquire.length > 0 },
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

  async failConfirmation(trx: Trx, organizationId: string, enrollmentId: string, reason: string, actor: Principal, correlationId: string | null = null): Promise<Enrollment> {
    const row = await this.load(trx, organizationId, enrollmentId, true);
    if (!row) throw errors.notFound('enrollment', enrollmentId);
    if (row.status === 'canceled') return toEnrollment(row);
    const updated = await this.cancelInTrx(trx, organizationId, row, reason, actor, correlationId, null, 'failed');
    return toEnrollment(updated);
  }

  async confirmSessionBooking(trx: Trx, organizationId: string, bookingId: string, options: ConfirmEnrollmentOptions): Promise<SessionBooking> {
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
    if (row.status !== 'pending') throw errors.invalidTransition('SessionBooking', row.status, 'confirm');
    if (row.hold_id) {
      const hold = await this.capacity.loadHold(trx, organizationId, row.hold_id);
      if (hold?.status === 'active') {
        await this.capacity.commitHold(trx, organizationId, row.hold_id, { sessionBookingId: bookingId }, options.correlationId ?? null);
      } else if (hold && hold.status !== 'committed') {
        await this.capacity.acquireCommitted(trx, organizationId, [{ poolId: hold.pool_id, quantity: hold.quantity }], { sessionBookingId: bookingId });
      }
    }
    await trx
      .updateTable('session_bookings')
      .set({ status: 'confirmed', confirmed_at: now, revision: row.revision + 1 })
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

  async cancel(principal: Principal, id: string, input: CancelEnrollmentInput, correlationId: string | null): Promise<Enrollment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('enrollment');
      await this.authorization.require(principal, EnrollmentActions.cancelEnrollment, {
        type: 'enrollment',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      const consequence = await this.finance.cancellationConsequence(
        organizationId,
        {
          enrollmentId: id,
          participantPersonId: row.participant_person_id,
          offeringId: row.offering_id,
          cancellationPolicyVersionId: (row.policy_references['cancellationPolicyVersionId'] as string | null) ?? null,
          price: this.priceOf(row),
          at: this.clock.now(),
        },
        trx,
      );
      const updated = await this.cancelInTrx(trx, organizationId, row, input.reason, principal, correlationId, consequence, 'released');
      return toEnrollment(updated);
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
  ): Promise<EnrollmentRow> {
    const now = this.clock.now();
    EnrollmentMachine.next(row.status, 'cancel');
    const freed = await this.capacity.releaseAllocationsFor(trx, organizationId, { enrollmentId: row.id }, reason);
    if (row.basket_line_id) {
      for (const hold of await this.capacity.holdsOfOwner(trx, organizationId, 'basket', row.basket_line_id)) {
        if (hold.status === 'active') await this.capacity.releaseHoldRow(trx, organizationId, hold.id, reason, correlationId);
      }
      await trx
        .updateTable('basket_lines')
        .set((eb) => ({ outcome: lineOutcome, outcome_reason: reason, revision: eb('revision', '+', 1) }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.basket_line_id)
        .execute();
    }
    await trx
      .updateTable('enrollments')
      .set({
        status: 'canceled',
        canceled_at: now,
        cancellation_reason: reason,
        cancellation_policy_version_id: (row.policy_references['cancellationPolicyVersionId'] as string | null) ?? null,
        cancellation_consequence: consequence ? json(consequence) : null,
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
    await this.capacity.enqueueCapacityReleased(trx, organizationId, freed, 'enrollment_canceled', correlationId);
    const updated = await this.load(trx, organizationId, row.id);
    if (!updated) throw errors.internal('enrollment vanished');
    return updated;
  }

  // -------------------------------------------------------------------------------------------
  // Transfer (§4.8 POST /enrollments/{id}/transfer, SPK-REG-010): preview, then commit
  // -------------------------------------------------------------------------------------------

  async transfer(principal: Principal, id: string, input: TransferEnrollmentInput, correlationId: string | null): Promise<TransferPreview> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, input.commit);
      if (!row) throw errors.protectedNotFound('enrollment');
      await this.authorization.require(principal, EnrollmentActions.transferEnrollment, {
        type: 'enrollment',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (input.targetOfferingId === row.offering_id) {
        throw errors.validation('The target offering must differ from the current one.');
      }
      const source = await this.evaluator.snapshot(trx, organizationId, row.offering_id, now);
      const target = await this.evaluator.snapshot(trx, organizationId, input.targetOfferingId, now);
      const person = await this.evaluator.participant(trx, organizationId, row.participant_person_id);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, { snapshot: target, person, intent: row.intent }, now);
      const targetPools = this.capacity.poolsForIntent(
        await this.capacity.ensurePoolsForOffering(trx, organizationId, target, principal),
        row.intent,
      );
      const released = await trx
        .selectFrom('allocations')
        .innerJoin('capacity_pools', (join) =>
          join.onRef('capacity_pools.id', '=', 'allocations.pool_id').onRef('capacity_pools.organization_id', '=', 'allocations.organization_id'),
        )
        .select(['allocations.pool_id as pool_id', 'capacity_pools.unit as unit', 'allocations.quantity as quantity'])
        .where('allocations.organization_id', '=', organizationId)
        .where('allocations.enrollment_id', '=', id)
        .where('allocations.status', '=', 'active')
        .execute();
      const targetPrice = await this.evaluator.priceSnapshot(trx, organizationId, target.offering.id, now);
      const fromPrice = this.priceOf(row);
      const consequence = await this.finance.transferConsequence(
        organizationId,
        {
          enrollmentId: id,
          participantPersonId: row.participant_person_id,
          fromOfferingId: row.offering_id,
          toOfferingId: target.offering.id,
          fromPrice,
          toPrice: targetPrice ? { amountMinor: targetPrice.basePriceMinor, currency: targetPrice.currency } : null,
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
      const preview: TransferPreview = {
        enrollmentId: id,
        existing: this.participation(source, fromPrice ? (row.price_snapshot as unknown as PriceSnapshot) : null),
        proposed: this.participation(target, targetPrice),
        affectedDates: {
          existingRange: { startsOn: source.offering.startsOn, endsOn: source.offering.endsOn },
          proposedRange: { startsOn: target.offering.startsOn, endsOn: target.offering.endsOn },
          overlapping: source.offering.startsOn <= target.offering.endsOn && target.offering.startsOn <= source.offering.endsOn,
        },
        capacity: {
          released: released.map((r) => ({ poolId: r.pool_id, unit: r.unit })),
          required,
          sufficient: required.every((r) => r.available >= 1),
        },
        eligibility: evaluation.result,
        financialConsequence: consequence,
        requiredApproval: evaluation.requiresApproval,
        committed: false,
        newEnrollment: null,
        previousEnrollment: null,
      };
      if (!input.commit) return preview;

      // ---- commit -------------------------------------------------------------------------
      EnrollmentMachine.next(row.status, 'transfer');
      if (!evaluation.result.eligible) {
        throw errors.eligibility('The participant is not eligible for the target offering.', {
          reasons: evaluation.result.reasons,
          alternatives: evaluation.result.alternatives,
        });
      }
      const missing = missingAcknowledgments(evaluation.result);
      if (missing.length > 0) {
        throw errors.missingAcknowledgment('Required forms of the target offering are not acknowledged.', {
          policyVersionIds: missing,
        });
      }
      if (evaluation.requiresApproval && !isStaffLike(principal)) {
        throw errors.resourceConflict('The target offering requires staff approval; ask staff to transfer.', {
          code: 'APPROVAL_REQUIRED',
        });
      }
      if (consequence.kind !== 'none' && !input.acceptConsequence) {
        throw errors.resourceConflict('Review and accept the financial consequence before committing the transfer.', {
          code: 'CONSEQUENCE_NOT_ACCEPTED',
          consequence,
        });
      }
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
      const freed = await this.capacity.releaseAllocationsFor(trx, organizationId, { enrollmentId: id }, 'transferred');
      await trx
        .updateTable('enrollments')
        .set({
          status: 'transferred',
          transferred_at: now,
          transferred_to_enrollment_id: created.id,
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
            status: 'confirmed',
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
        details: { toEnrollmentId: created.id, toOfferingId: target.offering.id, consequence: consequence.kind },
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
          financialConsequence: consequence.kind,
        },
      });
      await this.capacity.enqueueCapacityReleased(trx, organizationId, freed, 'enrollment_transferred', correlationId);
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { fromEnrollmentId: id, toEnrollmentId: created.id },
      });
      const previous = await this.load(trx, organizationId, id);
      const next = await this.load(trx, organizationId, created.id);
      if (!previous || !next) throw errors.internal('enrollment vanished');
      return {
        ...preview,
        committed: true,
        previousEnrollment: toEnrollment(previous),
        newEnrollment: toEnrollment(next),
      };
    });
  }

  private participation(snapshot: OfferingSnapshot, price: PriceSnapshot | null): TransferPreview['existing'] {
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
