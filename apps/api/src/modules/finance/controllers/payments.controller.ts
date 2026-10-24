import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import {
  CreateRefundBody,
  PaymentWebhookBody,
  errors,
  z,
  type PaymentAttempt,
  type Principal,
  type Refund,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  Inbox,
  Public,
  ZodBody,
  ZodParams,
  ZodValidationPipe,
} from '../../../kernel';
import { CorrelationId } from '../finance.shared';
import { Inject } from '@nestjs/common';
import { PAYMENT_PROVIDER_PORT, type PaymentProviderPort } from '../finance.ports';
import { FAKE_PAYMENTS_SIGNATURE_HEADER } from '../providers/fake-payment.provider';
import { PaymentsService } from '../services/payments.service';
import { RefundsService } from '../services/refunds.service';

const IdParams = z.object({ id: z.uuid() });
const webhookPipe = new ZodValidationPipe(PaymentWebhookBody);

/** Payment attempts, `POST /v1/payments/{id}/refunds` (SPK-PAY-008) and reconciliation (SPK-PAY-007). */
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Get('payments/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PaymentAttempt> {
    return this.payments.get(principal, params.id);
  }

  @Post('payments/:id/refunds')
  @Idempotent()
  refund(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateRefundBody) body: z.infer<typeof CreateRefundBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Refund> {
    return this.refunds.request(principal, params.id, body, correlationId);
  }

  @Post('payments/:id/reconcile')
  @Idempotent()
  reconcilePayment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PaymentAttempt> {
    return this.payments.reconcileCommand(principal, params.id, correlationId);
  }

  @Get('refunds/:id')
  getRefund(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Refund> {
    return this.refunds.get(principal, params.id);
  }

  @Post('refunds/:id/reconcile')
  @Idempotent()
  reconcileRefund(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Refund> {
    return this.refunds.reconcileCommand(principal, params.id, correlationId);
  }
}

/**
 * Provider webhooks (§4.11): authenticate the event, record it durably and idempotently in the
 * kernel inbox, and let the inbox worker apply it. Nothing about a payment changes in this
 * request. Only the fake provider exists until a processor is selected (DEC-019).
 */
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(
    private readonly inbox: Inbox,
    @Inject(PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
  ) {}

  @Public()
  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Body() raw: unknown,
    @Headers(FAKE_PAYMENTS_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ inboxEventId: string; duplicate: boolean }> {
    if (provider !== this.provider.name) throw errors.notFound('payment provider', provider);
    if (!this.provider.verifyWebhook(raw, signature)) {
      throw errors.authenticationRequired('The webhook signature is invalid.');
    }
    const body: z.infer<typeof PaymentWebhookBody> = webhookPipe.transform(raw);
    const recorded = await this.inbox.record({
      provider,
      providerEventId: body.id,
      eventType: body.type,
      payload: { sequence: body.sequence, data: body.data },
      organizationId: body.data.organizationId,
      signatureVerified: true,
    });
    return { inboxEventId: recorded.id, duplicate: recorded.duplicate };
  }
}
