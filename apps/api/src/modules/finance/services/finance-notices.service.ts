import { Inject, Injectable } from '@nestjs/common';
import {
  formatMoney,
  money,
  type DomainEvent,
  type EventPayload,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation } from '@sportspark/db';
import { CLOCK, FacilityDirectory, type Clock, type Trx } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { NotificationsService, type ComposeInput } from '../../communications';
import type { FinanceEvents } from '../finance.events';
import { financeSystem, withSavepoint } from '../finance.shared';

/** An instant as a facility-local date and time with the zone named (SPK-SCHED-008). */
function localDateTime(instant: Date, timezone: string | null): string {
  if (!timezone) return `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
  return `${text} (${timezone})`;
}

function amount(amountMinor: number, currency: string): string {
  try {
    return formatMoney(money(amountMinor, currency));
  } catch {
    return `${amountMinor} ${currency} (minor units)`;
  }
}

/**
 * Finance-owned customer notices (FIN-05; SPK-COMMS-002 `payment_attention`, SPK-PAY-004,
 * SPK-PAY-006; IF-22): communications does not import finance, so finance composes its own
 * notices in the handler's transaction through `NotificationsService.composeAndQueueIn`, with the
 * event id as `sourceEventId`: one notice per event, and a replay composes nothing new (the
 * notification's unique source key, caught inside a savepoint). The subject person is the
 * protected audience, so recipients are that person (an active adult) and the holders of
 * `receive_messages` over them, resolved and re-checked by communications (SPK-COMMS-003).
 *
 * Copy states amounts with their currency and only what is known: a failed payment "did not go
 * through"; nothing here is sent for an unknown outcome, and nothing implies money was taken
 * unless it was. The wording is not a policy value (the communication policy is DEC-012).
 */
@Injectable()
export class FinanceNotices {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly facilities: FacilityDirectory,
    private readonly notifications: NotificationsService,
  ) {}

  private async compose(
    trx: Trx,
    principal: Principal,
    event: DomainEvent<unknown>,
    input: Omit<ComposeInput, 'sourceEventId' | 'correlationId'>,
  ): Promise<void> {
    try {
      await withSavepoint(trx, 'finance_notice', () =>
        this.notifications.composeAndQueueIn(trx, principal, {
          ...input,
          sourceEventId: event.id,
          correlationId: event.correlationId,
        }),
      );
    } catch (error) {
      // A replayed event: its notice exists already (notifications_source_event_idx).
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  /** The facility (and its zone) of an order's first line, for local times in copy. */
  private async facilityOfOrder(
    trx: Trx,
    organizationId: string,
    orderId: string | null,
  ): Promise<{ facilityId: string; timezone: string | null } | null> {
    if (!orderId) return null;
    const line = await trx
      .selectFrom('order_lines')
      .select('offering_id')
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', orderId)
      .orderBy('sequence')
      .executeTakeFirst();
    if (!line) return null;
    const snapshot = await this.offerings.getOffering(
      organizationId,
      line.offering_id,
      this.clock.now(),
      trx,
    );
    if (!snapshot) return null;
    const facilityId = snapshot.offering.facilityId;
    const facility = (await this.facilities.describe(organizationId, [facilityId], trx)).get(
      facilityId,
    );
    return { facilityId, timezone: facility?.timezone ?? null };
  }

  /** finance.contribution_requested → the requested player (SPK-PAY-004). */
  async contributionRequested(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.contributionRequested>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const obligation = await trx
      .selectFrom('obligations')
      .select(['description', 'due_at'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.obligationId)
      .executeTakeFirst();
    await this.compose(trx, financeSystem(organizationId, 'finance.notify_contribution'), event, {
      kind: 'payment_attention',
      subject: { type: 'contribution_request', id: event.payload.contributionRequestId },
      audience: { subjectPersonIds: [event.payload.requestedPersonId] },
      protected: true,
      title: 'A team contribution is requested',
      body: `A contribution of ${amount(event.payload.amountMinor, event.payload.currency)} is requested toward ${obligation?.description ?? 'the team fee'}. You can review and pay it in the app.`,
    });
  }

  /** finance.payment_failed → the payer (SPK-COMMS-002 payment attention). */
  async paymentFailed(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.paymentFailed>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const attempt = await trx
      .selectFrom('payment_attempts')
      .select(['payer_person_id', 'amount_minor', 'currency', 'purpose', 'order_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.paymentAttemptId)
      .executeTakeFirst();
    // A point-of-sale card is declined in front of the cashier; installments have their own notice.
    if (!attempt || attempt.purpose === 'pos_sale' || attempt.purpose === 'installment') return;
    const facility = await this.facilityOfOrder(trx, organizationId, attempt.order_id);
    await this.compose(trx, financeSystem(organizationId, 'finance.notify_payment_failed'), event, {
      kind: 'payment_attention',
      facilityId: facility?.facilityId,
      subject: { type: 'payment_attempt', id: event.payload.paymentAttemptId },
      audience: { subjectPersonIds: [attempt.payer_person_id] },
      protected: true,
      title: 'A payment did not go through',
      body: `The payment of ${amount(attempt.amount_minor, attempt.currency)} did not go through${event.payload.status === 'canceled' ? ' (it was canceled)' : ''}. You can pay again in the app.`,
    });
  }

  /** finance.installment_failed → the plan's payer (SPK-PAY-006). */
  async installmentFailed(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.installmentFailed>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const installment = await trx
      .selectFrom('installments')
      .select(['amount_minor', 'currency', 'next_retry_at'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.installmentId)
      .executeTakeFirst();
    if (!installment) return;
    const facility = await this.facilityOfOrder(trx, organizationId, event.payload.orderId);
    const retry = installment.next_retry_at
      ? ` It will be tried again on ${localDateTime(new Date(installment.next_retry_at), facility?.timezone ?? null)}.`
      : ' The facility will contact you about it.';
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_installment_failed'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'installment', id: event.payload.installmentId },
        audience: { subjectPersonIds: [event.payload.payerPersonId] },
        protected: true,
        title: 'An installment payment did not go through',
        body: `The installment of ${amount(installment.amount_minor, installment.currency)} could not be collected with the payment method you authorized.${retry}`,
      },
    );
  }

  /** finance.installment_notice → the plan's payer, ahead of the due date (SPK-PAY-006). */
  async installmentNotice(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.installmentNotice>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const plan = await trx
      .selectFrom('installments')
      .innerJoin('installment_plans', (join) =>
        join
          .onRef('installment_plans.id', '=', 'installments.plan_id')
          .onRef('installment_plans.organization_id', '=', 'installments.organization_id'),
      )
      .select(['installment_plans.order_id as order_id'])
      .where('installments.organization_id', '=', organizationId)
      .where('installments.id', '=', event.payload.installmentId)
      .executeTakeFirst();
    const facility = await this.facilityOfOrder(trx, organizationId, plan?.order_id ?? null);
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_installment_due'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'installment', id: event.payload.installmentId },
        audience: { subjectPersonIds: [event.payload.payerPersonId] },
        protected: true,
        title: 'An installment is coming due',
        body: `An installment of ${amount(event.payload.amountMinor, event.payload.currency)} is due on ${localDateTime(new Date(event.payload.dueAt), facility?.timezone ?? null)}. It will be collected with the payment method you authorized.`,
      },
    );
  }
}
