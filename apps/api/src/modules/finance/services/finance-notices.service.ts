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

  /** The checkout's payer, order and what was paid (the payment attempt), for recovery copy. */
  private async checkoutFacts(trx: Trx, organizationId: string, checkoutId: string) {
    const checkout = await trx
      .selectFrom('checkouts')
      .select(['payer_person_id', 'order_id', 'payment_attempt_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkoutId)
      .executeTakeFirst();
    if (!checkout) return null;
    const payment = checkout.payment_attempt_id
      ? await trx
          .selectFrom('payment_attempts')
          .select(['amount_minor', 'currency'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', checkout.payment_attempt_id)
          .executeTakeFirst()
      : undefined;
    return { checkout, payment };
  }

  /**
   * finance.checkout_recovery_required → the payer (R2-JOURNEYS-04, SPK-AT-023, SPK-COMMS-002):
   * the payment was taken but the registration could not be completed, and the family is told what
   * happens to the money next (a refund, a credit, or staff contact), never that the place is held.
   */
  async checkoutRecoveryRequired(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.checkoutRecoveryRequired>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const facts = await this.checkoutFacts(trx, organizationId, event.payload.checkoutId);
    if (!facts) return;
    const paid = facts.payment
      ? `Your payment of ${amount(facts.payment.amount_minor, facts.payment.currency)} was received`
      : 'Your payment was received';
    const next =
      event.payload.plan === 'refund'
        ? 'It will be refunded to your payment method, and you will be told when the refund is made.'
        : event.payload.plan === 'credit'
          ? 'It will be kept as a credit on your account, and you will be told when the credit is added.'
          : 'Our staff will contact you about the payment.';
    const facility = await this.facilityOfOrder(trx, organizationId, event.payload.orderId);
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_checkout_recovery'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'order', id: event.payload.orderId },
        audience: { subjectPersonIds: [facts.checkout.payer_person_id] },
        protected: true,
        title: 'Your registration could not be completed',
        body: `${paid}, but the registration could not be completed. ${next}`,
      },
    );
  }

  /**
   * finance.checkout_compensated → the payer (R2-JOURNEYS-04, SPK-AT-023): the refund was made or
   * the credit added, with its amount.
   */
  async checkoutCompensated(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.checkoutCompensated>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const facts = await this.checkoutFacts(trx, organizationId, event.payload.checkoutId);
    if (!facts) return;
    let body: string;
    if (event.payload.method === 'refund') {
      const refund = event.payload.refundAttemptId
        ? await trx
            .selectFrom('refund_attempts')
            .select(['amount_minor', 'currency', 'reversed_at'])
            .where('organization_id', '=', organizationId)
            .where('id', '=', event.payload.refundAttemptId)
            .executeTakeFirst()
        : undefined;
      // R4-PROVIDER-OUTCOMES-02 (§4.11): the provider already reported the refund failed, so it
      // was not made; `refundReversed` tells the payer that instead.
      if (refund?.reversed_at) return;
      body = refund
        ? `The refund of ${amount(refund.amount_minor, refund.currency)} for the registration that could not be completed has been made to your payment method.`
        : 'The refund for the registration that could not be completed has been made to your payment method.';
    } else {
      const credit = event.payload.creditId
        ? await trx
            .selectFrom('credits')
            .select(['original_minor', 'currency'])
            .where('organization_id', '=', organizationId)
            .where('id', '=', event.payload.creditId)
            .executeTakeFirst()
        : undefined;
      body = credit
        ? `A credit of ${amount(credit.original_minor, credit.currency)} for the registration that could not be completed has been added to your account.`
        : 'A credit for the registration that could not be completed has been added to your account.';
    }
    const facility = await this.facilityOfOrder(trx, organizationId, event.payload.orderId);
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_checkout_compensated'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'order', id: event.payload.orderId },
        audience: { subjectPersonIds: [facts.checkout.payer_person_id] },
        protected: true,
        title: event.payload.method === 'refund' ? 'Your refund was made' : 'A credit was added',
        body,
      },
    );
  }

  /**
   * finance.refund_reversed → the payer of a compensation refund (R4-PROVIDER-OUTCOMES-02, §4.11,
   * SPK-AT-023, SPK-COMMS-002): the checkout was compensated by this refund, so the payer was (or
   * is about to be) told the refund was made; the provider has since reported it failed, so the
   * money did not reach them. The notice says so and that the facility will contact them (a
   * reversed compensation refund is the finance operator's decision, not retried automatically).
   * Nothing is sent for a customer refund (finance sent no "refund made" notice for it) or when the
   * checkout was not compensated by this refund.
   */
  async refundReversed(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.refundReversed>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const { purpose, checkoutId, refundAttemptId } = event.payload;
    if (purpose !== 'compensation' || !checkoutId) return;
    const checkout = await trx
      .selectFrom('checkouts')
      .select(['payer_person_id', 'order_id', 'status', 'recovery'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkoutId)
      .executeTakeFirst();
    const recovery = (checkout?.recovery ?? null) as {
      plan?: string;
      refundAttemptId?: string | null;
    } | null;
    if (
      !checkout ||
      checkout.status !== 'compensated' ||
      recovery?.plan !== 'refund' ||
      recovery.refundAttemptId !== refundAttemptId
    ) {
      return;
    }
    const facility = await this.facilityOfOrder(trx, organizationId, checkout.order_id);
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_refund_reversed'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'order', id: checkout.order_id },
        audience: { subjectPersonIds: [checkout.payer_person_id] },
        protected: true,
        title: 'Your refund did not go through',
        body: `The refund of ${amount(event.payload.amountMinor, event.payload.currency)} for the registration that could not be completed did not go through, so the money has not been returned to your payment method. The facility will contact you about it.`,
      },
    );
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

  /**
   * finance.payment_reminder_requested → the debtor, or the responsible payer of a team fee
   * (SPK-COMMS-002 payment attention, park UI redesign): an essential notice (the policy binds
   * `payment_attention` to the operational category, SPK-COMMS-007; which channels carry it is
   * pending DEC-062) stating the balance and due date as recorded on the reminder.
   */
  async paymentReminder(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof FinanceEvents.paymentReminderRequested>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const obligation = await trx
      .selectFrom('obligations')
      .select(['description', 'order_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.obligationId)
      .executeTakeFirst();
    // Settled or canceled before the notice went out: nothing is owed, so nothing is said.
    if (!obligation || obligation.status !== 'open') return;
    const facility = await this.facilityOfOrder(trx, organizationId, obligation.order_id);
    await this.compose(
      trx,
      financeSystem(organizationId, 'finance.notify_payment_reminder'),
      event,
      {
        kind: 'payment_attention',
        facilityId: facility?.facilityId,
        subject: { type: 'obligation', id: event.payload.obligationId },
        audience: { subjectPersonIds: [event.payload.recipientPersonId] },
        protected: true,
        title: 'A payment is past due',
        body: `${amount(event.payload.remainingMinor, event.payload.currency)} toward ${obligation.description} was due on ${localDateTime(new Date(event.payload.dueAt), facility?.timezone ?? null)}. You can review and pay it in the app.`,
      },
    );
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
