import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import {
  createCapturedPaymentFixture,
  createCreditFixture,
  createObligationFixture,
} from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  financeTestApp,
  offering,
  post,
  quoteFor,
  rejectsWith,
  type Actor,
} from './support';

const RESTRICT = '23001';
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const ACTOR = json({ kind: 'system', actorLabel: 'schema-test' });

describe('finance database guarantees (§4.7 invariants 5, 6, 7; SPK-PAY-004/008/009/010)', () => {
  let t: TestApp;
  let payer: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    payer = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-010: journals and journal entries are append-only', async () => {
    const { receiptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    const journal = await t.db
      .selectFrom('journals')
      .select('id')
      .where('source_id', '=', receiptId)
      .executeTakeFirstOrThrow();
    expect(
      await rejectsWith(
        t.db
          .updateTable('journals')
          .set({ description: 'edited' })
          .where('id', '=', journal.id)
          .execute(),
      ),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(t.db.deleteFrom('journals').where('id', '=', journal.id).execute()),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        t.db
          .updateTable('journal_entries')
          .set({ debit_minor: 1 })
          .where('journal_id', '=', journal.id)
          .execute(),
      ),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        t.db.deleteFrom('journal_entries').where('journal_id', '=', journal.id).execute(),
      ),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        t.db.updateTable('receipts').set({ amount_minor: 1 }).where('id', '=', receiptId).execute(),
      ),
    ).toBe(RESTRICT);
  });

  it('SPK-PAY-010: an unbalanced journal is refused at commit; a line is a debit or a credit; one posting per fact', async () => {
    const insertJournal = (id: string, sourceId: string) =>
      sql`insert into journals (id, organization_id, source_type, source_id, purpose, description, currency, posted_at, posted_by)
          values (${id}, ${t.organizationId}, 'manual', ${sourceId}, 'test', 'test', 'USD', now(), ${JSON.stringify({ kind: 'system' })}::jsonb)`;
    const entry = (
      journalId: string,
      line: number,
      account: string,
      debit: number,
      credit: number,
    ) =>
      sql`insert into journal_entries (id, organization_id, journal_id, line_number, account_code, debit_minor, credit_minor, currency)
          values (${newId()}, ${t.organizationId}, ${journalId}, ${line}, ${account}, ${debit}, ${credit}, 'USD')`;
    const unbalanced = newId();
    expect(
      await rejectsWith(
        t.db.transaction().execute(async (trx) => {
          await insertJournal(unbalanced, newId()).execute(trx);
          await entry(unbalanced, 1, 'cash_processor', 100, 0).execute(trx);
          await entry(unbalanced, 2, 'customer_receivable', 0, 50).execute(trx);
        }),
      ),
    ).toBe(CHECK);
    const twoSided = newId();
    expect(
      await rejectsWith(
        t.db.transaction().execute(async (trx) => {
          await insertJournal(twoSided, newId()).execute(trx);
          await entry(twoSided, 1, 'cash_processor', 100, 100).execute(trx);
        }),
      ),
    ).toBe(CHECK);
    const source = newId();
    const balanced = newId();
    await t.db.transaction().execute(async (trx) => {
      await insertJournal(balanced, source).execute(trx);
      await entry(balanced, 1, 'cash_processor', 100, 0).execute(trx);
      await entry(balanced, 2, 'customer_receivable', 0, 100).execute(trx);
    });
    expect(
      await rejectsWith(
        t.db.transaction().execute(async (trx) => {
          const again = newId();
          await insertJournal(again, source).execute(trx);
          await entry(again, 1, 'cash_processor', 100, 0).execute(trx);
          await entry(again, 2, 'customer_receivable', 0, 100).execute(trx);
        }),
      ),
    ).toBe(UNIQUE);
  });

  it('§4.7 invariant 6 / SPK-PAY-008: refunded + reserved can never exceed captured', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_refundables')
          .set({ reserved_minor: 1_001 })
          .where('payment_attempt_id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
    await t.db
      .updateTable('payment_refundables')
      .set({ refunded_minor: 600, reserved_minor: 400 })
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute();
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_refundables')
          .set({ reserved_minor: 401 })
          .where('payment_attempt_id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
    // Refunded money never "comes back" by an update; the captured ceiling is fixed.
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_refundables')
          .set({ refunded_minor: 0 })
          .where('payment_attempt_id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_refundables')
          .set({ captured_minor: 5_000 })
          .where('payment_attempt_id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
  });

  it('§4.7 invariant 7 / SPK-PAY-009: a credit never goes below zero and its balance always equals its history', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    expect(
      await rejectsWith(
        t.db
          .updateTable('credits')
          .set({ remaining_minor: -1 })
          .where('id', '=', creditId)
          .execute(),
      ),
    ).toBe(CHECK);
    // Consuming balance without a redemption row is refused at commit (nobody overwrites balances).
    expect(
      await rejectsWith(
        t.db
          .updateTable('credits')
          .set({ remaining_minor: 500 })
          .where('id', '=', creditId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('credits')
          .set({ original_minor: 9_000 })
          .where('id', '=', creditId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .insertInto('credit_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            credit_id: creditId,
            kind: 'reversal',
            amount_minor: 10,
            currency: 'USD',
            reference_type: 'test',
            reference_id: newId(),
            reverses_redemption_id: null,
            actor: ACTOR,
            redeemed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe(CHECK);
  });

  it('SPK-PAY-004: allocations never exceed the obligation and always equal its allocated amount', async () => {
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 1_000,
    });
    expect(
      await rejectsWith(
        t.db
          .updateTable('obligations')
          .set({ allocated_minor: 1_001 })
          .where('id', '=', obligationId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('obligations')
          .set({ allocated_minor: 400 })
          .where('id', '=', obligationId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('obligations')
          .set({ amount_minor: 5 })
          .where('id', '=', obligationId)
          .execute(),
      ),
    ).toBe(CHECK);
    // A contribution request can only point at a team obligation with contributions (no debt copies).
    expect(
      await rejectsWith(
        t.db
          .insertInto('contribution_requests')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            obligation_id: obligationId,
            requested_person_id: payer.personId,
            requested_by: ACTOR,
            requested_by_person_id: null,
            amount_minor: 100,
            currency: 'USD',
            message: null,
            receipt_id: null,
            paid_at: null,
            canceled_at: null,
            cancel_reason: null,
          })
          .execute(),
      ),
    ).toBe(FOREIGN_KEY);
    // Organization scope: a debtor from another organization is refused by the composite key.
    const other = await seedOrganization(t.db);
    const foreigner = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    expect(
      await rejectsWith(createObligationFixture(t, { debtorPersonId: foreigner, amountMinor: 10 })),
    ).toBe(FOREIGN_KEY);
  });

  it('PaymentAttemptMachine: terminal states never flip; no second live attempt; card data is refused', async () => {
    const { paymentAttemptId, obligationId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_attempts')
          .set({ status: 'failed' })
          .where('id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_attempts')
          .set({ amount_minor: 1 })
          .where('id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe(CHECK);
    const attempt = (ref: string) => ({
      id: newId(),
      organization_id: t.organizationId,
      purpose: 'obligation' as const,
      checkout_id: null,
      order_id: null,
      obligation_id: obligationId,
      contribution_request_id: null,
      installment_id: null,
      payer_person_id: payer.personId,
      amount_minor: 100,
      currency: 'USD',
      provider: 'fake-payments',
      payment_method_ref: ref,
      provider_reference: null,
      action_required_payload: null,
      failure_reason: null,
      processor_fee_minor: null,
      evidence_source: null,
      evidence_inbox_event_id: null,
      evidence_sequence: null,
      requested_by: ACTOR,
      requested_by_person_id: null,
      submitted_at: null,
      unknown_since: null,
      resolved_at: null,
    });
    expect(
      await rejectsWith(
        t.db.insertInto('payment_attempts').values(attempt('pm_4111111111111111')).execute(),
      ),
    ).toBe(CHECK);
    await t.db.insertInto('payment_attempts').values(attempt(FakePaymentTokens.succeed)).execute();
    // SPK-PAY-007: a second live attempt by the same payer for the same obligation is refused.
    expect(
      await rejectsWith(
        t.db.insertInto('payment_attempts').values(attempt(FakePaymentTokens.succeed)).execute(),
      ),
    ).toBe(UNIQUE);
    // Invariant 5: one receipt per payment fact.
    const receipt = await t.db
      .selectFrom('receipts')
      .selectAll()
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow();
    expect(
      await rejectsWith(
        t.db
          .insertInto('receipts')
          .values({ ...receipt, id: newId(), created_at: undefined })
          .execute(),
      ),
    ).toBe(UNIQUE);
  });

  it('§4.7 invariant 5 / SPK-PAY-007: the database allows one live checkout or installment charge per obligation', async () => {
    const setup = await offering(t, { basePriceMinor: 30_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.processing },
      authorizeFutureInstallments: true,
    });
    expect(res.body).toMatchObject({
      status: 'awaiting_payment',
      payment: { status: 'processing' },
    });
    const charge = await t.db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('checkout_id', '=', res.body.id as string)
      .executeTakeFirstOrThrow();
    const first = await t.db
      .selectFrom('installments')
      .select(['id', 'obligation_id'])
      .where('obligation_id', '=', charge.obligation_id as string)
      .executeTakeFirstOrThrow();
    expect(first.obligation_id).toBe(charge.obligation_id);
    // An installment charge of the same debt while the checkout's charge is live is refused.
    expect(
      await rejectsWith(
        t.db
          .insertInto('payment_attempts')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            purpose: 'installment',
            checkout_id: null,
            order_id: charge.order_id,
            obligation_id: first.obligation_id,
            contribution_request_id: null,
            installment_id: first.id,
            payer_person_id: payer.personId,
            amount_minor: 10_000,
            currency: 'USD',
            provider: 'fake-payments',
            payment_method_ref: FakePaymentTokens.succeed,
            provider_reference: null,
            action_required_payload: null,
            failure_reason: null,
            processor_fee_minor: null,
            evidence_source: null,
            evidence_inbox_event_id: null,
            evidence_sequence: null,
            requested_by: ACTOR,
            requested_by_person_id: null,
            submitted_at: null,
            unknown_since: null,
            resolved_at: null,
          })
          .execute(),
      ),
    ).toBe(UNIQUE);
  });

  it('CheckoutMachine and quotes: a completed checkout never moves again and a quote keeps its price basis', async () => {
    const setup = await offering(t, { basePriceMinor: 2_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId);
    expect(
      await rejectsWith(
        t.db.updateTable('quotes').set({ total_minor: 1 }).where('id', '=', quote.id).execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('quote_lines')
          .set({ unit_price_minor: 1 })
          .where('quote_id', '=', quote.id)
          .execute(),
      ),
    ).toBe(RESTRICT);
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.body.status).toBe('completed');
    expect(
      await rejectsWith(
        t.db
          .updateTable('checkouts')
          .set({ status: 'aborted' })
          .where('id', '=', res.body.id as string)
          .execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db.updateTable('quotes').set({ status: 'active' }).where('id', '=', quote.id).execute(),
      ),
    ).toBe(CHECK);
    expect(
      await rejectsWith(
        t.db
          .updateTable('orders')
          .set({ total_minor: 1 })
          .where('id', '=', res.body.orderId as string)
          .execute(),
      ),
    ).toBe(CHECK);
    // Invariant 2 at the money boundary: one checkout per quote.
    const row = await t.db
      .selectFrom('checkouts')
      .selectAll()
      .where('id', '=', res.body.id as string)
      .executeTakeFirstOrThrow();
    expect(
      await rejectsWith(
        t.db
          .insertInto('checkouts')
          .values({
            ...row,
            id: newId(),
            order_id: row.order_id,
            hold_ids: json([]),
            enrollment_ids: json([]),
            requested_by: ACTOR,
            failure_details: null,
            recovery: null,
            created_at: undefined,
            updated_at: undefined,
          })
          .execute(),
      ),
    ).toBe(UNIQUE);
  });
});
