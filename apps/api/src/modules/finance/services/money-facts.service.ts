import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CreditUse,
  type ObligationTotals,
  type Principal,
} from '@sportspark/contracts';
import {
  json,
  type CreditSourceKind,
  type CreditStatusValue,
  type ObligationDebtorKind,
  type ObligationMode,
  type ObligationsTable,
  type ObligationSourceKind,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  CLOCK,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { FinanceEvents } from '../finance.events';
import { daysFrom, type CreditRow, type Reader, type ReceiptRow } from '../finance.shared';
import { LedgerService } from '../ledger/ledger.service';
import { FinancePolicyResolver } from './finance-policy.resolver';

export type ObligationRow = Selectable<ObligationsTable>;

export interface CreateObligationInput {
  organizationId: string;
  id?: string;
  debtorKind: ObligationDebtorKind;
  debtorPersonId: string | null;
  debtorTeamEntryId: string | null;
  mode: ObligationMode;
  responsiblePayerPersonId: string | null;
  sourceKind: ObligationSourceKind;
  sourceId: string | null;
  orderId: string | null;
  installmentPlanId: string | null;
  description: string;
  amountMinor: number;
  currency: string;
  dueAt: Date;
  actor: Principal;
  correlationId: string | null;
}

export interface RecordReceiptInput {
  organizationId: string;
  sourceKind: 'payment_attempt' | 'cash_tender';
  paymentAttemptId?: string | null;
  cashTenderId?: string | null;
  payerPersonId: string;
  amountMinor: number;
  currency: string;
  processorFeeMinor: number;
  /** Where the money sits: the processor (card) or the drawer (cash and external tenders). */
  cashAccount: 'cash_processor' | 'cash_on_hand';
  obligationId: string | null;
  orderId: string | null;
  receivedAt: Date;
  actor: Principal;
  correlationId: string | null;
  operationId?: string | null;
}

export interface RecordedReceipt {
  receipt: ReceiptRow;
  overpaymentCreditId: string | null;
}

export interface RedeemCreditInput {
  organizationId: string;
  creditId: string;
  amountMinor: number;
  currency: string;
  use: CreditUse;
  ownerPersonId: string;
  referenceType: string;
  referenceId: string;
  obligationId: string;
  actor: Principal;
  correlationId: string | null;
}

/**
 * The low-level financial facts every finance command shares (SPK-PAY-004/005/009/010):
 * obligations and their journal, receipts with their allocation and visible excess, credit
 * redemptions. Every money movement is a conditional UPDATE bounded by a database check, every
 * fact posts one balanced journal (replay posts nothing twice), and allocations are append-only.
 */
@Injectable()
export class MoneyFacts {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly policy: FinancePolicyResolver,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Obligations
  // -------------------------------------------------------------------------------------------

  async loadObligation(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<ObligationRow | undefined> {
    let q = db
      .selectFrom('obligations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async createObligation(trx: Trx, input: CreateObligationInput): Promise<ObligationRow> {
    const id = input.id ?? newId();
    await trx
      .insertInto('obligations')
      .values({
        id,
        organization_id: input.organizationId,
        debtor_kind: input.debtorKind,
        debtor_person_id: input.debtorPersonId,
        debtor_team_entry_id: input.debtorTeamEntryId,
        mode: input.mode,
        responsible_payer_person_id: input.responsiblePayerPersonId,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        order_id: input.orderId,
        installment_plan_id: input.installmentPlanId,
        description: input.description,
        amount_minor: input.amountMinor,
        currency: input.currency,
        due_at: input.dueAt,
        settled_at: null,
        written_off_at: null,
        canceled_at: null,
        status_reason: null,
        created_by: json(snapshotActor(input.actor)),
      })
      .execute();
    // Receivable and deferred revenue: payment volume is not revenue (SPK-PAY-011).
    await this.ledger.post(trx, {
      organizationId: input.organizationId,
      sourceType: 'obligation',
      sourceId: id,
      purpose: 'obligation_created',
      description: input.description,
      currency: input.currency,
      actor: input.actor,
      correlationId: input.correlationId,
      lines: [
        {
          account: 'customer_receivable',
          debitMinor: input.amountMinor,
          personId: input.debtorPersonId ?? input.responsiblePayerPersonId,
          orderId: input.orderId,
          obligationId: id,
        },
        {
          account: 'deferred_revenue',
          creditMinor: input.amountMinor,
          orderId: input.orderId,
          obligationId: id,
        },
      ],
    });
    await this.outbox.enqueue(trx, FinanceEvents.obligationCreated, {
      organizationId: input.organizationId,
      aggregateType: 'obligation',
      aggregateId: id,
      correlationId: input.correlationId,
      payload: {
        organizationId: input.organizationId,
        obligationId: id,
        debtorKind: input.debtorKind,
        debtorId: (input.debtorPersonId ?? input.debtorTeamEntryId) as string,
        amountMinor: input.amountMinor,
        currency: input.currency,
        dueAt: input.dueAt.toISOString(),
      },
    });
    const row = await this.loadObligation(trx, input.organizationId, id);
    if (!row) throw errors.internal('obligation vanished');
    return row;
  }

  /** Cancels an open obligation (an order that was never paid); its posting is reversed. */
  async cancelObligation(
    trx: Trx,
    obligation: ObligationRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (obligation.status !== 'open') return;
    const now = this.clock.now();
    await trx
      .updateTable('obligations')
      .set({
        status: 'canceled',
        canceled_at: now,
        status_reason: reason,
        revision: obligation.revision + 1,
      })
      .where('organization_id', '=', obligation.organization_id)
      .where('id', '=', obligation.id)
      .where('status', '=', 'open')
      .execute();
    await this.ledger.reverse(trx, {
      organizationId: obligation.organization_id,
      sourceType: 'obligation',
      sourceId: obligation.id,
      purpose: 'obligation_created',
      reversalPurpose: 'obligation_canceled',
      description: `Canceled: ${obligation.description}`,
      actor,
      correlationId,
    });
  }

  /** SPK-PAY-004: total, received, allocated and remaining from one consistent read. */
  async obligationTotals(db: Reader, obligation: ObligationRow): Promise<ObligationTotals> {
    const receipts = await db
      .selectFrom('receipts')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), sql<number>`0`).as('received'),
        eb.fn.coalesce(eb.fn.sum<number>('excess_minor'), sql<number>`0`).as('excess'),
      ])
      .where('organization_id', '=', obligation.organization_id)
      .where('obligation_id', '=', obligation.id)
      .executeTakeFirst();
    const credits = await db
      .selectFrom('payment_allocations')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), sql<number>`0`).as('total'))
      .where('organization_id', '=', obligation.organization_id)
      .where('obligation_id', '=', obligation.id)
      .where('source_kind', '=', 'credit_redemption')
      .executeTakeFirst();
    const receivedMinor = Number(receipts?.received ?? 0) + Number(credits?.total ?? 0);
    const remainingMinor =
      obligation.status === 'open' ? obligation.amount_minor - obligation.allocated_minor : 0;
    return {
      amountMinor: obligation.amount_minor,
      receivedMinor,
      allocatedMinor: obligation.allocated_minor,
      remainingMinor,
      excessMinor: Number(receipts?.excess ?? 0),
      currency: obligation.currency,
    };
  }

  /**
   * Allocates against a locked open obligation with a conditional UPDATE: the database check
   * (allocated <= amount) is the final guarantee and the deferred trigger keeps the allocated
   * amount equal to the sum of allocation rows.
   */
  private async allocate(
    trx: Trx,
    obligation: ObligationRow,
    amountMinor: number,
    source:
      { kind: 'receipt'; receiptId: string } | { kind: 'credit_redemption'; redemptionId: string },
    at: Date,
    correlationId: string | null,
  ): Promise<void> {
    if (amountMinor <= 0) return;
    const settles = obligation.allocated_minor + amountMinor === obligation.amount_minor;
    const updated = await trx
      .updateTable('obligations')
      .set((eb) => ({
        allocated_minor: eb('allocated_minor', '+', amountMinor),
        status: settles ? 'settled' : 'open',
        settled_at: settles ? at : null,
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', obligation.organization_id)
      .where('id', '=', obligation.id)
      .where('status', '=', 'open')
      .where('allocated_minor', '=', obligation.allocated_minor)
      .where(sql<boolean>`allocated_minor + ${amountMinor} <= amount_minor`)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw errors.resourceConflict('The obligation changed; nothing was allocated.', {
        code: 'OBLIGATION_CHANGED',
        obligationId: obligation.id,
      });
    }
    await trx
      .insertInto('payment_allocations')
      .values({
        id: newId(),
        organization_id: obligation.organization_id,
        obligation_id: obligation.id,
        source_kind: source.kind,
        receipt_id: source.kind === 'receipt' ? source.receiptId : null,
        credit_redemption_id: source.kind === 'credit_redemption' ? source.redemptionId : null,
        amount_minor: amountMinor,
        currency: obligation.currency,
        allocated_at: at,
      })
      .execute();
    obligation.allocated_minor += amountMinor;
    if (settles) {
      obligation.status = 'settled';
      obligation.settled_at = at;
      if (obligation.source_kind === 'installment') {
        await this.markInstallmentPaid(trx, obligation, at, correlationId);
      }
      await this.outbox.enqueue(trx, FinanceEvents.obligationSettled, {
        organizationId: obligation.organization_id,
        aggregateType: 'obligation',
        aggregateId: obligation.id,
        correlationId,
        payload: { organizationId: obligation.organization_id, obligationId: obligation.id },
      });
    }
  }

  /** An installment is paid when its obligation settles, whatever paid it (card, cash, credit). */
  private async markInstallmentPaid(
    trx: Trx,
    obligation: ObligationRow,
    at: Date,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = obligation.organization_id;
    const installment = await trx
      .selectFrom('installments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('obligation_id', '=', obligation.id)
      .forUpdate()
      .executeTakeFirst();
    if (!installment || installment.status === 'paid' || installment.status === 'canceled') return;
    await trx
      .updateTable('installments')
      .set({ status: 'paid', paid_at: at, next_retry_at: null, revision: installment.revision + 1 })
      .where('id', '=', installment.id)
      .execute();
    const open = await trx
      .selectFrom('installments')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('organization_id', '=', organizationId)
      .where('plan_id', '=', installment.plan_id)
      .where('status', 'in', ['scheduled', 'failed'])
      .executeTakeFirstOrThrow();
    if (Number(open.n) === 0) {
      await trx
        .updateTable('installment_plans')
        .set((eb) => ({ status: 'completed', completed_at: at, revision: eb('revision', '+', 1) }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', installment.plan_id)
        .where('status', '=', 'active')
        .execute();
    }
    await this.outbox.enqueue(trx, FinanceEvents.installmentPaid, {
      organizationId,
      aggregateType: 'installment',
      aggregateId: installment.id,
      correlationId,
      payload: {
        organizationId,
        installmentId: installment.id,
        planId: installment.plan_id,
        obligationId: obligation.id,
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Receipts (SPK-PAY-005: excess stays visible and traceable)
  // -------------------------------------------------------------------------------------------

  async recordReceipt(trx: Trx, input: RecordReceiptInput): Promise<RecordedReceipt> {
    const obligation = input.obligationId
      ? await this.loadObligation(trx, input.organizationId, input.obligationId, true)
      : undefined;
    if (obligation && obligation.currency !== input.currency) {
      throw errors.internal('receipt currency differs from its obligation');
    }
    const remaining =
      obligation && obligation.status === 'open'
        ? obligation.amount_minor - obligation.allocated_minor
        : 0;
    const allocatedMinor = Math.min(input.amountMinor, remaining);
    const excessMinor = input.amountMinor - allocatedMinor;
    const receiptId = newId();
    const { journalId } = await this.ledger.post(trx, {
      organizationId: input.organizationId,
      sourceType: 'receipt',
      sourceId: receiptId,
      purpose: 'payment_received',
      description:
        input.sourceKind === 'cash_tender' ? 'Tender recorded at the desk' : 'Payment captured',
      currency: input.currency,
      actor: input.actor,
      correlationId: input.correlationId,
      operationId: input.operationId ?? null,
      lines: [
        {
          account: input.cashAccount,
          debitMinor: input.amountMinor,
          personId: input.payerPersonId,
          orderId: input.orderId,
          obligationId: input.obligationId,
        },
        {
          account: 'customer_receivable',
          creditMinor: allocatedMinor,
          personId: input.payerPersonId,
          orderId: input.orderId,
          obligationId: input.obligationId,
        },
        {
          account: 'overpayment_liability',
          creditMinor: excessMinor,
          personId: input.payerPersonId,
          obligationId: input.obligationId,
          memo: 'excess beyond the remaining balance (SPK-PAY-005)',
        },
        { account: 'processor_fees', debitMinor: input.processorFeeMinor, orderId: input.orderId },
        { account: 'cash_processor', creditMinor: input.processorFeeMinor, orderId: input.orderId },
      ],
    });
    await trx
      .insertInto('receipts')
      .values({
        id: receiptId,
        organization_id: input.organizationId,
        source_kind: input.sourceKind,
        payment_attempt_id: input.paymentAttemptId ?? null,
        cash_tender_id: input.cashTenderId ?? null,
        payer_person_id: input.payerPersonId,
        amount_minor: input.amountMinor,
        allocated_minor: allocatedMinor,
        excess_minor: excessMinor,
        currency: input.currency,
        processor_fee_minor: input.processorFeeMinor,
        order_id: input.orderId,
        obligation_id: input.obligationId,
        journal_id: journalId,
        received_at: input.receivedAt,
      })
      .execute();
    if (obligation && allocatedMinor > 0) {
      await this.allocate(
        trx,
        obligation,
        allocatedMinor,
        { kind: 'receipt', receiptId },
        input.receivedAt,
        input.correlationId,
      );
    }
    let overpaymentCreditId: string | null = null;
    if (excessMinor > 0) {
      overpaymentCreditId = await this.holdExcess(trx, input, receiptId, excessMinor);
    }
    await this.outbox.enqueue(trx, FinanceEvents.paymentReceived, {
      organizationId: input.organizationId,
      aggregateType: 'receipt',
      aggregateId: receiptId,
      correlationId: input.correlationId,
      operationId: input.operationId ?? null,
      payload: {
        organizationId: input.organizationId,
        receiptId,
        paymentAttemptId: input.paymentAttemptId ?? null,
        cashTenderId: input.cashTenderId ?? null,
        obligationId: input.obligationId,
        amountMinor: input.amountMinor,
        allocatedMinor,
        excessMinor,
        currency: input.currency,
      },
    });
    const receipt = await trx
      .selectFrom('receipts')
      .selectAll()
      .where('id', '=', receiptId)
      .executeTakeFirstOrThrow();
    return { receipt, overpaymentCreditId };
  }

  /**
   * POL-015 (DEC-008) proposed default: the excess is held as a credit for the payer pending
   * finance approval; the money sits in `overpayment_liability` until then, and an exception
   * puts it in front of the finance operator. It never disappears into a zero balance.
   */
  private async holdExcess(
    trx: Trx,
    input: RecordReceiptInput,
    receiptId: string,
    excessMinor: number,
  ): Promise<string> {
    const creditId = await this.insertCredit(trx, {
      organizationId: input.organizationId,
      ownerPersonId: input.payerPersonId,
      currency: input.currency,
      amountMinor: excessMinor,
      permittedUses: ['registration', 'obligation'],
      sourceKind: 'overpayment',
      sourceId: receiptId,
      status: 'pending_approval',
      reason: 'Payment exceeded the remaining balance (SPK-PAY-005)',
      actor: input.actor,
    });
    await this.exceptions.raise(trx, {
      organizationId: input.organizationId,
      category: 'finance.overpayment_review',
      severity: 'warning',
      title: 'A payment exceeded the remaining balance; the excess is held pending approval',
      affectedType: 'credit',
      affectedId: creditId,
      ownerQueue: 'finance_operator',
      dedupeKey: `overpayment:${receiptId}`,
      details: {
        receiptId,
        obligationId: input.obligationId,
        excessMinor,
        currency: input.currency,
        handling: 'hold_as_credit_pending_approval',
      },
    });
    await this.outbox.enqueue(trx, FinanceEvents.overpaymentRecorded, {
      organizationId: input.organizationId,
      aggregateType: 'receipt',
      aggregateId: receiptId,
      correlationId: input.correlationId,
      payload: {
        organizationId: input.organizationId,
        receiptId,
        obligationId: input.obligationId,
        excessMinor,
        currency: input.currency,
        creditId,
      },
    });
    return creditId;
  }

  // -------------------------------------------------------------------------------------------
  // Credits (SPK-PAY-009, invariant 7)
  // -------------------------------------------------------------------------------------------

  async insertCredit(
    trx: Trx,
    input: {
      organizationId: string;
      ownerPersonId: string;
      currency: string;
      amountMinor: number;
      permittedUses: CreditUse[];
      sourceKind: CreditSourceKind;
      sourceId: string | null;
      status: Extract<CreditStatusValue, 'pending_approval' | 'active'>;
      expiresAt?: Date | null;
      reason: string;
      actor: Principal;
    },
  ): Promise<string> {
    const id = newId();
    const now = this.clock.now();
    const days = this.policy.configuration.creditExpiryDays;
    const expiresAt =
      input.expiresAt !== undefined ? input.expiresAt : days === null ? null : daysFrom(now, days);
    await trx
      .insertInto('credits')
      .values({
        id,
        organization_id: input.organizationId,
        owner_person_id: input.ownerPersonId,
        currency: input.currency,
        original_minor: input.amountMinor,
        remaining_minor: input.amountMinor,
        permitted_uses: json(input.permittedUses),
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        status: input.status,
        expires_at: expiresAt,
        reason: input.reason,
        issued_by: json(snapshotActor(input.actor)),
        issued_by_person_id: input.actor.personId,
        approved_at: input.status === 'active' && input.sourceKind === 'overpayment' ? now : null,
        approved_by: null,
        revoked_at: null,
        revoked_reason: null,
      })
      .execute();
    await this.outbox.enqueue(trx, FinanceEvents.creditIssued, {
      organizationId: input.organizationId,
      aggregateType: 'credit',
      aggregateId: id,
      payload: {
        organizationId: input.organizationId,
        creditId: id,
        ownerPersonId: input.ownerPersonId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        sourceKind: input.sourceKind,
        status: input.status,
      },
    });
    return id;
  }

  async loadCredit(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<CreditRow | undefined> {
    let q = db
      .selectFrom('credits')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /**
   * Redeems a credit against an obligation (invariant 7): `remaining = remaining - x WHERE
   * remaining >= x` under the row lock, so two concurrent redemptions cannot both consume the
   * same balance; the check `remaining >= 0` is the final guarantee. One redemption per credit
   * and reference: an existing one is returned with `replayed: true` and nothing is redeemed;
   * the caller decides whether that is a replay or a refusal.
   */
  async redeemCredit(
    trx: Trx,
    input: RedeemCreditInput,
  ): Promise<{ redemptionId: string; replayed: boolean }> {
    const now = this.clock.now();
    // Lock order everywhere: obligation, then credit.
    const obligation = await this.loadObligation(
      trx,
      input.organizationId,
      input.obligationId,
      true,
    );
    // Looked up under the obligation lock: a concurrent application to the same obligation has
    // committed by now and is seen here, instead of failing on the unique key (SPK-PAY-009).
    const existing = await trx
      .selectFrom('credit_redemptions')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('credit_id', '=', input.creditId)
      .where('kind', '=', 'redeem')
      .where('reference_type', '=', input.referenceType)
      .where('reference_id', '=', input.referenceId)
      .executeTakeFirst();
    if (existing) return { redemptionId: existing.id, replayed: true };
    if (!obligation || obligation.status !== 'open') {
      throw errors.resourceConflict('The obligation is not open.', {
        code: 'OBLIGATION_NOT_OPEN',
      });
    }
    if (obligation.currency !== input.currency) {
      throw errors.validation('The credit is in another currency than the obligation.');
    }
    if (input.amountMinor > obligation.amount_minor - obligation.allocated_minor) {
      throw errors.validation('A credit cannot pay more than the remaining balance.', {
        remainingMinor: obligation.amount_minor - obligation.allocated_minor,
      });
    }
    const credit = await this.loadCredit(trx, input.organizationId, input.creditId, true);
    if (!credit || credit.owner_person_id !== input.ownerPersonId) {
      throw errors.protectedNotFound('credit');
    }
    if (credit.currency !== input.currency) {
      throw errors.validation('The credit is in another currency.', {
        creditCurrency: credit.currency,
      });
    }
    if (!(credit.permitted_uses as string[]).includes(input.use)) {
      throw errors.validation(`The credit may not be used for ${input.use}.`, {
        permittedUses: credit.permitted_uses,
      });
    }
    if (credit.expires_at && new Date(credit.expires_at) <= now) {
      throw errors.resourceConflict('The credit has expired.', { code: 'CREDIT_EXPIRED' });
    }
    if (credit.status !== 'active') {
      throw errors.resourceConflict(`The credit is ${credit.status}.`, {
        code: 'CREDIT_NOT_ACTIVE',
        status: credit.status,
      });
    }
    const updated = await trx
      .updateTable('credits')
      .set((eb) => ({
        remaining_minor: eb('remaining_minor', '-', input.amountMinor),
        status: sql<CreditStatusValue>`case when remaining_minor - ${input.amountMinor} = 0 then 'exhausted' else status end`,
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.creditId)
      .where('status', '=', 'active')
      .where('remaining_minor', '>=', input.amountMinor)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw errors.resourceConflict('The credit does not have enough remaining balance.', {
        code: 'CREDIT_INSUFFICIENT',
        remainingMinor: credit.remaining_minor,
      });
    }
    const redemptionId = newId();
    await trx
      .insertInto('credit_redemptions')
      .values({
        id: redemptionId,
        organization_id: input.organizationId,
        credit_id: input.creditId,
        kind: 'redeem',
        amount_minor: input.amountMinor,
        currency: input.currency,
        reference_type: input.referenceType,
        reference_id: input.referenceId,
        reverses_redemption_id: null,
        actor: json(snapshotActor(input.actor)),
        redeemed_at: now,
      })
      .execute();
    await this.allocate(
      trx,
      obligation,
      input.amountMinor,
      { kind: 'credit_redemption', redemptionId },
      now,
      input.correlationId,
    );
    await this.ledger.post(trx, {
      organizationId: input.organizationId,
      sourceType: 'credit_redemption',
      sourceId: redemptionId,
      purpose: 'credit_redeemed',
      description: 'Credit applied to an obligation',
      currency: input.currency,
      actor: input.actor,
      correlationId: input.correlationId,
      lines: [
        {
          account: 'credits_payable',
          debitMinor: input.amountMinor,
          personId: input.ownerPersonId,
          obligationId: input.obligationId,
        },
        {
          account: 'customer_receivable',
          creditMinor: input.amountMinor,
          personId: input.ownerPersonId,
          obligationId: input.obligationId,
        },
      ],
    });
    await this.outbox.enqueue(trx, FinanceEvents.creditRedeemed, {
      organizationId: input.organizationId,
      aggregateType: 'credit',
      aggregateId: input.creditId,
      correlationId: input.correlationId,
      payload: {
        organizationId: input.organizationId,
        creditId: input.creditId,
        redemptionId,
        amountMinor: input.amountMinor,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
      },
    });
    return { redemptionId, replayed: false };
  }

  /**
   * Gives a redemption back: a reversal row restores the credit's balance (invariant 7, history
   * trigger). For an order that was never paid the redemption's journal is reversed (the
   * receivable reopens and is canceled with its obligation). For a compensated order
   * (`options.compensation`, SPK-AT-006, §4.11 step 10) the obligation stays settled, so the
   * restoration is booked like the compensation refund or credit: refunds to credits payable.
   * Idempotent: returns the amount restored, 0 when the redemption was already given back.
   */
  async reverseCreditRedemption(
    trx: Trx,
    organizationId: string,
    redemptionId: string,
    actor: Principal,
    correlationId: string | null,
    options: { compensation?: { personId: string; orderId: string } } = {},
  ): Promise<number> {
    const redemption = await trx
      .selectFrom('credit_redemptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', redemptionId)
      .executeTakeFirst();
    if (!redemption || redemption.kind !== 'redeem') return 0;
    const already = await trx
      .selectFrom('credit_redemptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('reverses_redemption_id', '=', redemptionId)
      .executeTakeFirst();
    if (already) return 0;
    const credit = await this.loadCredit(trx, organizationId, redemption.credit_id, true);
    if (!credit) return 0;
    await trx
      .updateTable('credits')
      .set({
        remaining_minor: credit.remaining_minor + redemption.amount_minor,
        status: credit.status === 'exhausted' ? 'active' : credit.status,
        revision: credit.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', credit.id)
      .where('revision', '=', credit.revision)
      .execute();
    await trx
      .insertInto('credit_redemptions')
      .values({
        id: newId(),
        organization_id: organizationId,
        credit_id: credit.id,
        kind: 'reversal',
        amount_minor: redemption.amount_minor,
        currency: redemption.currency,
        reference_type: redemption.reference_type,
        reference_id: redemption.reference_id,
        reverses_redemption_id: redemption.id,
        actor: json(snapshotActor(actor)),
        redeemed_at: this.clock.now(),
      })
      .execute();
    if (options.compensation) {
      await this.ledger.post(trx, {
        organizationId,
        sourceType: 'credit_redemption',
        sourceId: redemption.id,
        purpose: 'credit_restored_compensation',
        description: 'Credit applied to an unfulfilled registration restored (compensation)',
        currency: redemption.currency,
        actor,
        correlationId,
        lines: [
          {
            account: 'refunds',
            debitMinor: redemption.amount_minor,
            personId: options.compensation.personId,
            orderId: options.compensation.orderId,
          },
          {
            account: 'credits_payable',
            creditMinor: redemption.amount_minor,
            personId: credit.owner_person_id,
          },
        ],
      });
    } else {
      await this.ledger.reverse(trx, {
        organizationId,
        sourceType: 'credit_redemption',
        sourceId: redemption.id,
        purpose: 'credit_redeemed',
        reversalPurpose: 'credit_redemption_reversed',
        description: 'Credit redemption reversed',
        actor,
        correlationId,
      });
    }
    return redemption.amount_minor;
  }
}
