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
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import { organizationOf, toCashTender, type CashTenderRow } from '../finance.shared';
import { MoneyFacts } from './money-facts.service';

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
