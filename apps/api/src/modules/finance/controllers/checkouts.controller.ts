import { Controller, Get, Post } from '@nestjs/common';
import {
  AbortCheckoutBody,
  CompensateCheckoutBody,
  CreateCheckoutBody,
  CreateQuoteBody,
  RecoverCheckoutBody,
  RetryCheckoutPaymentBody,
  z,
  type Checkout,
  type Order,
  type Principal,
  type Quote,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId, organizationOf } from '../finance.shared';
import { CheckoutFinalizer } from '../services/checkout-finalizer.service';
import { CheckoutService } from '../services/checkout.service';
import { QuotesService } from '../services/quotes.service';

const IdParams = z.object({ id: z.uuid() });

/** §4.8 `POST /v1/registration-quotes` (SPK-PAY-001/002/003). */
@Controller('registration-quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateQuoteBody) body: z.infer<typeof CreateQuoteBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Quote> {
    return this.quotes.create(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Quote> {
    return this.quotes.get(principal, params.id);
  }
}

/** §4.8 `POST /v1/registration-checkouts` and the checkout's payment and recovery commands (§4.11). */
@Controller('registration-checkouts')
export class CheckoutsController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly finalizer: CheckoutFinalizer,
  ) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateCheckoutBody) body: z.infer<typeof CreateCheckoutBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Checkout> {
    return this.checkouts.create(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Checkout> {
    return this.checkouts.get(principal, params.id);
  }

  @Post(':id/payments')
  @Idempotent()
  retryPayment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetryCheckoutPaymentBody) body: z.infer<typeof RetryCheckoutPaymentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Checkout> {
    return this.checkouts.retryPayment(principal, params.id, body, correlationId);
  }

  @Post(':id/abort')
  @Idempotent()
  async abort(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AbortCheckoutBody) body: z.infer<typeof AbortCheckoutBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Checkout> {
    const row = await this.finalizer.abort(principal, params.id, body, correlationId);
    return this.checkouts.afterCommand(organizationOf(principal), row.id);
  }

  @Post(':id/recover')
  @Idempotent()
  async recover(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecoverCheckoutBody) body: z.infer<typeof RecoverCheckoutBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Checkout> {
    const row = await this.finalizer.recover(principal, params.id, body, correlationId);
    return this.checkouts.afterCommand(organizationOf(principal), row.id);
  }

  @Post(':id/compensate')
  @Idempotent()
  async compensate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CompensateCheckoutBody) body: z.infer<typeof CompensateCheckoutBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Checkout> {
    const row = await this.finalizer.compensate(principal, params.id, body, correlationId);
    return this.checkouts.afterCommand(organizationOf(principal), row.id);
  }
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly checkouts: CheckoutService) {}

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Order> {
    return this.checkouts.getOrder(principal, params.id);
  }
}
