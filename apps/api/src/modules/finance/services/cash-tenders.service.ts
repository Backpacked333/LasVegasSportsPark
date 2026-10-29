import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CashTender,
  type Principal,
  type RecordCashTenderInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  executorFor,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  afterKeysetDesc,
  decodeKeyset,
  iso,
  keysetAt,
  keysetPage,
  organizationOf,
  toCashTender,
  type CashTenderRow,
  type Reader,
} from '../finance.shared';
import { MoneyFacts } from './money-facts.service';

/**
 * A recorded tender as other modules list it (FIN-02, for support's timeline SUP-03): what, how
 * much, where and when; never the evidence (§4.14: references and notes stay with finance).
 */
export interface CashTenderListItem {
  id: string;
  facilityId: string;
  tenderKind: CashTender['tenderKind'];
  payerPersonId: string;
  amountMinor: number;
  currency: string;
  obligationId: string | null;
  checkoutId: string | null;
  recordedByPersonId: string;
  recordedAt: string;
  status: CashTender['status'];
  reconciliationId: string | null;
}

/**
 * Cash and externally recorded tenders (SPK-PAY-012): only permitted desk and finance staff,
 * within their facility scope, with evidence (a reference at least), against an EXISTING
 * obligation. A tender is a receipt like any other (allocation, visible excess, journal to
 * `cash_on_hand`) and is reconciled later in a cash-drawer reconciliation. It never creates
 * participation: registrations paid in cash go through the checkout (quote, holds, capacity).
 */
@Injectable()
export class CashTendersService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facts: MoneyFacts,
  ) {}

  /**
   * The tenders paid by any of `personIds` (FIN-02, in-process for SUP-03): newest first on
   * (recorded_at desc, id desc), a keyset page. Reads through the given transaction or the root
   * database; the caller authorizes its own context first (this is a lookup, not an authorization).
   */
  async listForPersons(
    organizationId: string,
    personIds: readonly string[],
    page: { cursor?: string; limit: number },
    trx?: Reader,
  ): Promise<{ items: CashTenderListItem[]; nextCursor: string | null }> {
    if (personIds.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeKeyset(page.cursor);
    let q = (trx ?? executorFor(this.db))
      .selectFrom('cash_tenders')
      .selectAll()
      .select(keysetAt('cash_tenders', 'recorded_at').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', [...personIds])
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit + 1);
    if (cursor) q = q.where(afterKeysetDesc('cash_tenders', cursor, 'recorded_at'));
    const result = keysetPage(await q.execute(), page.limit);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        facilityId: row.facility_id,
        tenderKind: row.tender_kind,
        payerPersonId: row.payer_person_id,
        amountMinor: row.amount_minor,
        currency: row.currency,
        obligationId: row.obligation_id,
        checkoutId: row.checkout_id,
        recordedByPersonId: row.recorded_by_person_id,
        recordedAt: iso(row.recorded_at),
        status: row.status,
        reconciliationId: row.reconciliation_id,
      })),
      nextCursor: result.nextCursor,
    };
  }

  async record(
    principal: Principal,
    input: RecordCashTenderInput,
    correlationId: string | null,
  ): Promise<CashTender> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, FinanceActions.recordTender, {
      type: 'cash_tender',
      organizationId,
      facilityId: input.facilityId,
    });
    if (!principal.personId)
      throw errors.accessDenied('A tender is recorded by a named staff member.');
    return this.uow.run(async ({ trx }) => {
      const facility = await trx
        .selectFrom('facilities')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.facilityId)
        .executeTakeFirst();
      if (!facility) throw errors.notFound('facility', input.facilityId);
      const obligation = await this.facts.loadObligation(
        trx,
        organizationId,
        input.obligationId,
        true,
      );
      if (!obligation) throw errors.notFound('obligation', input.obligationId);
      if (obligation.status !== 'open') {
        throw errors.invalidTransition('Obligation', obligation.status, 'record_tender');
      }
      if (obligation.currency !== input.currency) {
        throw errors.validation('The tender currency differs from the obligation.', {
          obligationCurrency: obligation.currency,
        });
      }
      const payerPersonId =
        input.payerPersonId ??
        obligation.debtor_person_id ??
        obligation.responsible_payer_person_id;
      if (!payerPersonId)
        throw errors.validation('payerPersonId is required for a team obligation.');
      const id = newId();
      const now = this.clock.now();
      await trx
        .insertInto('cash_tenders')
        .values({
          id,
          organization_id: organizationId,
          facility_id: input.facilityId,
          tender_kind: input.tenderKind,
          payer_person_id: payerPersonId,
          amount_minor: input.amountMinor,
          currency: input.currency,
          obligation_id: obligation.id,
          checkout_id: null,
          evidence: json(input.evidence),
          recorded_by: json(snapshotActor(principal)),
          recorded_by_person_id: principal.personId as string,
          recorded_at: now,
          reconciliation_id: null,
        })
        .execute();
      const recorded = await this.facts.recordReceipt(trx, {
        organizationId,
        sourceKind: 'cash_tender',
        cashTenderId: id,
        payerPersonId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        processorFeeMinor: 0,
        cashAccount: 'cash_on_hand',
        obligationId: obligation.id,
        orderId: obligation.order_id,
        receivedAt: now,
        actor: principal,
        correlationId,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.recordTender.id,
        targetType: 'cash_tender',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          obligationId: obligation.id,
          amountMinor: input.amountMinor,
          tenderKind: input.tenderKind,
          excessMinor: recorded.receipt.excess_minor,
        },
      });
      await this.outbox.enqueue(trx, FinanceEvents.cashTenderRecorded, {
        organizationId,
        aggregateType: 'cash_tender',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          cashTenderId: id,
          facilityId: input.facilityId,
          amountMinor: input.amountMinor,
          currency: input.currency,
        },
      });
      const row = await trx
        .selectFrom('cash_tenders')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toCashTender(row as CashTenderRow, recorded.receipt, recorded.overpaymentCreditId);
    });
  }
}
