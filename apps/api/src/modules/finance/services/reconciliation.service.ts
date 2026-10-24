import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CreateSettlementReconciliationInput,
  type LedgerBalance,
  type Principal,
  type ReconciliationReport,
  type ReconciliationReportQuery,
  type SettlementReconciliation,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import { organizationOf, toSettlement, type Reader } from '../finance.shared';
import { LedgerService } from '../ledger/ledger.service';

const zero = sql<number>`0`;

/**
 * Reconciliation (SPK-PAY-010/011, §4.11 step 10). A settlement reconciliation compares what the
 * subledger expects — provider receipts minus processor fees minus settled refunds, or the cash
 * tenders a drawer holds — with what the processor or the counted drawer reports; any difference
 * is a discrepancy with an owned exception. The report keeps orders, obligations, receipts,
 * refunds, credits, processor fees, disputes, settlements and cash apart: payment volume is not
 * revenue, and balances are always computed from the append-only journal.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly ledger: LedgerService,
  ) {}

  private async require(
    principal: Principal,
    organizationId: string,
    facilityId?: string | null,
  ): Promise<void> {
    await this.authorization.require(principal, FinanceActions.reconcile, {
      type: 'settlement_reconciliation',
      organizationId,
      facilityId: facilityId ?? null,
    });
  }

  async create(
    principal: Principal,
    input: CreateSettlementReconciliationInput,
    correlationId: string | null,
  ): Promise<SettlementReconciliation> {
    const organizationId = organizationOf(principal);
    await this.require(principal, organizationId, input.facilityId);
    const from = new Date(input.periodStart);
    const to = new Date(input.periodEnd);
    try {
      return await this.uow.run(async ({ trx }) => {
        const id = newId();
        const now = this.clock.now();
        let expected: number;
        let breakdown: Record<string, unknown>;
        let tenderIds: string[] = [];
        if (input.kind === 'processor_settlement') {
          const computed = await this.processorExpectation(
            trx,
            organizationId,
            input.provider as string,
            input.currency,
            from,
            to,
          );
          expected = computed.expected;
          breakdown = computed.breakdown;
        } else {
          const tenders = await trx
            .selectFrom('cash_tenders')
            .select(['id', 'amount_minor'])
            .where('organization_id', '=', organizationId)
            .where('facility_id', '=', input.facilityId as string)
            .where('currency', '=', input.currency)
            .where('status', '=', 'recorded')
            .where('recorded_at', '>=', from)
            .where('recorded_at', '<', to)
            .forUpdate()
            .execute();
          tenderIds = tenders.map((t) => t.id);
          expected = tenders.reduce((acc, t) => acc + t.amount_minor, 0);
          breakdown = { tenderCount: tenders.length, tenderIds };
        }
        const difference = input.reportedMinor - expected;
        const status = difference === 0 ? 'balanced' : 'discrepancy';
        await trx
          .insertInto('settlement_reconciliations')
          .values({
            id,
            organization_id: organizationId,
            kind: input.kind,
            provider: input.kind === 'processor_settlement' ? (input.provider ?? null) : null,
            facility_id: input.kind === 'cash_drawer' ? (input.facilityId ?? null) : null,
            period_start: from,
            period_end: to,
            currency: input.currency,
            expected_minor: expected,
            reported_minor: input.reportedMinor,
            difference_minor: difference,
            breakdown: json(breakdown),
            status,
            external_reference: input.externalReference ?? null,
            notes: input.notes ?? null,
            performed_by: json(snapshotActor(principal)),
            performed_by_person_id: principal.personId,
            performed_at: now,
          })
          .execute();
        if (tenderIds.length > 0) {
          await trx
            .updateTable('cash_tenders')
            .set((eb) => ({
              status: 'reconciled',
              reconciliation_id: id,
              revision: eb('revision', '+', 1),
            }))
            .where('organization_id', '=', organizationId)
            .where('id', 'in', tenderIds)
            .execute();
        }
        if (status === 'discrepancy') {
          await this.exceptions.raise(trx, {
            organizationId,
            facilityId: input.kind === 'cash_drawer' ? (input.facilityId ?? null) : null,
            category: 'finance.settlement_discrepancy',
            severity: 'high',
            title: `The ${input.kind === 'cash_drawer' ? 'cash drawer' : 'processor settlement'} does not match the ledger`,
            affectedType: 'settlement_reconciliation',
            affectedId: id,
            ownerQueue: 'finance_operator',
            dedupeKey: `settlement:${id}`,
            details: {
              expectedMinor: expected,
              reportedMinor: input.reportedMinor,
              differenceMinor: difference,
            },
          });
        }
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: FinanceActions.reconcile.id,
          targetType: 'settlement_reconciliation',
          targetId: id,
          afterRevision: 1,
          reason: input.reason ?? null,
          correlationId,
          details: {
            kind: input.kind,
            expectedMinor: expected,
            reportedMinor: input.reportedMinor,
          },
        });
        await this.outbox.enqueue(trx, FinanceEvents.settlementReconciled, {
          organizationId,
          aggregateType: 'settlement_reconciliation',
          aggregateId: id,
          correlationId,
          payload: {
            organizationId,
            reconciliationId: id,
            kind: input.kind,
            status,
            differenceMinor: difference,
          },
        });
        const row = await trx
          .selectFrom('settlement_reconciliations')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return toSettlement(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict('This settlement was already reconciled.', {
          code: 'SETTLEMENT_ALREADY_RECONCILED',
        });
      }
      throw error;
    }
  }

  private async processorExpectation(
    db: Reader | Trx,
    organizationId: string,
    provider: string,
    currency: string,
    from: Date,
    to: Date,
  ): Promise<{ expected: number; breakdown: Record<string, unknown> }> {
    const receipts = await db
      .selectFrom('receipts')
      .innerJoin('payment_attempts', 'payment_attempts.id', 'receipts.payment_attempt_id')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number>('receipts.amount_minor'), zero).as('gross'),
        eb.fn.coalesce(eb.fn.sum<number>('receipts.processor_fee_minor'), zero).as('fees'),
        eb.fn.countAll<number>().as('count'),
      ])
      .where('receipts.organization_id', '=', organizationId)
      .where('payment_attempts.provider', '=', provider)
      .where('receipts.currency', '=', currency)
      .where('receipts.received_at', '>=', from)
      .where('receipts.received_at', '<', to)
      .executeTakeFirst();
    const refunds = await db
      .selectFrom('refund_attempts')
      .select((eb) => [eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), zero).as('refunded')])
      .where('organization_id', '=', organizationId)
      .where('provider', '=', provider)
      .where('currency', '=', currency)
      .where('status', '=', 'succeeded')
      .where('resolved_at', '>=', from)
      .where('resolved_at', '<', to)
      .executeTakeFirst();
    const gross = Number(receipts?.gross ?? 0);
    const fees = Number(receipts?.fees ?? 0);
    const refunded = Number(refunds?.refunded ?? 0);
    return {
      expected: gross - fees - refunded,
      breakdown: {
        receiptsMinor: gross,
        receiptCount: Number(receipts?.count ?? 0),
        processorFeesMinor: fees,
        refundsMinor: refunded,
      },
    };
  }

  async ledgerBalances(principal: Principal, currency: string): Promise<LedgerBalance[]> {
    const organizationId = organizationOf(principal);
    await this.require(principal, organizationId);
    return this.ledger.balances(this.db, organizationId, currency);
  }

  async report(
    principal: Principal,
    query: ReconciliationReportQuery,
  ): Promise<ReconciliationReport> {
    const organizationId = organizationOf(principal);
    await this.require(principal, organizationId);
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from) throw errors.validation('`to` must be after `from`.');
    const currency = query.currency;
    const db = this.db;
    const orders = await db
      .selectFrom('orders')
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(sql`case when paid_at is not null then total_minor else 0 end`),
            zero,
          )
          .as('total'),
        eb.fn.count<number>('paid_at').as('paid'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      // Orders whose payment or cancellation fact falls in the window (application-clock facts).
      .where((eb) =>
        eb.or([
          eb.and([eb('paid_at', '>=', from), eb('paid_at', '<', to)]),
          eb.and([eb('canceled_at', '>=', from), eb('canceled_at', '<', to)]),
        ]),
      )
      .executeTakeFirst();
    const open = await db
      .selectFrom('obligations')
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        eb.fn
          .coalesce(eb.fn.sum<number>(sql`amount_minor - allocated_minor`), zero)
          .as('remaining'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .where('status', '=', 'open')
      .executeTakeFirst();
    const settled = await db
      .selectFrom('obligations')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .where('status', '=', 'settled')
      .where('settled_at', '>=', from)
      .where('settled_at', '<', to)
      .executeTakeFirst();
    const receipts = await db
      .selectFrom('receipts')
      .select((eb) => [
        eb.fn
          .coalesce(
            eb.fn.sum<number>(
              sql`case when source_kind = 'payment_attempt' then amount_minor else 0 end`,
            ),
            zero,
          )
          .as('processor'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(
              sql`case when source_kind = 'cash_tender' then amount_minor else 0 end`,
            ),
            zero,
          )
          .as('cash'),
        eb.fn.coalesce(eb.fn.sum<number>('excess_minor'), zero).as('excess'),
        eb.fn.coalesce(eb.fn.sum<number>('processor_fee_minor'), zero).as('fees'),
        eb.fn.countAll<number>().as('count'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .where('received_at', '>=', from)
      .where('received_at', '<', to)
      .executeTakeFirst();
    const refunds = await db
      .selectFrom('refund_attempts')
      .select((eb) => [
        eb.fn
          .coalesce(
            eb.fn.sum<number>(sql`case when status = 'succeeded' then amount_minor else 0 end`),
            zero,
          )
          .as('succeeded'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(
              sql`case when reservation_status = 'reserved' then amount_minor else 0 end`,
            ),
            zero,
          )
          .as('reserved'),
        eb.fn
          .coalesce(eb.fn.sum<number>(sql`case when status = 'unknown' then 1 else 0 end`), zero)
          .as('unknown'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .executeTakeFirst();
    const credits = await db
      .selectFrom('credits')
      .select((eb) => [
        eb.fn
          .coalesce(
            eb.fn.sum<number>(
              sql`case when status <> 'pending_approval' then original_minor else 0 end`,
            ),
            zero,
          )
          .as('issued'),
        eb.fn
          .coalesce(eb.fn.sum<number>(sql`original_minor - remaining_minor`), zero)
          .as('redeemed'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(
              sql`case when status = 'pending_approval' then original_minor else 0 end`,
            ),
            zero,
          )
          .as('pending'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .executeTakeFirst();
    const cash = await db
      .selectFrom('cash_tenders')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), zero).as('recorded'),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(sql`case when status = 'recorded' then amount_minor else 0 end`),
            zero,
          )
          .as('unreconciled'),
      ])
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .where('recorded_at', '>=', from)
      .where('recorded_at', '<', to)
      .executeTakeFirst();
    const settlements = await db
      .selectFrom('settlement_reconciliations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('currency', '=', currency)
      .where('period_start', '<', to)
      .where('period_end', '>', from)
      .orderBy('period_start')
      .execute();
    const unknownPayments = await db
      .selectFrom('payment_attempts')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'unknown')
      .executeTakeFirst();
    const recovery = await db
      .selectFrom('checkouts')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'recovery_required')
      .executeTakeFirst();
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      currency,
      orders: {
        count: Number(orders?.count ?? 0),
        totalMinor: Number(orders?.total ?? 0),
        paidCount: Number(orders?.paid ?? 0),
      },
      obligations: {
        openCount: Number(open?.count ?? 0),
        openRemainingMinor: Number(open?.remaining ?? 0),
        settledCount: Number(settled?.count ?? 0),
      },
      receipts: {
        processorMinor: Number(receipts?.processor ?? 0),
        cashMinor: Number(receipts?.cash ?? 0),
        count: Number(receipts?.count ?? 0),
        excessMinor: Number(receipts?.excess ?? 0),
      },
      refunds: {
        succeededMinor: Number(refunds?.succeeded ?? 0),
        reservedMinor: Number(refunds?.reserved ?? 0),
        unknownCount: Number(refunds?.unknown ?? 0),
      },
      credits: {
        issuedMinor: Number(credits?.issued ?? 0),
        redeemedMinor: Number(credits?.redeemed ?? 0),
        pendingApprovalMinor: Number(credits?.pending ?? 0),
      },
      processorFeesMinor: Number(receipts?.fees ?? 0),
      disputes: {
        count: 0,
        note: 'Disputes (chargebacks) are not reported by the fake provider; the dispute flow awaits the processor decision (DEC-019).',
      },
      settlements: settlements.map(toSettlement),
      cash: {
        recordedMinor: Number(cash?.recorded ?? 0),
        unreconciledMinor: Number(cash?.unreconciled ?? 0),
      },
      exceptions: {
        unknownPayments: Number(unknownPayments?.count ?? 0),
        recoveryRequiredCheckouts: Number(recovery?.count ?? 0),
      },
      ledger: await this.ledger.balances(db, organizationId, currency),
    };
  }
}
