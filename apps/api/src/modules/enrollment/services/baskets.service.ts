import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type AddBasketLineInput,
  type Basket,
  type BasketLine,
  type CompleteBasketInput,
  type CreateBasketInput,
  type EligibilityResult,
  type HoldBasketInput,
  type OfferingSession,
  type Principal,
  type RegistrationIntent,
  type ReleaseBasketInput,
  type RemoveBasketLineInput,
} from '@sportspark/contracts';
import { json, type BasketsTable, type Db } from '@sportspark/db';
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
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort, type OfferingSnapshot } from '../../catalog';
import type { PersonSummary } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import type { BasketPort } from '../enrollment.ports';
import {
  actorSnapshot,
  isStaffLike,
  minutesFrom,
  organizationOf,
  toBasket,
  toBasketLine,
  toHold,
  withSavepoint,
  type BasketLineRow,
  type Reader,
} from '../enrollment.shared';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import { ApplicationsService } from './applications.service';
import { CapacityService, type HoldRow } from './capacity.service';
import { EnrollmentsService } from './enrollments.service';
import { RegistrationEvaluator, type Evaluation } from './registration-evaluator';

export type BasketRow = Selectable<BasketsTable>;

/**
 * Household baskets (SPK-REG-004, SPK-REG-005/006 holds, SPK-REG-007 approval before payment,
 * SPK-REG-009 assisted registration, SPK-AT-001/004/005/006). Each line keeps its own participant,
 * entitlement, eligibility result, price snapshot, policy references and enrollment outcome.
 * Holding a basket acquires a server-owned hold on every required pool and creates the pending
 * enrollments in one transaction; finance commits the holds after payment facts, or the basket
 * completes here when nothing is owed.
 */
@Injectable()
export class BasketsService implements BasketPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly evaluator: RegistrationEvaluator,
    private readonly applications: ApplicationsService,
    private readonly capacity: CapacityService,
    private readonly enrollments: EnrollmentsService,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads and views
  // -------------------------------------------------------------------------------------------

  async load(db: Reader, organizationId: string, id: string, forUpdate = false): Promise<BasketRow | undefined> {
    let q = db.selectFrom('baskets').selectAll().where('organization_id', '=', organizationId).where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async lineRows(db: Reader, organizationId: string, basketId: string): Promise<BasketLineRow[]> {
    return db
      .selectFrom('basket_lines')
      .leftJoin('applications', (join) =>
        join
          .onRef('applications.id', '=', 'basket_lines.application_id')
          .onRef('applications.organization_id', '=', 'basket_lines.organization_id'),
      )
      .selectAll('basket_lines')
      .select('applications.status as application_status')
      .where('basket_lines.organization_id', '=', organizationId)
      .where('basket_lines.basket_id', '=', basketId)
      .orderBy('basket_lines.sequence')
      .execute();
  }

  async view(db: Reader, organizationId: string, row: BasketRow): Promise<Basket> {
    const lineRows = await this.lineRows(db, organizationId, row.id);
    const kinds = new Map<string, string | null>();
    for (const line of lineRows) {
      if (!kinds.has(line.offering_id)) {
        const snapshot = await this.offerings.getOffering(organizationId, line.offering_id, this.clock.now(), db as Trx);
        kinds.set(line.offering_id, snapshot?.offering.kind ?? null);
      }
    }
    const lines: BasketLine[] = lineRows.map((line) => toBasketLine({ ...line, offering_kind: kinds.get(line.offering_id) ?? null }));
    const holds = await this.capacity.holdsOfBasket(db, organizationId, row.id);
    return toBasket(row, lines, holds.map(toHold));
  }

  async getBasket(organizationId: string, basketId: string, trx?: Trx): Promise<Basket | null> {
    const db = trx ?? this.uow.reader();
    const row = await this.load(db, organizationId, basketId);
    return row ? this.view(db, organizationId, row) : null;
  }

  async get(principal: Principal, id: string): Promise<Basket> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('basket');
    await this.authorization.require(principal, EnrollmentActions.readBasket, {
      type: 'basket',
      id,
      organizationId,
      subjectPersonIds: [row.owner_person_id],
      protected: true,
    });
    return this.view(this.db, organizationId, row);
  }

  // -------------------------------------------------------------------------------------------
  // POST /baskets
  // -------------------------------------------------------------------------------------------

  async create(principal: Principal, input: CreateBasketInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    const ownerPersonId = input.ownerPersonId ?? (isStaffLike(principal) ? null : principal.personId);
    if (!ownerPersonId) throw errors.validation('ownerPersonId is required when staff open a basket.');
    return this.uow.run(async ({ trx }) => {
      const owner = await this.evaluator.participant(trx, organizationId, ownerPersonId);
      if (owner.kind !== 'adult') throw errors.validation('A basket belongs to an adult household member.');
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        organizationId,
        subjectPersonIds: [owner.id],
      });
      const payerPersonId = input.payerPersonId ?? owner.id;
      if (payerPersonId !== owner.id) await this.evaluator.participant(trx, organizationId, payerPersonId);
      const id = newId();
      const now = this.clock.now();
      await trx
        .insertInto('baskets')
        .values({
          id,
          organization_id: organizationId,
          owner_person_id: owner.id,
          payer_person_id: payerPersonId,
          created_by: json(actorSnapshot(principal)),
          created_by_person_id: principal.personId,
          // SPK-REG-009: the staff actor is recorded separately from owner, payer and signer.
          assisted_by_person_id: isStaffLike(principal) ? principal.personId : null,
          fulfillment_mode: input.fulfillmentMode,
          partial_accepted_at: input.fulfillmentMode === 'partial' ? now : null,
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
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { fulfillmentMode: input.fulfillmentMode, assistedByStaff: isStaffLike(principal) },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lines
  // -------------------------------------------------------------------------------------------

  async addLine(principal: Principal, basketId: string, input: AddBasketLineInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    const session = await this.applications.sessionFor(principal, input.offeringId, input.sessionId);
    return this.uow.run(async ({ trx }) => {
      const basket = await this.load(trx, organizationId, basketId, true);
      if (!basket) throw errors.protectedNotFound('basket');
      const person = await this.evaluator.participant(trx, organizationId, input.participantPersonId);
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        id: basketId,
        organizationId,
        subjectPersonIds: [person.id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, basket.revision);
      if (basket.status !== 'open') throw errors.invalidTransition('Basket', basket.status, 'add_line');
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
        teamEntryId: input.teamEntryId ?? null,
        session,
      });
      const equivalence = this.evaluator.equivalence(snapshot, person.id, session?.id ?? null);
      if (await this.enrollments.findEquivalentActive(trx, organizationId, person.id, equivalence)) {
        throw errors.duplicateEntitlement('An equivalent active registration already exists for this participant.', {
          participantPersonId: person.id,
          offeringId: snapshot.offering.id,
        });
      }
      let application = await this.applications.findCurrent(trx, organizationId, snapshot.offering.id, person.id);
      if (!application) {
        application = await this.applications.createInTrx(trx, organizationId, {
          snapshot,
          person,
          intent: input.intent,
          evaluation,
          payerPersonId: basket.payer_person_id,
          teamEntryId: input.teamEntryId ?? null,
          sessionId: session?.id ?? null,
          notes: null,
          actor: principal,
          correlationId,
        });
      }
      const price = await this.evaluator.priceSnapshot(trx, organizationId, snapshot.offering.id);
      if (price && basket.currency && basket.currency !== price.currency) {
        throw errors.validation(`A basket holds one currency (${basket.currency}).`);
      }
      const last = await trx
        .selectFrom('basket_lines')
        .select((eb) => eb.fn.max('sequence').as('sequence'))
        .where('organization_id', '=', organizationId)
        .where('basket_id', '=', basketId)
        .executeTakeFirst();
      const lineId = newId();
      await trx
        .insertInto('basket_lines')
        .values({
          id: lineId,
          organization_id: organizationId,
          basket_id: basketId,
          sequence: (last?.sequence ?? 0) + 1,
          participant_person_id: person.id,
          offering_id: snapshot.offering.id,
          session_id: session?.id ?? null,
          team_entry_id: input.teamEntryId ?? null,
          intent: input.intent,
          quantity: input.quantity,
          application_id: application.id,
          entitlement_definition_id: snapshot.entitlementDefinition?.id ?? null,
          equivalence_key: equivalence,
          eligibility_result: json(evaluation.result),
          price_snapshot: price ? json(price) : null,
          policy_references: json(this.evaluator.policyReferences(snapshot, evaluation.approvalPolicy)),
          requires_approval: evaluation.requiresApproval,
          enrollment_id: null,
          outcome: 'pending',
          outcome_reason: null,
        })
        .execute();
      await trx
        .updateTable('baskets')
        .set({ currency: basket.currency ?? price?.currency ?? null, revision: basket.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', basketId)
        .where('revision', '=', basket.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket_line',
        targetId: lineId,
        afterRevision: 1,
        correlationId,
        details: {
          basketId,
          offeringId: snapshot.offering.id,
          intent: input.intent,
          applicationId: application.id,
          eligible: evaluation.result.eligible,
          priceRuleId: price?.priceRuleId ?? null,
        },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
    });
  }

  async removeLine(principal: Principal, basketId: string, lineId: string, input: RemoveBasketLineInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const basket = await this.load(trx, organizationId, basketId, true);
      if (!basket) throw errors.protectedNotFound('basket');
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        id: basketId,
        organizationId,
        subjectPersonIds: [basket.owner_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, basket.revision);
      if (basket.status !== 'open') throw errors.invalidTransition('Basket', basket.status, 'remove_line');
      const deleted = await trx
        .deleteFrom('basket_lines')
        .where('organization_id', '=', organizationId)
        .where('basket_id', '=', basketId)
        .where('id', '=', lineId)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw errors.notFound('basket_line', lineId);
      await trx
        .updateTable('baskets')
        .set({ revision: basket.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', basketId)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket_line',
        targetId: lineId,
        correlationId,
        details: { basketId, removed: true },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // POST /baskets/{id}/hold — SPK-REG-005/006, SPK-AT-004/005
  // -------------------------------------------------------------------------------------------

  async hold(principal: Principal, basketId: string, input: HoldBasketInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const policy = this.evaluator.configuration;
    return this.uow.run(async ({ trx }) => {
      const basket = await this.load(trx, organizationId, basketId, true);
      if (!basket) throw errors.protectedNotFound('basket');
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        id: basketId,
        organizationId,
        subjectPersonIds: [basket.owner_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, basket.revision);
      if (basket.status !== 'open') throw errors.invalidTransition('Basket', basket.status, 'hold');
      const lines = await this.lineRows(trx, organizationId, basketId);
      if (lines.length === 0) throw errors.validation('The basket has no lines to hold.');
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'enrollment.hold_basket',
        requestedBy: principal,
        correlationId,
        input: { basketId, lines: lines.map((l) => l.id) },
        status: 'running',
      });
      const expiresAt = minutesFrom(now, policy.holdMinutes);
      const holdIds: string[] = [];
      const enrollmentIds: string[] = [];
      const failures: Array<{ lineId: string; error: DomainError }> = [];
      for (const line of lines) {
        const run = () => this.holdLine(trx, organizationId, basket, line, principal, expiresAt, correlationId);
        if (basket.fulfillment_mode === 'partial') {
          try {
            const outcome = await withSavepoint(trx, `line_${line.sequence}`, run);
            holdIds.push(...outcome.holdIds);
            enrollmentIds.push(outcome.enrollmentId);
          } catch (error) {
            if (!DomainError.is(error)) throw error;
            failures.push({ lineId: line.id, error });
            await trx
              .updateTable('basket_lines')
              .set((eb) => ({ outcome: 'failed', outcome_reason: `${error.code}: ${error.message}`, revision: eb('revision', '+', 1) }))
              .where('organization_id', '=', organizationId)
              .where('id', '=', line.id)
              .execute();
          }
        } else {
          // SPK-REG-004 all-or-nothing (DEC-026): one failing line fails the whole basket.
          const outcome = await run();
          holdIds.push(...outcome.holdIds);
          enrollmentIds.push(outcome.enrollmentId);
        }
      }
      if (enrollmentIds.length === 0) {
        const first = failures[0];
        if (first) throw first.error;
        throw errors.internal('no line could be held');
      }
      await trx
        .updateTable('baskets')
        .set({ status: 'held', hold_expires_at: expiresAt, last_operation_id: operationId, revision: basket.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', basketId)
        .where('revision', '=', basket.revision)
        .execute();
      const view = await this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket',
        targetId: basketId,
        beforeRevision: basket.revision,
        afterRevision: basket.revision + 1,
        correlationId,
        operationId,
        details: { holdIds, enrollmentIds, expiresAt: expiresAt.toISOString(), failedLines: failures.map((f) => f.lineId) },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.basketHeld, {
        organizationId,
        aggregateType: 'basket',
        aggregateId: basketId,
        correlationId,
        operationId,
        payload: { organizationId, basketId, holdIds, enrollmentIds, expiresAt: expiresAt.toISOString(), approvalPending: view.approvalPending },
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { basketId, holdIds, enrollmentIds, expiresAt: expiresAt.toISOString(), failedLines: failures.map((f) => ({ lineId: f.lineId, code: f.error.code })) },
      });
      return view;
    });
  }

  /** Holds one line: fresh eligibility and acknowledgments, every required pool, one pending enrollment. */
  private async holdLine(trx: Trx, organizationId: string, basket: BasketRow, line: BasketLineRow, principal: Principal, expiresAt: Date, correlationId: string | null): Promise<{ holdIds: string[]; enrollmentId: string }> {
    const snapshot = await this.evaluator.snapshot(trx, organizationId, line.offering_id);
    const person = await this.evaluator.participant(trx, organizationId, line.participant_person_id);
    const application = line.application_id ? await this.applications.load(trx, organizationId, line.application_id) : undefined;
    if (application && (application.status === 'declined' || application.status === 'withdrawn')) {
      throw errors.resourceConflict('The application for this line was declined or withdrawn.', {
        code: 'APPLICATION_CLOSED',
        lineId: line.id,
        applicationId: application.id,
        applicationStatus: application.status,
      });
    }
    const session = line.session_id ? await this.catalogSession(principal, line.offering_id, line.session_id) : undefined;
    const evaluation = await this.evaluator.evaluate(trx, organizationId, {
      snapshot,
      person,
      intent: line.intent,
      teamEntryId: line.team_entry_id,
      session,
    });
    const overridden = Boolean(application?.override) && application?.status !== 'submitted';
    if (!evaluation.result.eligible && !overridden) {
      throw errors.eligibility('The participant is not eligible for this offering.', {
        lineId: line.id,
        participantPersonId: person.id,
        reasons: evaluation.result.reasons,
        alternatives: evaluation.result.alternatives,
      });
    }
    const missing = missingAcknowledgments(evaluation.result);
    if (missing.length > 0) {
      // SPK-REG-009: the guardian (or adult participant) signs through the catalog; staff never do.
      throw errors.missingAcknowledgment('Required forms must be acknowledged before the place is held.', {
        lineId: line.id,
        participantPersonId: person.id,
        policyVersionIds: missing,
      });
    }
    const pools = this.capacity.poolsForIntent(
      await this.capacity.ensurePoolsForOffering(trx, organizationId, snapshot, principal),
      line.intent,
    );
    const holds = await this.capacity.acquireHolds(trx, organizationId, {
      pools: pools.map((p) => ({ poolId: p.id, quantity: line.quantity })),
      ownerKind: 'basket',
      ownerId: line.id,
      basketId: basket.id,
      actor: principal,
      expiresAt,
      correlationId,
    });
    const result: EligibilityResult = overridden
      ? { ...evaluation.result, eligible: true, overridden: true }
      : evaluation.result;
    const enrollment = await this.enrollments.createPending(trx, organizationId, {
      offeringId: snapshot.offering.id,
      participantPersonId: person.id,
      intent: line.intent,
      entitlementDefinitionId: snapshot.entitlementDefinition?.id ?? null,
      equivalenceKey: this.evaluator.equivalence(snapshot, person.id, line.session_id),
      payerPersonId: basket.payer_person_id,
      actor: principal,
      sourceApplicationId: application?.id ?? null,
      basketId: basket.id,
      basketLineId: line.id,
      priceSnapshot: (line.price_snapshot as unknown as Basket['lines'][number]['price']) ?? null,
      policyReferences: this.evaluator.policyReferences(snapshot, evaluation.approvalPolicy),
      eligibilityResult: result,
      correlationId,
    });
    await trx
      .updateTable('basket_lines')
      .set((eb) => ({
        outcome: 'held',
        enrollment_id: enrollment.id,
        eligibility_result: json(result),
        requires_approval: evaluation.requiresApproval,
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', line.id)
      .execute();
    return { holdIds: holds.map((h) => h.id), enrollmentId: enrollment.id };
  }

  private async catalogSession(principal: Principal, offeringId: string, sessionId: string): Promise<OfferingSession | null> {
    try {
      return (await this.applications.sessionFor(principal, offeringId, sessionId)) ?? null;
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Release, complete, expiry
  // -------------------------------------------------------------------------------------------

  async release(principal: Principal, basketId: string, input: ReleaseBasketInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const basket = await this.load(trx, organizationId, basketId, true);
      if (!basket) throw errors.protectedNotFound('basket');
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        id: basketId,
        organizationId,
        subjectPersonIds: [basket.owner_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, basket.revision);
      if (!['open', 'held', 'checking_out'].includes(basket.status)) {
        throw errors.invalidTransition('Basket', basket.status, 'release');
      }
      await this.releaseInTrx(trx, organizationId, basket, input.reason, principal, correlationId, 'released');
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket',
        targetId: basketId,
        beforeRevision: basket.revision,
        afterRevision: basket.revision + 1,
        reason: input.reason,
        correlationId,
        details: { released: true },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
    });
  }

  /** Cancels the pending enrollments (which releases their holds) and closes the basket. */
  async releaseInTrx(trx: Trx, organizationId: string, basket: BasketRow, reason: string, actor: Principal, correlationId: string | null, status: 'released' | 'expired' | 'abandoned'): Promise<void> {
    const now = this.clock.now();
    const lines = await this.lineRows(trx, organizationId, basket.id);
    for (const line of lines) {
      if (line.enrollment_id) {
        const enrollment = await this.enrollments.load(trx, organizationId, line.enrollment_id, true);
        if (enrollment && enrollment.status === 'pending') {
          await this.enrollments.cancelInTrx(trx, organizationId, enrollment, reason, actor, correlationId, null, 'released');
        }
      }
    }
    for (const hold of await this.capacity.holdsOfBasket(trx, organizationId, basket.id)) {
      if (hold.status === 'active') await this.capacity.releaseHoldRow(trx, organizationId, hold.id, reason, correlationId);
    }
    await trx
      .updateTable('baskets')
      .set({ status, released_at: now, release_reason: reason, revision: basket.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', basket.id)
      .where('revision', '=', basket.revision)
      .execute();
    await this.outbox.enqueue(trx, EnrollmentEvents.basketReleased, {
      organizationId,
      aggregateType: 'basket',
      aggregateId: basket.id,
      correlationId,
      payload: { organizationId, basketId: basket.id, reason },
    });
  }

  /**
   * Hold-expiry follow-up (timer handler): a basket still `held` (no checkout started) expires and
   * frees its pending enrollments; a basket in `checking_out` keeps them for finance to confirm
   * (re-acquiring the place if still free) or fail (SPK-AT-006).
   */
  async onHoldExpired(trx: Trx, organizationId: string, hold: HoldRow, correlationId: string | null): Promise<void> {
    if (!hold.basket_id) return;
    const basket = await this.load(trx, organizationId, hold.basket_id, true);
    if (!basket || basket.status !== 'held') return;
    const system: Principal = {
      kind: 'system',
      organizationId,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'enrollment.expire_hold',
    };
    await this.releaseInTrx(trx, organizationId, basket, 'hold_expired', system, correlationId, 'expired');
    await this.audit.record(trx, {
      organizationId,
      actor: system,
      action: 'enrollment.expire_basket',
      targetType: 'basket',
      targetId: basket.id,
      beforeRevision: basket.revision,
      afterRevision: basket.revision + 1,
      reason: 'hold_expired',
      correlationId,
      details: { holdId: hold.id },
    });
  }

  /** Completes a basket that owes nothing; paid baskets finish through the finance checkout (§4.11). */
  async complete(principal: Principal, basketId: string, input: CompleteBasketInput, correlationId: string | null): Promise<Basket> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const basket = await this.load(trx, organizationId, basketId, true);
      if (!basket) throw errors.protectedNotFound('basket');
      await this.authorization.require(principal, EnrollmentActions.manageBasket, {
        type: 'basket',
        id: basketId,
        organizationId,
        subjectPersonIds: [basket.owner_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, basket.revision);
      if (basket.status !== 'held') throw errors.invalidTransition('Basket', basket.status, 'complete');
      const current = await this.view(trx, organizationId, basket);
      this.assertPayable(current);
      if (current.subtotalMinor > 0) {
        throw errors.resourceConflict('This basket owes a payment; complete it through the checkout.', {
          code: 'PAYMENT_REQUIRED',
          subtotalMinor: current.subtotalMinor,
          currency: current.currency,
        });
      }
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'enrollment.complete_basket',
        requestedBy: principal,
        correlationId,
        input: { basketId },
        status: 'running',
      });
      const confirmed: string[] = [];
      for (const line of current.lines) {
        if (line.outcome !== 'held' || !line.enrollmentId) continue;
        await this.enrollments.confirmInTrx(trx, organizationId, line.enrollmentId, {
          actor: principal,
          correlationId,
          operationId,
        });
        confirmed.push(line.enrollmentId);
      }
      await this.markFulfilled(trx, organizationId, basket, confirmed, operationId, correlationId);
      await this.operations.transition(trx, operationId, 'succeeded', { result: { basketId, enrollmentIds: confirmed } });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.manageBasket.id,
        targetType: 'basket',
        targetId: basketId,
        beforeRevision: basket.revision,
        afterRevision: basket.revision + 1,
        correlationId,
        operationId,
        details: { completed: true, enrollmentIds: confirmed },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
    });
  }

  private async markFulfilled(trx: Trx, organizationId: string, basket: BasketRow, enrollmentIds: string[], operationId: string | null, correlationId: string | null): Promise<void> {
    const lines = await this.lineRows(trx, organizationId, basket.id);
    const partial = lines.some((l) => l.outcome !== 'confirmed');
    await trx
      .updateTable('baskets')
      .set({
        status: partial ? 'partially_fulfilled' : 'fulfilled',
        fulfilled_at: this.clock.now(),
        last_operation_id: operationId ?? basket.last_operation_id,
        revision: basket.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', basket.id)
      .where('revision', '=', basket.revision)
      .execute();
    await this.outbox.enqueue(trx, EnrollmentEvents.basketFulfilled, {
      organizationId,
      aggregateType: 'basket',
      aggregateId: basket.id,
      correlationId,
      operationId,
      payload: { organizationId, basketId: basket.id, enrollmentIds, partial },
    });
  }

  /** SPK-REG-007: no payment is captured while a line awaits human approval. */
  private assertPayable(basket: Basket): void {
    if (basket.approvalPending) {
      throw errors.resourceConflict('A line of this basket awaits human approval before payment.', {
        code: 'APPROVAL_PENDING',
        lineIds: basket.lines.filter((l) => l.requiresApproval && l.applicationStatus !== 'accepted').map((l) => l.id),
      });
    }
    if (basket.holdExpiresAt && new Date(basket.holdExpiresAt).getTime() <= this.clock.now().getTime()) {
      throw errors.resourceConflict('The hold on this basket has expired.', { code: 'HOLD_EXPIRED' });
    }
  }

  // -------------------------------------------------------------------------------------------
  // BasketPort for the finance checkout coordinator (§4.11)
  // -------------------------------------------------------------------------------------------

  async startCheckout(trx: Trx, organizationId: string, basketId: string, orderRef: string, actor: Principal): Promise<Basket> {
    const basket = await this.load(trx, organizationId, basketId, true);
    if (!basket) throw errors.notFound('basket', basketId);
    if (basket.status === 'checking_out' && basket.order_ref === orderRef) return this.view(trx, organizationId, basket);
    if (basket.status !== 'held') throw errors.invalidTransition('Basket', basket.status, 'start_checkout');
    const current = await this.view(trx, organizationId, basket);
    this.assertPayable(current);
    await trx
      .updateTable('baskets')
      .set({ status: 'checking_out', order_ref: orderRef, checkout_started_at: this.clock.now(), revision: basket.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', basketId)
      .where('revision', '=', basket.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'enrollment.start_checkout',
      targetType: 'basket',
      targetId: basketId,
      beforeRevision: basket.revision,
      afterRevision: basket.revision + 1,
      details: { orderRef },
    });
    return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
  }

  async assertPaymentPermitted(trx: Trx, organizationId: string, basketId: string): Promise<Basket> {
    const basket = await this.load(trx, organizationId, basketId);
    if (!basket) throw errors.notFound('basket', basketId);
    const current = await this.view(trx, organizationId, basket);
    if (!['held', 'checking_out'].includes(current.status)) {
      throw errors.invalidTransition('Basket', current.status, 'capture_payment');
    }
    this.assertPayable(current);
    return current;
  }

  async finishCheckout(trx: Trx, organizationId: string, basketId: string, outcome: 'fulfilled' | 'partially_fulfilled' | 'abandoned', actor: Principal): Promise<Basket> {
    const basket = await this.load(trx, organizationId, basketId, true);
    if (!basket) throw errors.notFound('basket', basketId);
    if (outcome === 'abandoned') {
      if (!['held', 'checking_out'].includes(basket.status)) return this.view(trx, organizationId, basket);
      await this.releaseInTrx(trx, organizationId, basket, 'checkout_abandoned', actor, null, 'abandoned');
    } else {
      if (basket.status === 'fulfilled' || basket.status === 'partially_fulfilled') return this.view(trx, organizationId, basket);
      const lines = await this.lineRows(trx, organizationId, basketId);
      await this.markFulfilled(
        trx,
        organizationId,
        basket,
        lines.filter((l) => l.outcome === 'confirmed' && l.enrollment_id).map((l) => l.enrollment_id as string),
        basket.last_operation_id,
        null,
      );
    }
    return this.view(trx, organizationId, (await this.load(trx, organizationId, basketId))!);
  }

  // -------------------------------------------------------------------------------------------
  // Baskets opened by other commands (waitlist acceptance, trial conversion)
  // -------------------------------------------------------------------------------------------

  async openForLine(
    trx: Trx,
    organizationId: string,
    input: {
      owner: PersonSummary;
      payerPersonId: string | null;
      actor: Principal;
      participant: PersonSummary;
      snapshot: OfferingSnapshot;
      intent: RegistrationIntent;
      sessionId: string | null;
      evaluation: Evaluation;
      applicationId: string | null;
      trialParticipationId?: string | null;
      correlationId: string | null;
    },
  ): Promise<{ basket: BasketRow; lineId: string }> {
    const now = this.clock.now();
    const basketId = newId();
    const price = await this.evaluator.priceSnapshot(trx, organizationId, input.snapshot.offering.id);
    await trx
      .insertInto('baskets')
      .values({
        id: basketId,
        organization_id: organizationId,
        owner_person_id: input.owner.id,
        payer_person_id: input.payerPersonId ?? input.owner.id,
        created_by: json(actorSnapshot(input.actor)),
        created_by_person_id: input.actor.personId,
        assisted_by_person_id: isStaffLike(input.actor) ? input.actor.personId : null,
        fulfillment_mode: 'all_or_nothing',
        partial_accepted_at: null,
        status: 'open',
        hold_expires_at: null,
        currency: price?.currency ?? null,
        order_ref: null,
        last_operation_id: null,
        checkout_started_at: null,
        fulfilled_at: null,
        released_at: null,
        release_reason: null,
      })
      .execute();
    const lineId = newId();
    await trx
      .insertInto('basket_lines')
      .values({
        id: lineId,
        organization_id: organizationId,
        basket_id: basketId,
        sequence: 1,
        participant_person_id: input.participant.id,
        offering_id: input.snapshot.offering.id,
        session_id: input.sessionId,
        team_entry_id: null,
        intent: input.intent,
        quantity: 1,
        application_id: input.applicationId,
        entitlement_definition_id: input.snapshot.entitlementDefinition?.id ?? null,
        equivalence_key: this.evaluator.equivalence(input.snapshot, input.participant.id, input.sessionId),
        eligibility_result: json(input.evaluation.result),
        price_snapshot: price ? json(price) : null,
        policy_references: json(this.evaluator.policyReferences(input.snapshot, input.evaluation.approvalPolicy)),
        requires_approval: input.evaluation.requiresApproval,
        enrollment_id: null,
        outcome: 'pending',
        outcome_reason: null,
      })
      .execute();
    void now;
    const basket = await this.load(trx, organizationId, basketId);
    if (!basket) throw errors.internal('basket vanished');
    return { basket, lineId };
  }

  /** Holds the single line of a basket opened by another command, reusing an existing active hold when given. */
  async holdOpenedBasket(trx: Trx, organizationId: string, basket: BasketRow, lineId: string, actor: Principal, existingHoldIds: readonly string[], expiresAt: Date, correlationId: string | null, trialParticipationId: string | null = null): Promise<{ basket: BasketRow; enrollmentId: string }> {
    const line = (await this.lineRows(trx, organizationId, basket.id)).find((l) => l.id === lineId);
    if (!line) throw errors.internal('basket line vanished');
    for (const holdId of existingHoldIds) {
      await this.capacity.reassignHold(trx, organizationId, holdId, { ownerKind: 'basket', ownerId: lineId, basketId: basket.id }, expiresAt, correlationId);
    }
    const snapshot = await this.evaluator.snapshot(trx, organizationId, line.offering_id);
    const application = line.application_id ? await this.applications.load(trx, organizationId, line.application_id) : undefined;
    const enrollment = await this.enrollments.createPending(trx, organizationId, {
      offeringId: line.offering_id,
      participantPersonId: line.participant_person_id,
      intent: line.intent,
      entitlementDefinitionId: line.entitlement_definition_id,
      equivalenceKey: line.equivalence_key,
      payerPersonId: basket.payer_person_id,
      actor,
      sourceApplicationId: application?.id ?? null,
      basketId: basket.id,
      basketLineId: line.id,
      trialParticipationId,
      priceSnapshot: (line.price_snapshot as unknown as Basket['lines'][number]['price']) ?? null,
      policyReferences: this.evaluator.policyReferences(snapshot, null),
      eligibilityResult: line.eligibility_result as unknown as EligibilityResult,
      correlationId,
    });
    await trx
      .updateTable('basket_lines')
      .set((eb) => ({ outcome: 'held', enrollment_id: enrollment.id, revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', line.id)
      .execute();
    await trx
      .updateTable('baskets')
      .set({ status: 'held', hold_expires_at: expiresAt, revision: basket.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', basket.id)
      .where('revision', '=', basket.revision)
      .execute();
    await this.outbox.enqueue(trx, EnrollmentEvents.basketHeld, {
      organizationId,
      aggregateType: 'basket',
      aggregateId: basket.id,
      correlationId,
      payload: {
        organizationId,
        basketId: basket.id,
        holdIds: [...existingHoldIds],
        enrollmentIds: [enrollment.id],
        expiresAt: expiresAt.toISOString(),
        approvalPending: line.requires_approval && application?.status !== 'accepted',
      },
    });
    const updated = await this.load(trx, organizationId, basket.id);
    if (!updated) throw errors.internal('basket vanished');
    return { basket: updated, enrollmentId: enrollment.id };
  }
}
