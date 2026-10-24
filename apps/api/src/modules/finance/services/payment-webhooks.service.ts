import { Injectable, Logger } from '@nestjs/common';
import { PaymentWebhookBody } from '@sportspark/contracts';
import { OperationalExceptions, type InboundEvent, type Trx } from '../../../kernel';
import type { ProviderPaymentStatus } from '../finance.ports';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

const PAYMENT_STATUS: Record<string, ProviderPaymentStatus> = {
  'payment.succeeded': 'succeeded',
  'payment.failed': 'failed',
  'payment.canceled': 'canceled',
  'payment.processing': 'processing',
  'payment.requires_action': 'requires_action',
};

/**
 * Applies authenticated provider events recorded in the kernel inbox (§4.11 step 6). The inbox
 * gives one consumption per event (duplicates are no-ops); this handler tolerates reordering:
 * evidence is applied through the state machines, so an older event never overrides a newer
 * fact and a contradiction (for example `succeeded` after `failed`) raises an exception instead
 * of flipping the record. The organization is always the stored attempt's, never the payload's.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly exceptions: OperationalExceptions,
  ) {}

  /** Provider evidence that matches no attempt of the organization may be real money: make it visible. */
  private async unmatched(
    trx: Trx,
    event: InboundEvent,
    organizationId: string,
    kind: string,
  ): Promise<void> {
    this.logger.warn(
      `${kind} event ${event.providerEventId} matches no attempt; raised for review`,
    );
    const known = await trx
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (!known) return;
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.unmatched_provider_event',
      severity: 'high',
      title: `A ${kind} event from the provider matches no recorded attempt`,
      affectedType: 'inbox_event',
      affectedId: event.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `unmatched:${event.id}`,
      details: { provider: event.provider, eventType: event.eventType },
    });
  }

  async apply(trx: Trx, event: InboundEvent): Promise<{ checkoutId: string | null }> {
    const body = PaymentWebhookBody.parse({
      id: event.providerEventId,
      type: event.eventType,
      ...(event.payload as Record<string, unknown>),
    });
    const data = body.data;
    if (body.type.startsWith('payment.')) {
      const attempt = data.paymentAttemptId
        ? await trx
            .selectFrom('payment_attempts')
            .select(['id', 'organization_id', 'checkout_id'])
            .where('id', '=', data.paymentAttemptId)
            .where('provider', '=', event.provider)
            .executeTakeFirst()
        : await trx
            .selectFrom('payment_attempts')
            .select(['id', 'organization_id', 'checkout_id'])
            .where('provider', '=', event.provider)
            .where('provider_reference', '=', data.providerReference)
            .executeTakeFirst();
      if (!attempt || attempt.organization_id !== data.organizationId) {
        await this.unmatched(trx, event, data.organizationId, 'payment');
        return { checkoutId: null };
      }
      await this.payments.applyEvidence(
        trx,
        attempt.organization_id,
        attempt.id,
        {
          status: PAYMENT_STATUS[body.type] as ProviderPaymentStatus,
          providerReference: data.providerReference,
          amountMinor: data.amountMinor ?? null,
          currency: data.currency ?? null,
          feeMinor: data.feeMinor ?? null,
          failureReason: data.failureReason ?? null,
          source: 'webhook',
          inboxEventId: event.id,
          sequence: body.sequence,
        },
        null,
      );
      return { checkoutId: attempt.checkout_id };
    }
    const refund = data.refundAttemptId
      ? await trx
          .selectFrom('refund_attempts')
          .select(['id', 'organization_id'])
          .where('id', '=', data.refundAttemptId)
          .where('provider', '=', event.provider)
          .executeTakeFirst()
      : await trx
          .selectFrom('refund_attempts')
          .select(['id', 'organization_id'])
          .where('provider', '=', event.provider)
          .where('provider_reference', '=', data.providerReference)
          .executeTakeFirst();
    if (!refund || refund.organization_id !== data.organizationId) {
      await this.unmatched(trx, event, data.organizationId, 'refund');
      return { checkoutId: null };
    }
    await this.refunds.applyEvidence(
      trx,
      refund.organization_id,
      refund.id,
      {
        status: body.type === 'refund.succeeded' ? 'succeeded' : 'failed',
        providerReference: data.providerReference,
        failureReason: data.failureReason ?? null,
        source: 'webhook',
        inboxEventId: event.id,
        sequence: body.sequence,
      },
      null,
    );
    return { checkoutId: null };
  }
}
