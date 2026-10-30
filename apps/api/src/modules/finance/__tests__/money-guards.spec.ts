import { newId } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork, databaseConstraintOf } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { MoneyFacts } from '../services/money-facts.service';
import { createCreditFixture, createObligationFixture } from '../testing/finance-fixtures';
import {
  MINUTE,
  adult,
  basketFor,
  deliver,
  drain,
  financeTestApp,
  offering,
  post,
  processInbox,
  provider,
  quoteFor,
  staff,
  worker,
  type Actor,
} from './support';

const DAY = 24 * 60 * MINUTE;

async function refusedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

/**
 * Payments into an existing obligation beside the checkout and the installment worker
 * (MONEY-01, MONEY-04, MONEY-06, MONEY-07; §4.11, §4.7 invariant 5, SPK-PAY-005/006/007).
 */
describe('money guards: one way to pay a debt at a time (§4.11, SPK-PAY-005/006/007)', () => {
  let t: TestApp;
  let desk: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function checkoutWith(
    token: string,
    price = 10_000,
    extra: Record<string, unknown> = {},
    quoteExtra: Record<string, unknown> = {},
  ) {
    const parent = await adult(t);
    const setup = await offering(t, { basePriceMinor: price });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId, quoteExtra);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: token },
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const obligations = await t.db
      .selectFrom('obligations')
      .select(['id', 'status', 'amount_minor'])
      .where('order_id', '=', res.body.orderId as string)
      .orderBy('due_at')
      .execute();
    return {
      parent,
      checkout: res.body as Record<string, unknown> & { id: string; orderId: string },
      obligationId: obligations[0]?.id as string,
    };
  }

  function tender(obligationId: string, amountMinor: number) {
    return post(t, '/v1/cash-tenders', desk.header, {
      facilityId: t.facilityId,
      obligationId,
      tenderKind: 'cash',
      amountMinor,
      currency: 'USD',
      evidence: { reference: `drawer-${newId().slice(-6)}` },
    });
  }

  async function receiptsOf(orderId: string) {
    return t.db
      .selectFrom('receipts')
      .select(['source_kind', 'amount_minor', 'allocated_minor', 'excess_minor'])
      .where('order_id', '=', orderId)
      .execute();
  }

  it('§4.11, SPK-PAY-005 (MONEY-01): a checkout awaiting payment is paid only through the checkout; its order obligation refuses a direct payment, a tender and a credit', async () => {
    const { parent, checkout, obligationId } = await checkoutWith(FakePaymentTokens.decline);
    expect(checkout.status).toBe('awaiting_payment');
    const direct = await post(t, `/v1/obligations/${obligationId}/payments`, parent.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(direct.status).toBe(409);
    expect(direct.body.details).toEqual({
      code: 'CHECKOUT_PAYMENT_PENDING',
      checkoutId: checkout.id,
    });
    const cash = await tender(obligationId, 10_000);
    expect(cash.status).toBe(409);
    expect(cash.body.details).toMatchObject({ code: 'CHECKOUT_PAYMENT_PENDING' });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 10_000,
    });
    const credit = await post(t, `/v1/credits/${creditId}/redeem`, parent.header, {
      obligationId,
      amountMinor: 10_000,
    });
    expect(credit.status).toBe(409);
    expect(credit.body.details).toMatchObject({ code: 'CHECKOUT_PAYMENT_PENDING' });
    expect(await receiptsOf(checkout.orderId)).toEqual([]);
    // The checkout's own retry pays it, exactly once.
    const retry = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retry.body.status).toBe('completed');
    expect(await receiptsOf(checkout.orderId)).toEqual([
      {
        source_kind: 'payment_attempt',
        amount_minor: 10_000,
        allocated_minor: 10_000,
        excess_minor: 0,
      },
    ]);
  });

  it('§4.11, SPK-PAY-005 (MONEY-01): money that reached the order of a pending checkout by another path is never charged again and never kept silently when the hold expires', async () => {
    const { parent, checkout, obligationId } = await checkoutWith(FakePaymentTokens.decline);
    // A path that bypassed the guard (or a record from before it): a desk tender applied as a
    // plain receipt of the order obligation.
    const facts = t.app.get(MoneyFacts);
    const actor = staffPrincipal(t.organizationId, ['front_desk'], { personId: desk.personId });
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      const tenderId = newId();
      await trx
        .insertInto('cash_tenders')
        .values({
          id: tenderId,
          organization_id: t.organizationId,
          facility_id: t.facilityId,
          tender_kind: 'cash',
          payer_person_id: parent.personId,
          amount_minor: 10_000,
          currency: 'USD',
          obligation_id: obligationId,
          checkout_id: null,
          evidence: json({ reference: 'legacy' }),
          recorded_by: json({ kind: 'staff' }),
          recorded_by_person_id: desk.personId,
          recorded_at: t.clock.now(),
          reconciliation_id: null,
        })
        .execute();
      await facts.recordReceipt(trx, {
        organizationId: t.organizationId,
        sourceKind: 'cash_tender',
        cashTenderId: tenderId,
        payerPersonId: parent.personId,
        amountMinor: 10_000,
        currency: 'USD',
        processorFeeMinor: 0,
        cashAccount: 'cash_on_hand',
        obligationId,
        orderId: checkout.orderId,
        receivedAt: t.clock.now(),
        actor,
        correlationId: null,
      });
    });
    const calls = provider(t).paymentCalls.length;
    const retry = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.details).toMatchObject({ code: 'CHECKOUT_MONEY_RECEIVED' });
    expect(provider(t).paymentCalls.length).toBe(calls);
    // The hold expires: the checkout is aborted, and the money is put in front of finance.
    t.clock.advance(2 * 60 * MINUTE);
    await drain(t);
    const after = await t.http.get(`/v1/registration-checkouts/${checkout.id}`).set(parent.header);
    expect(after.body.status).toBe('aborted');
    const owned = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'severity', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', 'finance.aborted_order_money_received')
      .where('affected_id', '=', checkout.id)
      .executeTakeFirstOrThrow();
    expect(owned).toMatchObject({ owner_queue: 'finance_operator', severity: 'critical' });
    expect(owned.details).toMatchObject({
      orderId: checkout.orderId,
      receipts: [{ amountMinor: 10_000, currency: 'USD' }],
    });
  });

  it('SPK-PAY-007 (MONEY-06): no tender or credit is taken beside a provider charge of the same debt that is in flight or unknown', async () => {
    // The checkout's charge went unknown (a timeout): the desk cannot take cash for that debt.
    const pending = await checkoutWith(FakePaymentTokens.timeout, 5_000);
    expect((pending.checkout['payment'] as { status: string }).status).toBe('unknown');
    const refused = await tender(pending.obligationId, 5_000);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    expect(refused.body.details).toMatchObject({ purpose: 'checkout', status: 'unknown' });

    // A direct payment of a staff-created debt is still processing at the provider.
    const debtor = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor: 4_000,
    });
    const paying = await post(t, `/v1/obligations/${obligationId}/payments`, debtor.header, {
      paymentMethodToken: FakePaymentTokens.processing,
    });
    expect(paying.body.payment.status).toBe('processing');
    const cash = await tender(obligationId, 4_000);
    expect(cash.status).toBe(409);
    expect(cash.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    const creditId = await createCreditFixture(t, {
      ownerPersonId: debtor.personId,
      amountMinor: 4_000,
    });
    const credit = await post(t, `/v1/credits/${creditId}/redeem`, debtor.header, {
      obligationId,
      amountMinor: 4_000,
    });
    expect(credit.status).toBe(409);
    expect(credit.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    // The charge completes: the debt is paid once, with no excess.
    const attemptId = paying.body.payment.id as string;
    provider(t).settlePayment(attemptId, 'succeeded');
    await deliver(t, provider(t).paymentWebhook(attemptId));
    await processInbox(t);
    const receipts = await t.db
      .selectFrom('receipts')
      .select(['amount_minor', 'excess_minor'])
      .where('obligation_id', '=', obligationId)
      .execute();
    expect(receipts).toEqual([{ amount_minor: 4_000, excess_minor: 0 }]);
  });

  it('§4.7 invariant 5 (MONEY-07): the database allows one live charge per debt across installment collection and direct payment', async () => {
    const { parent, checkout } = await checkoutWith(
      FakePaymentTokens.succeed,
      30_000,
      { authorizeFutureInstallments: true },
      { paymentPlan: { kind: 'installments', count: 3 } },
    );
    expect(checkout.status).toBe('completed');
    const second = await t.db
      .selectFrom('installments')
      .innerJoin('installment_plans', 'installment_plans.id', 'installments.plan_id')
      .select(['installments.id as id', 'installments.obligation_id as obligation_id'])
      .where('installment_plans.order_id', '=', checkout.orderId)
      .where('installments.sequence', '=', 2)
      .executeTakeFirstOrThrow();
    const attempt = (purpose: 'obligation' | 'installment', payer: string) =>
      t.db
        .insertInto('payment_attempts')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          purpose,
          checkout_id: null,
          order_id: checkout.orderId,
          obligation_id: second.obligation_id,
          contribution_request_id: null,
          installment_id: purpose === 'installment' ? second.id : null,
          payer_person_id: payer,
          amount_minor: 10_000,
          currency: 'USD',
          provider: 'fake-payments',
          payment_method_ref: 'pm_fake_visa',
          provider_reference: null,
          status: 'processing',
          action_required_payload: null,
          failure_reason: null,
          processor_fee_minor: null,
          evidence_source: null,
          evidence_inbox_event_id: null,
          evidence_sequence: null,
          requested_by: json({ kind: 'system' }),
          requested_by_person_id: null,
          submitted_at: t.clock.now(),
          unknown_since: null,
          resolved_at: null,
        })
        .execute();
    // The payer's direct payment is live ...
    await attempt('obligation', parent.personId);
    // ... so the worker's collection of the same installment is refused by the database ...
    expect(await refusedBy(attempt('installment', parent.personId))).toBe(
      '23505:payment_attempts_live_charge_idx',
    );
    // ... and so is a second payer's direct payment of the same debt.
    const other = await adult(t);
    expect(await refusedBy(attempt('obligation', other.personId))).toBe(
      '23505:payment_attempts_live_charge_idx',
    );
    // The service names the live charge instead of starting another.
    const collect = await post(t, `/v1/installments/${second.id}/collect`, finance.header, {});
    expect(collect.status).toBe(409);
    expect(collect.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
  });

  it('SPK-PAY-006, §4.11 step 10 (MONEY-04): no installment is collected once every registration of the plan was canceled; the finance operator owns the decision', async () => {
    const { parent, checkout } = await checkoutWith(
      FakePaymentTokens.succeed,
      30_000,
      { authorizeFutureInstallments: true },
      { paymentPlan: { kind: 'installments', count: 3 } },
    );
    expect(checkout.status).toBe('completed');
    await drain(t);
    const enrollmentId = (checkout['enrollmentIds'] as string[])[0] as string;
    const current = await t.db
      .selectFrom('enrollments')
      .select('revision')
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    const asked = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'Moving away',
      expectedRevision: current.revision,
    });
    expect(asked.status).toBe(409);
    const consequence = asked.body.details.consequence as {
      kind: string;
      amountMinor: number | null;
      currency: string | null;
    };
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'Moving away',
      expectedRevision: current.revision,
      acceptedConsequence: {
        kind: consequence.kind,
        amountMinor: consequence.amountMinor ?? null,
        currency: consequence.currency ?? null,
      },
    });
    expect(canceled.body.status).toBe('canceled');
    await drain(t);
    const attemptsOfOrder = async () =>
      (
        await t.db
          .selectFrom('payment_attempts')
          .select('purpose')
          .where('order_id', '=', checkout.orderId)
          .execute()
      ).map((a) => a.purpose);
    expect(await attemptsOfOrder()).toEqual(['checkout']);
    t.clock.advance(31 * DAY);
    await drain(t);
    await worker(t).runOnce();
    expect(await attemptsOfOrder()).toEqual(['checkout']);
    const installments = await t.db
      .selectFrom('installments')
      .innerJoin('installment_plans', 'installment_plans.id', 'installments.plan_id')
      .select([
        'installments.id as id',
        'installments.sequence as sequence',
        'installments.status as status',
        'installment_plans.id as plan_id',
      ])
      .where('installment_plans.order_id', '=', checkout.orderId)
      .orderBy('installments.sequence')
      .execute();
    expect(installments.map((i) => i.status)).toEqual(['paid', 'scheduled', 'scheduled']);
    const owned = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'affected_type'])
      .where('category', '=', 'finance.installment_registration_canceled')
      .where('affected_id', '=', installments[0]?.plan_id as string)
      .execute();
    expect(owned).toEqual([{ owner_queue: 'finance_operator', affected_type: 'installment_plan' }]);
    // Staff collection is refused the same way; nothing is charged.
    const manual = await post(
      t,
      `/v1/installments/${installments[1]?.id as string}/collect`,
      finance.header,
      {},
    );
    expect(manual.status).toBe(409);
    expect(manual.body.details).toMatchObject({ code: 'INSTALLMENT_REGISTRATION_CANCELED' });
    expect(await attemptsOfOrder()).toEqual(['checkout']);
  });
});
