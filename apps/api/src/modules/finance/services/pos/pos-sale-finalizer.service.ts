import { Inject, Injectable } from '@nestjs/common';
import { errors, type Principal } from '@sportspark/contracts';
import type { PosLineChargeRecord, PosReturnLineRecord, PosSalesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  CLOCK,
  OperationalExceptions,
  Outbox,
  type Clock,
  type Trx,
} from '../../../../kernel';
import { FinanceEvents } from '../../finance.events';
import { financeSystem, type PaymentAttemptRow } from '../../finance.shared';
import { PosSaleMachine, PosTenderMachine } from '../../finance.state-machines';
import { LedgerService, type PostingLine } from '../../ledger/ledger.service';

export type PosSaleRow = Selectable<PosSalesTable>;

/**
 * Settles point-of-sale sales and posts their journals (FIN-06; §4.11 for card tenders,
 * SPK-PAY-010, SPK-PAY-011). PaymentsService routes every outcome of a `pos_sale` attempt here
 * (synchronous answer, webhook, reconciliation sweep, abandoned-challenge cancel), so a late
 * outcome settles its tender and pays its sale exactly once; CheckoutFinalizer is not involved.
 *
 * Journals (balanced, append-only; corrections are reversing journals, never edits):
 * - sale paid (`pos_sale` / `pos_sale_paid`): debit cash on hand (cash and external tenders) and
 *   the processor (card tenders); credit POS revenue per product kind, taxes payable and fees
 *   payable per charge code (kind and code in the memo); the processor fee of each card tender as
 *   processor fees against the processor;
 * - return (`pos_return` / `pos_return`): the returned shares debited back from revenue, taxes and
 *   fees; credited to cash on hand (cash, external) or to refunds (card: the refund's own journal
 *   then moves refunds against the processor when it settles).
 */
@Injectable()
export class PosSaleFinalizer {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly outbox: Outbox,
    private readonly audit: AuditWriter,
    private readonly exceptions: OperationalExceptions,
  ) {}

  async lockSale(trx: Trx, organizationId: string, saleId: string): Promise<PosSaleRow> {
    const sale = await trx
      .selectFrom('pos_sales')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', saleId)
      .forUpdate()
      .executeTakeFirst();
    if (!sale) throw errors.notFound('pos sale', saleId);
    return sale;
  }

  /** A card tender's money was captured (PaymentsService.onCaptured, purpose `pos_sale`). */
  async onCardCaptured(
    trx: Trx,
    attempt: PaymentAttemptRow,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = attempt.organization_id;
    const actor = financeSystem(organizationId, 'finance.pos_sales');
    const tender = await trx
      .selectFrom('pos_tenders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('payment_attempt_id', '=', attempt.id)
      .forUpdate()
      .executeTakeFirst();
    if (!tender) {
      throw errors.internal(`no point-of-sale tender names payment attempt ${attempt.id}`);
    }
    // SPK-PAY-008: what the provider captured is the refundable ceiling of a card return.
    await trx
      .insertInto('payment_refundables')
      .values({
        payment_attempt_id: attempt.id,
        organization_id: organizationId,
        receipt_id: null,
        pos_tender_id: tender.id,
        currency: attempt.currency,
        captured_minor: attempt.amount_minor,
      })
      .onConflict((oc) => oc.column('payment_attempt_id').doNothing())
      .execute();
    if (tender.status === 'settled') return; // a replayed capture: one effect
    if (tender.status === 'failed') {
      // §4.11: money captured after the tender was recorded as failed is still received money;
      // it is refundable (above) and put in front of the finance operator, never silently kept.
      await this.exceptions.raise(trx, {
        organizationId,
        category: 'finance.pos_capture_after_failure',
        severity: 'critical',
        title: 'A card tender recorded as failed was captured by the provider; refund or apply it',
        affectedType: 'pos_tender',
        affectedId: tender.id,
        ownerQueue: 'finance_operator',
        dedupeKey: `pos-capture-after-failure:${tender.id}`,
        details: {
          saleId: tender.sale_id,
          paymentAttemptId: attempt.id,
          amountMinor: attempt.amount_minor,
          currency: attempt.currency,
        },
      });
      return;
    }
    const now = this.clock.now();
    await trx
      .updateTable('pos_tenders')
      .set({
        status: PosTenderMachine.next('pending', 'settle'),
        settled_at: now,
        revision: tender.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', tender.id)
      .where('revision', '=', tender.revision)
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.pos_tender_settled',
      targetType: 'pos_tender',
      targetId: tender.id,
      beforeRevision: tender.revision,
      afterRevision: tender.revision + 1,
      correlationId,
      details: { saleId: tender.sale_id, paymentAttemptId: attempt.id, kind: 'card' },
    });
    await this.payIfCovered(trx, organizationId, tender.sale_id, actor, correlationId);
  }

  /** A card tender's payment failed or was canceled: the sale stays open for another tender. */
  async onCardFailed(
    trx: Trx,
    attempt: PaymentAttemptRow,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = attempt.organization_id;
    const tender = await trx
      .selectFrom('pos_tenders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('payment_attempt_id', '=', attempt.id)
      .forUpdate()
      .executeTakeFirst();
    if (!tender || tender.status !== 'pending') return;
    await trx
      .updateTable('pos_tenders')
      .set({
        status: PosTenderMachine.next('pending', 'fail'),
        failed_at: this.clock.now(),
        failure_reason: attempt.failure_reason ?? attempt.status,
        revision: tender.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', tender.id)
      .where('revision', '=', tender.revision)
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId,
      actor: financeSystem(organizationId, 'finance.pos_sales'),
      action: 'finance.pos_tender_failed',
      targetType: 'pos_tender',
      targetId: tender.id,
      beforeRevision: tender.revision,
      afterRevision: tender.revision + 1,
      correlationId,
      details: { saleId: tender.sale_id, paymentAttemptId: attempt.id },
    });
  }

  /**
   * Pays an open sale once its settled tenders cover its total (PosSaleMachine `pay`), posts the
   * sale's journal and announces it. Locks the sale; returns whether it was paid now.
   */
  async payIfCovered(
    trx: Trx,
    organizationId: string,
    saleId: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<boolean> {
    const sale = await this.lockSale(trx, organizationId, saleId);
    if (sale.status !== 'open' || sale.total_minor <= 0) return false;
    const tenders = await trx
      .selectFrom('pos_tenders')
      .select(['kind', 'amount_minor', 'payment_attempt_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('sale_id', '=', saleId)
      .where('status', '=', 'settled')
      .execute();
    const settled = tenders.reduce((sum, t) => sum + Number(t.amount_minor), 0);
    if (settled < sale.total_minor) return false;
    const now = this.clock.now();
    await trx
      .updateTable('pos_sales')
      .set({
        status: PosSaleMachine.next('open', 'pay'),
        paid_at: now,
        revision: sale.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', saleId)
      .where('revision', '=', sale.revision)
      .executeTakeFirstOrThrow();
    await this.postSalePaid(trx, sale, tenders, actor, correlationId);
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.pos_sale_paid',
      targetType: 'pos_sale',
      targetId: saleId,
      beforeRevision: sale.revision,
      afterRevision: sale.revision + 1,
      correlationId,
      details: { totalMinor: sale.total_minor, currency: sale.currency },
    });
    await this.announce(trx, { ...sale, status: 'paid' }, correlationId);
    return true;
  }

  private async postSalePaid(
    trx: Trx,
    sale: PosSaleRow,
    tenders: Array<{
      kind: string;
      amount_minor: number;
      payment_attempt_id: string | null;
    }>,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const lines = await trx
      .selectFrom('pos_sale_lines')
      .select(['kind', 'base_minor', 'charges'])
      .where('organization_id', '=', sale.organization_id)
      .where('sale_id', '=', sale.id)
      .orderBy('line_number')
      .execute();
    const cardAttempts = tenders
      .filter((t) => t.kind === 'card' && t.payment_attempt_id)
      .map((t) => t.payment_attempt_id as string);
    const fees =
      cardAttempts.length === 0
        ? []
        : await trx
            .selectFrom('payment_attempts')
            .select('processor_fee_minor')
            .where('organization_id', '=', sale.organization_id)
            .where('id', 'in', cardAttempts)
            .execute();
    const feeMinor = fees.reduce((sum, f) => sum + Number(f.processor_fee_minor ?? 0), 0);
    const drawer = tenders
      .filter((t) => t.kind !== 'card')
      .reduce((sum, t) => sum + Number(t.amount_minor), 0);
    const processor = tenders
      .filter((t) => t.kind === 'card')
      .reduce((sum, t) => sum + Number(t.amount_minor), 0);
    const posting: PostingLine[] = [
      { account: 'cash_on_hand', debitMinor: drawer, memo: 'cash and external tenders' },
      { account: 'cash_processor', debitMinor: processor, memo: 'card tenders' },
      ...revenueLines(
        lines.map((l) => ({
          kind: l.kind,
          baseMinor: Number(l.base_minor),
          charges: l.charges as PosLineChargeRecord[],
        })),
        'credit',
      ),
      { account: 'processor_fees', debitMinor: feeMinor, memo: 'card processing fees' },
      { account: 'cash_processor', creditMinor: feeMinor, memo: 'card processing fees' },
    ];
    await this.ledger.post(trx, {
      organizationId: sale.organization_id,
      sourceType: 'pos_sale',
      sourceId: sale.id,
      purpose: 'pos_sale_paid',
      description: `Point-of-sale sale ${sale.sale_number}`,
      currency: sale.currency,
      actor,
      correlationId,
      lines: posting,
    });
  }

  /** The return's journal: revenue, taxes and fees given back, against the drawer or refunds. */
  async postReturn(
    trx: Trx,
    sale: PosSaleRow,
    returnId: string,
    returned: PosReturnLineRecord[],
    lineKinds: Map<string, string>,
    tenderKind: 'cash' | 'card' | 'external',
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const amount = returned.reduce((sum, l) => sum + l.amountMinor, 0);
    const posting: PostingLine[] = [
      ...revenueLines(
        returned.map((l) => ({
          kind: lineKinds.get(l.saleLineId) ?? 'merchandise',
          baseMinor: l.baseMinor,
          charges: l.charges,
        })),
        'debit',
      ),
      tenderKind === 'card'
        ? { account: 'refunds', creditMinor: amount, memo: 'card return refund' }
        : { account: 'cash_on_hand', creditMinor: amount, memo: `${tenderKind} return` },
    ];
    await this.ledger.post(trx, {
      organizationId: sale.organization_id,
      sourceType: 'pos_return',
      sourceId: returnId,
      purpose: 'pos_return',
      description: `Return on point-of-sale sale ${sale.sale_number}`,
      currency: sale.currency,
      actor,
      correlationId,
      lines: posting,
    });
  }

  /**
   * A card return's refund failed (finance.refund_settled): the return stands (goods came back,
   * the refund is owed: `refunds` keeps its credit), and the finance operator is asked to refund it
   * another way or retry (SPK-PAY-008). Idempotent: one exception per refund.
   */
  async onRefundSettled(
    trx: Trx,
    organizationId: string,
    payload: { refundAttemptId: string; status: 'succeeded' | 'failed' },
  ): Promise<void> {
    if (payload.status !== 'failed') return;
    const posReturn = await trx
      .selectFrom('pos_returns')
      .select(['id', 'sale_id', 'amount_minor', 'currency'])
      .where('organization_id', '=', organizationId)
      .where('refund_attempt_id', '=', payload.refundAttemptId)
      .executeTakeFirst();
    if (!posReturn) return;
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.pos_return_refund_failed',
      severity: 'high',
      title: 'The card refund of a point-of-sale return failed; the customer is still owed it',
      affectedType: 'pos_return',
      affectedId: posReturn.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `pos-return-refund-failed:${posReturn.id}`,
      details: {
        saleId: posReturn.sale_id,
        refundAttemptId: payload.refundAttemptId,
        amountMinor: Number(posReturn.amount_minor),
        currency: posReturn.currency,
      },
    });
  }

  async announce(
    trx: Trx,
    sale: Pick<
      PosSaleRow,
      'id' | 'organization_id' | 'register_session_id' | 'status' | 'total_minor' | 'currency'
    >,
    correlationId: string | null,
  ): Promise<void> {
    await this.outbox.enqueue(trx, FinanceEvents.posSaleChanged, {
      organizationId: sale.organization_id,
      aggregateType: 'pos_sale',
      aggregateId: sale.id,
      correlationId,
      payload: {
        saleId: sale.id,
        registerSessionId: sale.register_session_id,
        status: sale.status,
        totalMinor: Number(sale.total_minor),
        currency: sale.currency,
      },
    });
  }
}

/** Revenue per product kind and charges per code, as debit or credit lines (memo names them). */
function revenueLines(
  lines: Array<{
    kind: string;
    baseMinor: number;
    charges: Array<{ code: string; kind: 'tax' | 'fee'; amountMinor: number }>;
  }>,
  side: 'debit' | 'credit',
): PostingLine[] {
  const revenue = new Map<string, number>();
  const charges = new Map<string, { kind: 'tax' | 'fee'; code: string; amount: number }>();
  for (const line of lines) {
    revenue.set(line.kind, (revenue.get(line.kind) ?? 0) + line.baseMinor);
    for (const charge of line.charges) {
      const key = `${charge.kind}:${charge.code}`;
      const current = charges.get(key) ?? { kind: charge.kind, code: charge.code, amount: 0 };
      current.amount += charge.amountMinor;
      charges.set(key, current);
    }
  }
  const amount = (value: number) =>
    side === 'debit' ? { debitMinor: value } : { creditMinor: value };
  return [
    ...[...revenue].map(([kind, value]) => ({
      account: 'pos_revenue' as const,
      ...amount(value),
      memo: `product kind ${kind}`,
    })),
    ...[...charges.values()].map((c) => ({
      account: c.kind === 'tax' ? ('taxes_payable' as const) : ('fees_payable' as const),
      ...amount(c.amount),
      memo: `charge ${c.code}`,
    })),
  ];
}
