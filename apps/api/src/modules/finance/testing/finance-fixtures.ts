import { newId } from '@sportspark/contracts';
import {
  json,
  type Database,
  type Db,
  type LedgerAccountCode,
  type ObligationMode,
} from '@sportspark/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../../kernel';

/**
 * Finance fixtures for downstream module tests (support, reporting, entry, migration). Rows are
 * written directly through Kysely in one transaction, with the journal, allocation and refundable
 * rows the services would write, so the database guarantees (balanced journals, allocations equal
 * to the allocated amount, refundable ceilings, credit history) hold in fixture data too. People
 * come from the identity fixtures, team entries from the competition fixtures.
 */
export interface FinanceFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

/** An open obligation (individual by default) with its receivable posting. */
export async function createObligationFixture(
  ctx: FinanceFixtureContext,
  input: {
    debtorPersonId?: string;
    debtorTeamEntryId?: string;
    mode?: ObligationMode;
    responsiblePayerPersonId?: string | null;
    amountMinor: number;
    currency?: string;
    dueAt?: Date;
    description?: string;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const currency = input.currency ?? 'USD';
  const mode = input.mode ?? (input.debtorTeamEntryId ? 'team_with_contributions' : 'individual');
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('obligations')
      .values({
        id,
        organization_id: organizationId,
        debtor_kind: input.debtorTeamEntryId ? 'team_entry' : 'person',
        debtor_person_id: input.debtorTeamEntryId ? null : (input.debtorPersonId ?? null),
        debtor_team_entry_id: input.debtorTeamEntryId ?? null,
        mode,
        responsible_payer_person_id: input.responsiblePayerPersonId ?? null,
        source_kind: input.debtorTeamEntryId ? 'team_fee' : 'manual',
        source_id: null,
        order_id: null,
        installment_plan_id: null,
        description: input.description ?? 'Fixture obligation',
        amount_minor: input.amountMinor,
        currency,
        due_at: input.dueAt ?? ctx.clock.now(),
        settled_at: null,
        written_off_at: null,
        canceled_at: null,
        status_reason: null,
        created_by: json(FIXTURE_ACTOR),
      })
      .execute();
    await postJournal(trx, ctx, organizationId, 'obligation', id, 'obligation_created', currency, [
      ['customer_receivable', input.amountMinor, 0],
      ['deferred_revenue', 0, input.amountMinor],
    ]);
  });
  return id;
}

/** An active credit owned by the person (no redemptions yet). */
export async function createCreditFixture(
  ctx: FinanceFixtureContext,
  input: {
    ownerPersonId: string;
    amountMinor: number;
    currency?: string;
    permittedUses?: Array<'registration' | 'obligation'>;
    expiresAt?: Date | null;
    status?: 'active' | 'pending_approval';
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('credits')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      owner_person_id: input.ownerPersonId,
      currency: input.currency ?? 'USD',
      original_minor: input.amountMinor,
      remaining_minor: input.amountMinor,
      permitted_uses: json(input.permittedUses ?? ['registration', 'obligation']),
      source_kind: input.status === 'pending_approval' ? 'overpayment' : 'goodwill',
      source_id: null,
      status: input.status ?? 'active',
      expires_at: input.expiresAt ?? null,
      reason: 'fixture',
      issued_by: json(FIXTURE_ACTOR),
      issued_by_person_id: null,
      approved_at: null,
      approved_by: null,
      revoked_at: null,
      revoked_reason: null,
    })
    .execute();
  return id;
}

/**
 * A captured provider payment that settled an obligation: payment attempt (succeeded), receipt,
 * balanced journal, allocation and refundable funds. Returns the ids a refund or support test needs.
 */
export async function createCapturedPaymentFixture(
  ctx: FinanceFixtureContext,
  input: {
    payerPersonId: string;
    amountMinor: number;
    currency?: string;
    provider?: string;
    organizationId?: string;
  },
): Promise<{ obligationId: string; paymentAttemptId: string; receiptId: string }> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const currency = input.currency ?? 'USD';
  const obligationId = await createObligationFixture(ctx, {
    debtorPersonId: input.payerPersonId,
    amountMinor: input.amountMinor,
    currency,
    organizationId,
  });
  const paymentAttemptId = newId();
  const receiptId = newId();
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('payment_attempts')
      .values({
        id: paymentAttemptId,
        organization_id: organizationId,
        purpose: 'obligation',
        checkout_id: null,
        order_id: null,
        obligation_id: obligationId,
        contribution_request_id: null,
        installment_id: null,
        payer_person_id: input.payerPersonId,
        amount_minor: input.amountMinor,
        currency,
        provider: input.provider ?? 'fake-payments',
        payment_method_ref: 'pm_fake_visa',
        provider_reference: `fp_${paymentAttemptId}`,
        status: 'succeeded',
        action_required_payload: null,
        failure_reason: null,
        processor_fee_minor: 0,
        evidence_source: 'sync_response',
        evidence_inbox_event_id: null,
        evidence_sequence: null,
        requested_by: json(FIXTURE_ACTOR),
        requested_by_person_id: null,
        submitted_at: now,
        unknown_since: null,
        resolved_at: now,
      })
      .execute();
    const journalId = await postJournal(
      trx,
      ctx,
      organizationId,
      'receipt',
      receiptId,
      'payment_received',
      currency,
      [
        ['cash_processor', input.amountMinor, 0],
        ['customer_receivable', 0, input.amountMinor],
      ],
    );
    await trx
      .insertInto('receipts')
      .values({
        id: receiptId,
        organization_id: organizationId,
        source_kind: 'payment_attempt',
        payment_attempt_id: paymentAttemptId,
        cash_tender_id: null,
        payer_person_id: input.payerPersonId,
        amount_minor: input.amountMinor,
        allocated_minor: input.amountMinor,
        excess_minor: 0,
        currency,
        processor_fee_minor: 0,
        order_id: null,
        obligation_id: obligationId,
        journal_id: journalId,
        received_at: now,
      })
      .execute();
    await trx
      .insertInto('payment_allocations')
      .values({
        id: newId(),
        organization_id: organizationId,
        obligation_id: obligationId,
        source_kind: 'receipt',
        receipt_id: receiptId,
        credit_redemption_id: null,
        amount_minor: input.amountMinor,
        currency,
        allocated_at: now,
      })
      .execute();
    await trx
      .updateTable('obligations')
      .set({ allocated_minor: input.amountMinor, status: 'settled', settled_at: now, revision: 2 })
      .where('id', '=', obligationId)
      .execute();
    await trx
      .insertInto('payment_refundables')
      .values({
        payment_attempt_id: paymentAttemptId,
        organization_id: organizationId,
        receipt_id: receiptId,
        currency,
        captured_minor: input.amountMinor,
      })
      .execute();
  });
  return { obligationId, paymentAttemptId, receiptId };
}

async function postJournal(
  trx: Kysely<Database>,
  ctx: FinanceFixtureContext,
  organizationId: string,
  sourceType: string,
  sourceId: string,
  purpose: string,
  currency: string,
  lines: Array<[LedgerAccountCode, number, number]>,
): Promise<string> {
  const journalId = newId();
  await trx
    .insertInto('journals')
    .values({
      id: journalId,
      organization_id: organizationId,
      source_type: sourceType,
      source_id: sourceId,
      purpose,
      description: `fixture ${purpose}`,
      currency,
      reversal_of_journal_id: null,
      posted_at: ctx.clock.now(),
      posted_by: json(FIXTURE_ACTOR),
      correlation_id: null,
      operation_id: null,
    })
    .execute();
  await trx
    .insertInto('journal_entries')
    .values(
      lines.map(([account, debit, credit], index) => ({
        id: newId(),
        organization_id: organizationId,
        journal_id: journalId,
        line_number: index + 1,
        account_code: account,
        debit_minor: debit,
        credit_minor: credit,
        currency,
        person_id: null,
        order_id: null,
        obligation_id: null,
        reversal_of_entry_id: null,
        memo: null,
      })),
    )
    .execute();
  return journalId;
}
