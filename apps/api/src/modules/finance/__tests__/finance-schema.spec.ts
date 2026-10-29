import { newId } from '@sportspark/contracts';
import { json, pgConstraintName, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
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

  it('SPK-PAY-004/005, §4.7 invariant 5: a receipt cannot be allocated again after its own transaction, nor in another currency', async () => {
    const constraintOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return pgConstraintName(error);
      }
      throw new Error('expected the database to reject the statement');
    };
    const now = t.clock.now();
    const allocation = (
      obligationId: string,
      receiptId: string,
      amount: number,
      currency: string,
    ) => ({
      id: newId(),
      organization_id: t.organizationId,
      obligation_id: obligationId,
      source_kind: 'receipt' as const,
      receipt_id: receiptId,
      credit_redemption_id: null,
      amount_minor: amount,
      currency,
      allocated_at: now,
    });
    const settle = (obligationId: string, amount: number) => ({
      table: 'obligations' as const,
      set: { allocated_minor: amount, status: 'settled' as const, settled_at: now },
      id: obligationId,
    });

    // 1. A fully allocated 1,000 USD receipt settles a second 1,000 USD obligation in a later
    // transaction: the obligation side balances, the receipt side would count the money twice.
    const { receiptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    const second = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 1_000,
    });
    const again = settle(second, 1_000);
    expect(
      await constraintOf(
        t.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('payment_allocations')
            .values(allocation(second, receiptId, 1_000, 'USD'))
            .execute();
          await trx.updateTable(again.table).set(again.set).where('id', '=', again.id).execute();
        }),
      ),
    ).toBe('receipts_allocations_consistent');
    const allocations = await t.db
      .selectFrom('payment_allocations')
      .select('obligation_id')
      .where('receipt_id', '=', receiptId)
      .execute();
    expect(allocations).toHaveLength(1);

    // 2. A 500 EUR receipt allocated in its own transaction as 500 USD to a USD obligation: the
    // amounts match on both sides, only the currency differs.
    const usd = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 500,
    });
    const attemptId = newId();
    const journalId = newId();
    const euroReceipt = newId();
    const paid = settle(usd, 500);
    expect(
      await constraintOf(
        t.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('payment_attempts')
            .values({
              id: attemptId,
              organization_id: t.organizationId,
              purpose: 'obligation',
              checkout_id: null,
              order_id: null,
              obligation_id: usd,
              contribution_request_id: null,
              installment_id: null,
              payer_person_id: payer.personId,
              amount_minor: 500,
              currency: 'EUR',
              provider: 'fake-payments',
              payment_method_ref: 'pm_fake_visa',
              provider_reference: `fp_${attemptId}`,
              status: 'succeeded',
              action_required_payload: null,
              failure_reason: null,
              processor_fee_minor: 0,
              evidence_source: 'sync_response',
              evidence_inbox_event_id: null,
              evidence_sequence: null,
              requested_by: ACTOR,
              requested_by_person_id: null,
              submitted_at: now,
              unknown_since: null,
              resolved_at: now,
            })
            .execute();
          await trx
            .insertInto('journals')
            .values({
              id: journalId,
              organization_id: t.organizationId,
              source_type: 'receipt',
              source_id: euroReceipt,
              purpose: 'payment_received',
              description: 'schema test',
              currency: 'EUR',
              reversal_of_journal_id: null,
              posted_at: now,
              posted_by: ACTOR,
              correlation_id: null,
              operation_id: null,
            })
            .execute();
          await trx
            .insertInto('journal_entries')
            .values(
              (
                [
                  ['cash_processor', 500, 0],
                  ['customer_receivable', 0, 500],
                ] as const
              ).map(([account, debit, credit], index) => ({
                id: newId(),
                organization_id: t.organizationId,
                journal_id: journalId,
                line_number: index + 1,
                account_code: account,
                debit_minor: debit,
                credit_minor: credit,
                currency: 'EUR',
                person_id: null,
                order_id: null,
                obligation_id: null,
                reversal_of_entry_id: null,
                memo: null,
              })),
            )
            .execute();
          await trx
            .insertInto('receipts')
            .values({
              id: euroReceipt,
              organization_id: t.organizationId,
              source_kind: 'payment_attempt',
              payment_attempt_id: attemptId,
              cash_tender_id: null,
              payer_person_id: payer.personId,
              amount_minor: 500,
              allocated_minor: 500,
              excess_minor: 0,
              currency: 'EUR',
              processor_fee_minor: 0,
              order_id: null,
              obligation_id: usd,
              journal_id: journalId,
              received_at: now,
            })
            .execute();
          await trx
            .insertInto('payment_allocations')
            .values(allocation(usd, euroReceipt, 500, 'USD'))
            .execute();
          await trx.updateTable(paid.table).set(paid.set).where('id', '=', paid.id).execute();
        }),
      ),
    ).toBe('receipts_allocations_consistent');
  });

  /** The constraint the database names when it refuses the statement. */
  async function refusedBy(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error) {
      return pgConstraintName(error);
    }
    throw new Error('expected the database to reject the statement');
  }

  /** Inserts a copy of an existing row with some columns changed (constraints still apply). */
  function copyRow(table: string, sourceId: string, changes: Record<string, unknown>) {
    return sql`insert into ${sql.table(table)}
      select (jsonb_populate_record(null::${sql.table(table)}, to_jsonb(s) || ${JSON.stringify(changes)}::jsonb)).*
      from ${sql.table(table)} s where s.id = ${sourceId}`.execute(t.db);
  }

  /** A completed registration checkout with a three-installment plan, all in USD. */
  async function completedPlanCheckout() {
    const setup = await offering(t, { basePriceMinor: 9_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.body.status).toBe('completed');
    const orderId = res.body.orderId as string;
    const plan = await t.db
      .selectFrom('installment_plans')
      .select('id')
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    return { quoteId: quote.id, orderId, planId: plan.id, checkoutId: res.body.id as string };
  }

  it('SPK-PAY-001 (migration 0603): a money row that draws on another record carries that record’s currency', async () => {
    const a = await completedPlanCheckout();
    const b = await completedPlanCheckout();
    const now = t.clock.now();
    // quote and order lines carry their quote's and order's currency
    const quoteLine = await t.db
      .selectFrom('quote_lines')
      .select('id')
      .where('quote_id', '=', a.quoteId)
      .executeTakeFirstOrThrow();
    expect(
      await refusedBy(
        copyRow('quote_lines', quoteLine.id, {
          id: newId(),
          quote_id: b.quoteId,
          sequence: 99,
          currency: 'EUR',
        }),
      ),
    ).toBe('quote_lines_quote_currency_fk');
    const orderLine = await t.db
      .selectFrom('order_lines')
      .select('id')
      .where('order_id', '=', a.orderId)
      .executeTakeFirstOrThrow();
    expect(
      await refusedBy(
        copyRow('order_lines', orderLine.id, {
          id: newId(),
          order_id: b.orderId,
          sequence: 99,
          currency: 'EUR',
        }),
      ),
    ).toBe('order_lines_order_currency_fk');
    // an installment carries its plan's and its obligation's currency
    const installment = await t.db
      .selectFrom('installments')
      .select('id')
      .where('plan_id', '=', a.planId)
      .where('sequence', '=', 2)
      .executeTakeFirstOrThrow();
    const euroDebt = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 3_000,
      currency: 'EUR',
    });
    expect(
      await refusedBy(
        copyRow('installments', installment.id, {
          id: newId(),
          sequence: 99,
          obligation_id: euroDebt,
          currency: 'EUR',
        }),
      ),
    ).toBe('installments_plan_currency_fk');
    expect(
      await refusedBy(
        copyRow('installments', installment.id, {
          id: newId(),
          sequence: 99,
          obligation_id: euroDebt,
        }),
      ),
    ).toBe('installments_obligation_currency_fk');
    // a USD credit is never consumed as EUR
    const creditId = await createCreditFixture(t, {
      ownerPersonId: payer.personId,
      amountMinor: 5_000,
    });
    expect(
      await refusedBy(
        t.db
          .insertInto('credit_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            credit_id: creditId,
            kind: 'redeem',
            amount_minor: 50,
            currency: 'EUR',
            reference_type: 'obligation',
            reference_id: euroDebt,
            reverses_redemption_id: null,
            actor: ACTOR,
            redeemed_at: now,
          })
          .execute(),
      ),
    ).toBe('credit_redemptions_credit_currency_fk');
    // a USD payment is never refunded in EUR
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    expect(
      await refusedBy(
        t.db
          .insertInto('refund_attempts')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            payment_attempt_id: paymentAttemptId,
            amount_minor: 1_000_000,
            currency: 'EUR',
            checkout_id: null,
            reason: 'schema test',
            provider: 'fake-payments',
            provider_reference: null,
            failure_reason: null,
            evidence_source: null,
            evidence_inbox_event_id: null,
            evidence_sequence: null,
            requested_by: ACTOR,
            requested_by_person_id: null,
            operation_id: null,
            submitted_at: null,
            unknown_since: null,
            resolved_at: null,
          })
          .execute(),
      ),
    ).toBe('refund_attempts_payment_currency_fk');
    // a contribution request carries its team obligation's currency
    const competitionId = await createCompetitionFixture(t);
    const { seasonId } = await createSeasonFixture(t, { competitionId });
    const { teamEntryId } = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: payer.personId,
    });
    const teamDebt = await createObligationFixture(t, {
      debtorTeamEntryId: teamEntryId,
      amountMinor: 90_000,
    });
    expect(
      await refusedBy(
        t.db
          .insertInto('contribution_requests')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            obligation_id: teamDebt,
            requested_person_id: payer.personId,
            requested_by: ACTOR,
            requested_by_person_id: null,
            amount_minor: 30_000,
            currency: 'EUR',
            message: null,
            receipt_id: null,
            paid_at: null,
            canceled_at: null,
            cancel_reason: null,
          })
          .execute(),
      ),
    ).toBe('contribution_requests_obligation_currency_fk');
  });

  it('§4.3 (migration 0604): ledger attribution, a consuming checkout and provider evidence never point at another organization', async () => {
    const other = await seedOrganization(t.db);
    const stranger = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const foreignDebt = await createObligationFixture(t, {
      debtorPersonId: stranger,
      amountMinor: 1_000,
      organizationId: other.organizationId,
    });
    const { receiptId, paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 1_000,
    });
    const entry = await t.db
      .selectFrom('journal_entries')
      .innerJoin('journals', 'journals.id', 'journal_entries.journal_id')
      .select('journal_entries.id')
      .where('journals.source_id', '=', receiptId)
      .executeTakeFirstOrThrow();
    const line = (changes: Record<string, unknown>) =>
      copyRow('journal_entries', entry.id, { id: newId(), line_number: 99, ...changes });
    expect(await refusedBy(line({ person_id: stranger }))).toBe('journal_entries_person_fk');
    expect(await refusedBy(line({ obligation_id: foreignDebt }))).toBe(
      'journal_entries_obligation_fk',
    );
    expect(await refusedBy(line({ order_id: newId() }))).toBe('journal_entries_order_fk');
    // a quote is consumed only by a checkout of its own organization
    const setup = await offering(t, { basePriceMinor: 2_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId);
    expect(
      await refusedBy(
        t.db
          .updateTable('quotes')
          .set({
            status: 'consumed',
            consumed_at: t.clock.now(),
            consumed_by_checkout_id: newId(),
          })
          .where('id', '=', quote.id)
          .execute(),
      ),
    ).toBe('quotes_consumed_by_checkout_fk');
    // a payment or refund attempt's evidence is an inbox event of its own organization
    const foreignEvent = newId();
    await t.db
      .insertInto('inbox_events')
      .values({
        id: foreignEvent,
        provider: 'fake-payments',
        provider_event_id: `evt_${foreignEvent}`,
        organization_id: other.organizationId,
        event_type: 'payment.succeeded',
        payload: json({}),
        signature_verified: true,
      })
      .execute();
    expect(
      await refusedBy(
        t.db
          .updateTable('payment_attempts')
          .set({ evidence_inbox_event_id: foreignEvent })
          .where('id', '=', paymentAttemptId)
          .execute(),
      ),
    ).toBe('payment_attempts_evidence_inbox_scope');
    expect(
      await refusedBy(
        t.db
          .insertInto('refund_attempts')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            payment_attempt_id: paymentAttemptId,
            amount_minor: 100,
            currency: 'USD',
            checkout_id: null,
            reason: 'schema test',
            provider: 'fake-payments',
            provider_reference: null,
            failure_reason: null,
            evidence_source: 'webhook',
            evidence_inbox_event_id: foreignEvent,
            evidence_sequence: 1,
            requested_by: ACTOR,
            requested_by_person_id: null,
            operation_id: null,
            submitted_at: null,
            unknown_since: null,
            resolved_at: null,
          })
          .execute(),
      ),
    ).toBe('refund_attempts_evidence_inbox_scope');
  });

  it('§4.4 (migrations 0452, 0503, 0605): the lookups services run by order, obligation, consuming record, basket line and decision are indexed', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
      where indexname in ('receipts_order_idx', 'receipts_obligation_idx', 'obligations_order_idx',
        'credit_redemptions_reference_idx', 'enrollments_basket_line_idx', 'suspensions_decision_idx')
        and schemaname = current_schema()
      order by indexname`.execute(t.db);
    expect(
      indexes.rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')]),
    ).toEqual([
      ['credit_redemptions_reference_idx', '(organization_id, reference_type, reference_id, kind)'],
      [
        'enrollments_basket_line_idx',
        '(organization_id, basket_line_id) WHERE (basket_line_id IS NOT NULL)',
      ],
      ['obligations_order_idx', '(organization_id, order_id, status) WHERE (order_id IS NOT NULL)'],
      [
        'receipts_obligation_idx',
        '(organization_id, obligation_id) WHERE (obligation_id IS NOT NULL)',
      ],
      ['receipts_order_idx', '(organization_id, order_id) WHERE (order_id IS NOT NULL)'],
      [
        'suspensions_decision_idx',
        '(organization_id, decision_id) WHERE (decision_id IS NOT NULL)',
      ],
    ]);
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
