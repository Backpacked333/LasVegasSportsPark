import { Controller, Get, Post } from '@nestjs/common';
import {
  AbortCheckoutBody,
  CompensateCheckoutBody,
  CreateCheckoutBody,
  CreateQuoteBody,
  ListMyCheckoutsQuery,
  ListMyContributionRequestsQuery,
  ListMyOrdersQuery,
  ListMyPaymentsQuery,
  ListMyReceiptsQuery,
  ListOrdersQuery,
  RecoverCheckoutBody,
  RetryCheckoutPaymentBody,
  z,
  type Checkout,
  type ContributionRequest,
  type Order,
  type Page,
  type PaymentAttempt,
  type Principal,
  type Quote,
  type Receipt,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RefusedDuringRecovery,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId, organizationOf } from '../finance.shared';
import { CheckoutFinalizer } from '../services/checkout-finalizer.service';
import { CheckoutService } from '../services/checkout.service';
import { MoneyReadsService } from '../services/money-reads.service';
import { QuotesService } from '../services/quotes.service';

const IdParams = z.object({ id: z.uuid() });

/** §4.8 `POST /v1/registration-quotes` (SPK-PAY-001/002/003). */
@RefusedDuringRecovery()
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
@RefusedDuringRecovery()
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

@RefusedDuringRecovery()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly reads: MoneyReadsService,
  ) {}

  /** FIN-02 (SPK-PAY-011): finance readers list orders; customers use GET /v1/me/orders. */
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListOrdersQuery) query: z.infer<typeof ListOrdersQuery>,
  ): Promise<Page<Order>> {
    return this.reads.listOrders(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Order> {
    return this.checkouts.getOrder(principal, params.id);
  }
}

/**
 * A person's own money lists (FIN-01; SPK-PAY-004, SPK-PAY-005, SPK-PAY-007): an interrupted
 * payment, a checkout in recovery or a contribution asked of a player is found again from the
 * server, never from ids kept on the device.
 */
@Controller('me')
export class MeMoneyController {
  constructor(private readonly reads: MoneyReadsService) {}

  @Get('orders')
  orders(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyOrdersQuery) query: z.infer<typeof ListMyOrdersQuery>,
  ): Promise<Page<Order>> {
    return this.reads.myOrders(principal, query);
  }

  @Get('registration-checkouts')
  checkouts(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyCheckoutsQuery) query: z.infer<typeof ListMyCheckoutsQuery>,
  ): Promise<Page<Checkout>> {
    return this.reads.myCheckouts(principal, query);
  }

  @Get('payments')
  payments(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyPaymentsQuery) query: z.infer<typeof ListMyPaymentsQuery>,
  ): Promise<Page<PaymentAttempt>> {
    return this.reads.myPayments(principal, query);
  }

  @Get('receipts')
  receipts(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyReceiptsQuery) query: z.infer<typeof ListMyReceiptsQuery>,
  ): Promise<Page<Receipt>> {
    return this.reads.myReceipts(principal, query);
  }

  @Get('contribution-requests')
  contributionRequests(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyContributionRequestsQuery)
    query: z.infer<typeof ListMyContributionRequestsQuery>,
  ): Promise<Page<ContributionRequest>> {
    return this.reads.myContributionRequests(principal, query);
  }
}
