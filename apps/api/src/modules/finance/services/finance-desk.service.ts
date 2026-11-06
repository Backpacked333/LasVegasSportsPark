import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type BasketPrice,
  type CreatePaymentReminderInput,
  type LinePolicyReferences,
  type PaymentReminder,
  type PersonMoneySummary,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  PRICING_PORT,
  type OfferingLookupPort,
  type PricingPort,
} from '../../catalog';
import { BASKET_PORT, type BasketPort } from '../../enrollment';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { FinanceActions } from '../finance.actions';
import { PaymentReminderRequested } from '../finance.events';
import { PAYMENT_REMINDER_MIN_INTERVAL_HOURS } from '../finance.policy';
import { iso, organizationOf } from '../finance.shared';
import { computeQuote, type QuoteLineInput } from '../pricing/quote-calculator';
import { FinanceCustomerScope } from './customer-scope';
import { quotableLines } from './quotes.service';

type Amounts = Map<string, number>;

function add(totals: Amounts, currency: string, amountMinor: number): void {
  totals.set(currency, (totals.get(currency) ?? 0) + amountMinor);
}

function list(totals: Amounts): Array<{ currency: string; amountMinor: number }> {
  return [...totals.entries()]
    .filter(([, amountMinor]) => amountMinor !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) -
    Math.floor(instant / 1000) * 1000
  );
}

/** The instant local midnight of 1 January of `now`'s local year begins in `timeZone`. */
export function localYearStart(now: Date, timeZone: string): Date {
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(now));
  const guess = Date.UTC(year, 0, 1);
  let instant = guess - zoneOffset(guess, timeZone);
  instant = guess - zoneOffset(instant, timeZone);
  return new Date(instant);
}

/**
 * Finance desk reads and commands for the redesigned staff screens (park UI redesign gaps):
 *
 * - **Payment reminders** (SPK-COMMS-002 "payment attention", SPK-PAY-004/006): finance staff ask
 *   for the debtor of an open, past-due obligation with a balance to be reminded. The reminder is
 *   recorded (migration 0685, append-only, database-checked past due and positive balance), audited
 *   and announced; finance's own handler composes the essential notice through communications
 *   (FinanceNotices.paymentReminder), which resolves recipients from current permissions. Two
 *   reminders for one obligation are at least PAYMENT_REMINDER_MIN_INTERVAL_HOURS apart (an
 *   engineering placeholder pending DEC-012 / DEC-062).
 * - **Person money summary** (§4.10 protected): the account balance of open obligations, credits
 *   and receipts this year, per currency, over the person and every record merged into them.
 * - **Basket price** (SPK-PAY-001/002): the order's figures once a basket is checked out, else an
 *   estimate from catalog price rules and approved charges in effect now, before discounts and
 *   credits; never stored, never a quote.
 */
@Injectable()
export class FinanceDeskService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BASKET_PORT) private readonly baskets: BasketPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facilities: FacilityDirectory,
    private readonly scope: FinanceCustomerScope,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Payment reminders
  // -------------------------------------------------------------------------------------------

  async remind(
    principal: Principal,
    obligationId: string,
    input: CreatePaymentReminderInput,
    correlationId: string | null,
  ): Promise<PaymentReminder> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const obligation = await trx
        .selectFrom('obligations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', obligationId)
        .forUpdate()
        .executeTakeFirst();
      // §4.10: an obligation is customer-private; finance staff hold the action, nobody else does.
      const decision = await this.authorization.decide(
        principal,
        FinanceActions.sendPaymentReminder,
        { type: 'obligation', id: obligationId, organizationId },
      );
      if (!obligation || !decision.allowed) {
        if (obligation && principal.kind === 'staff') {
          await this.authorization.require(principal, FinanceActions.sendPaymentReminder, {
            type: 'obligation',
            id: obligationId,
            organizationId,
          });
        }
        throw errors.protectedNotFound('obligation');
      }
      if (obligation.status !== 'open') {
        throw errors.invalidTransition('Obligation', obligation.status, 'remind');
      }
      const now = this.clock.now();
      const remaining = Number(obligation.amount_minor) - Number(obligation.allocated_minor);
      if (remaining <= 0) {
        throw errors.resourceConflict('Nothing is left to pay on this obligation.', {
          code: 'NOTHING_OUTSTANDING',
        });
      }
      if (new Date(obligation.due_at).getTime() >= now.getTime()) {
        throw errors.resourceConflict('The obligation is not past due yet.', {
          code: 'OBLIGATION_NOT_PAST_DUE',
          dueAt: iso(obligation.due_at),
        });
      }
      const recipient =
        obligation.debtor_kind === 'person'
          ? obligation.debtor_person_id
          : obligation.responsible_payer_person_id;
      if (!recipient) {
        throw errors.resourceConflict(
          'A team obligation without a responsible payer has nobody to remind; its captain is asked for contributions instead.',
          { code: 'NO_REMINDER_RECIPIENT' },
        );
      }
      const last = await trx
        .selectFrom('payment_reminders')
        .select('requested_at')
        .where('organization_id', '=', organizationId)
        .where('obligation_id', '=', obligation.id)
        .orderBy('requested_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const interval = PAYMENT_REMINDER_MIN_INTERVAL_HOURS * 3_600_000;
      if (last && now.getTime() - new Date(last.requested_at).getTime() < interval) {
        throw errors.resourceConflict('A reminder was sent for this obligation recently.', {
          code: 'REMINDED_RECENTLY',
          lastReminderAt: iso(last.requested_at),
          nextReminderAfter: iso(new Date(new Date(last.requested_at).getTime() + interval)),
        });
      }
      const recipientPersonId = await this.scope.subjectOf(organizationId, recipient, trx);
      const id = newId();
      await trx
        .insertInto('payment_reminders')
        .values({
          id,
          organization_id: organizationId,
          obligation_id: obligation.id,
          currency: obligation.currency,
          remaining_minor: remaining,
          due_at: obligation.due_at,
          recipient_person_id: recipientPersonId,
          reason: input.reason ?? null,
          requested_by: json(snapshotActor(principal)),
          requested_by_person_id: principal.personId ?? null,
          requested_at: now,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.sendPaymentReminder.id,
        targetType: 'obligation',
        targetId: obligation.id,
        reason: input.reason ?? null,
        correlationId,
        details: { reminderId: id, remainingMinor: remaining, currency: obligation.currency },
      });
      await this.outbox.enqueue(trx, PaymentReminderRequested, {
        organizationId,
        aggregateType: 'obligation',
        aggregateId: obligation.id,
        payload: {
          organizationId,
          reminderId: id,
          obligationId: obligation.id,
          recipientPersonId,
          remainingMinor: remaining,
          currency: obligation.currency,
          dueAt: iso(obligation.due_at),
        },
        correlationId,
      });
      return {
        id,
        obligationId: obligation.id,
        recipientPersonId,
        remainingMinor: remaining,
        currency: obligation.currency,
        dueAt: iso(obligation.due_at),
        reason: input.reason ?? null,
        requestedByPersonId: principal.personId ?? null,
        requestedAt: iso(now),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Person money summary (§4.10 protected)
  // -------------------------------------------------------------------------------------------

  async personMoney(principal: Principal, personId: string): Promise<PersonMoneySummary> {
    const organizationId = organizationOf(principal);
    const person = await this.persons.findPerson(organizationId, personId);
    if (!person) throw errors.protectedNotFound('person');
    const decision = await this.authorization.decide(principal, FinanceActions.readPersonMoney, {
      type: 'person_money',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    if (!decision.allowed) throw errors.protectedNotFound('person');
    const ids = await this.scope.idsOf(organizationId, personId);
    const now = this.clock.now();

    const obligations = await this.db
      .selectFrom('obligations')
      .select(['currency', 'amount_minor', 'allocated_minor', 'due_at'])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'open')
      .where((eb) =>
        eb.or([
          eb.and([eb('debtor_kind', '=', 'person'), eb('debtor_person_id', 'in', ids)]),
          eb.and([
            eb('debtor_kind', '=', 'team_entry'),
            eb('responsible_payer_person_id', 'in', ids),
          ]),
        ]),
      )
      .execute();
    const balance: Amounts = new Map();
    let open = 0;
    let pastDue = 0;
    for (const o of obligations) {
      const remaining = Number(o.amount_minor) - Number(o.allocated_minor);
      if (remaining <= 0) continue;
      open += 1;
      if (new Date(o.due_at).getTime() < now.getTime()) pastDue += 1;
      add(balance, o.currency, remaining);
    }

    const credits = await this.db
      .selectFrom('credits')
      .select(['currency', 'remaining_minor', 'status', 'expires_at'])
      .where('organization_id', '=', organizationId)
      .where('owner_person_id', 'in', ids)
      .where('status', 'in', ['active', 'pending_approval'])
      .execute();
    const available: Amounts = new Map();
    const pending: Amounts = new Map();
    for (const c of credits) {
      if (c.expires_at && new Date(c.expires_at).getTime() <= now.getTime()) continue;
      add(c.status === 'active' ? available : pending, c.currency, Number(c.remaining_minor));
    }

    // "This year": the facility zone when every facility shares one, else UTC (said in the response).
    const zones = [...new Set((await this.facilities.list(organizationId)).map((f) => f.timezone))];
    const yearTimeZone = zones.length === 1 ? (zones[0] as string) : 'UTC';
    const since = localYearStart(now, yearTimeZone);
    const receipts = await this.db
      .selectFrom('receipts')
      .select(['currency', (eb) => eb.fn.sum<number>('amount_minor').as('total')])
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', ids)
      .where('received_at', '>=', since)
      .where('received_at', '<=', now)
      .groupBy('currency')
      .execute();
    const paid: Amounts = new Map();
    for (const r of receipts) add(paid, r.currency, Number(r.total));
    const refunds = await this.db
      .selectFrom('refund_attempts as r')
      .innerJoin('payment_attempts as p', (join) =>
        join
          .onRef('p.organization_id', '=', 'r.organization_id')
          .onRef('p.id', '=', 'r.payment_attempt_id'),
      )
      .select(['r.currency', (eb) => eb.fn.sum<number>('r.amount_minor').as('total')])
      .where('r.organization_id', '=', organizationId)
      .where('p.payer_person_id', 'in', ids)
      .where('r.status', '=', 'succeeded')
      .where('r.reversed_at', 'is', null)
      .where(sql<boolean>`coalesce(r.resolved_at, r.updated_at) >= ${since}`)
      .groupBy('r.currency')
      .execute();
    const refunded: Amounts = new Map();
    for (const r of refunds) add(refunded, r.currency, Number(r.total));

    return {
      personId,
      accountBalance: list(balance),
      openObligations: open,
      pastDueObligations: pastDue,
      creditsAvailable: list(available),
      creditsPendingApproval: list(pending),
      paidThisYear: list(paid),
      refundedThisYear: list(refunded),
      paidSince: iso(since),
      yearTimeZone,
      asOf: iso(now),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Basket price (booking requests)
  // -------------------------------------------------------------------------------------------

  async basketPrice(principal: Principal, basketId: string): Promise<BasketPrice> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const basket = await this.baskets.getBasket(organizationId, basketId);
    if (!basket) throw errors.protectedNotFound('basket');
    const payer = basket.payerPersonId ?? basket.ownerPersonId;
    const decision = await this.authorization.decide(principal, FinanceActions.readQuote, {
      type: 'basket',
      id: basket.id,
      organizationId,
      subjectPersonIds: [payer],
      protected: true,
    });
    if (!decision.allowed) throw errors.protectedNotFound('basket');

    const order = await this.db
      .selectFrom('orders')
      .select(['id', 'currency', 'total_minor', 'payment_status'])
      .where('organization_id', '=', organizationId)
      .where('basket_id', '=', basket.id)
      .where('canceled_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (order) {
      const sums = await this.db
        .selectFrom('order_lines')
        .select((eb) => [
          eb.fn.coalesce(eb.fn.sum<number>('base_amount_minor'), eb.lit(0)).as('base'),
          eb.fn.coalesce(eb.fn.sum<number>('tax_minor'), eb.lit(0)).as('tax'),
          eb.fn.coalesce(eb.fn.sum<number>('fee_minor'), eb.lit(0)).as('fee'),
        ])
        .where('organization_id', '=', organizationId)
        .where('order_id', '=', order.id)
        .executeTakeFirst();
      return {
        basketId: basket.id,
        basis: 'order',
        currency: order.currency,
        subtotalMinor: Number(sums?.base ?? 0),
        taxMinor: Number(sums?.tax ?? 0),
        feeMinor: Number(sums?.fee ?? 0),
        totalMinor: Number(order.total_minor),
        orderId: order.id,
        paymentStatus: order.payment_status,
        asOf: iso(now),
      };
    }

    const quotable = quotableLines(basket);
    const lines =
      quotable.length > 0
        ? quotable
        : basket.lines.filter((l) => l.outcome !== 'failed' && l.outcome !== 'released');
    const unpriced = (): BasketPrice => ({
      basketId: basket.id,
      basis: 'unpriced',
      currency: basket.currency,
      subtotalMinor: null,
      taxMinor: null,
      feeMinor: null,
      totalMinor: null,
      orderId: null,
      paymentStatus: null,
      asOf: iso(now),
    });
    if (lines.length === 0) return unpriced();
    const inputs: QuoteLineInput[] = [];
    let currency: string | null = null;
    for (const line of lines) {
      const rule = await this.pricing.effectivePriceRule(organizationId, line.offeringId, now);
      if (!rule) return unpriced();
      currency ??= rule.currency;
      if (rule.currency !== currency) return unpriced();
      const snapshot = await this.offerings.getOffering(organizationId, line.offeringId, now);
      const policies: LinePolicyReferences = {
        eligibilityPolicyVersionId: line.policies.eligibilityPolicyVersionId,
        cancellationPolicyVersionId: line.policies.cancellationPolicyVersionId,
        requiredFormPolicyVersionIds: line.policies.requiredFormPolicyVersionIds,
        approvalPolicyVersionId: line.policies.approvalPolicyVersionId ?? null,
      };
      inputs.push({
        basketLineId: line.id,
        participantPersonId: line.participantPersonId,
        offeringId: line.offeringId,
        description: snapshot?.offering.name ?? 'Booking',
        quantity: line.quantity,
        priceRule: {
          id: rule.id,
          basePriceMinor: rule.basePriceMinor,
          currency: rule.currency,
          chargeLines: rule.chargeLines,
        },
        policies,
        equivalenceKey: line.equivalenceKey,
        enrollmentId: line.enrollmentId,
      });
    }
    try {
      const computed = computeQuote({
        currency: currency as string,
        lines: inputs,
        discountEvaluation: null,
        credits: [],
        plan: { kind: 'full' },
        now,
      });
      return {
        basketId: basket.id,
        basis: 'estimate',
        currency: computed.currency,
        subtotalMinor: computed.subtotalMinor,
        taxMinor: computed.taxMinor,
        feeMinor: computed.feeMinor,
        totalMinor: computed.totalMinor,
        orderId: null,
        paymentStatus: null,
        asOf: iso(now),
      };
    } catch (error) {
      if (DomainError.is(error) && error.code === 'VALIDATION_FAILED') return unpriced();
      throw error;
    }
  }
}
