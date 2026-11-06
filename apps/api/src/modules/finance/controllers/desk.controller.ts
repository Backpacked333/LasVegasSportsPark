import { Controller, Get, Post } from '@nestjs/common';
import {
  CreatePaymentReminderBody,
  z,
  type BasketPrice,
  type PaymentReminder,
  type PersonMoneySummary,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  RefusedDuringRecovery,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import { CorrelationId } from '../finance.shared';
import { FinanceDeskService } from '../services/finance-desk.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Finance desk (park UI redesign): payment reminders for past-due obligations (SPK-COMMS-002), a
 * person's money summary (protected, §4.10) and a basket's price for booking requests
 * (SPK-PAY-001/002).
 */
@RefusedDuringRecovery()
@Controller()
export class FinanceDeskController {
  constructor(private readonly desk: FinanceDeskService) {}

  @Post('obligations/:id/reminders')
  @Idempotent()
  // A reminder records that a notice was asked for; it changes no obligation (§5.3 row 13).
  @NoRecordAuthority('Records a reminder request; the obligation itself is not changed')
  remind(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreatePaymentReminderBody) body: z.infer<typeof CreatePaymentReminderBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PaymentReminder> {
    return this.desk.remind(principal, params.id, body, correlationId);
  }

  @Get('people/:id/money-summary')
  moneySummary(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PersonMoneySummary> {
    return this.desk.personMoney(principal, params.id);
  }

  @Get('basket-prices/:id')
  basketPrice(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<BasketPrice> {
    return this.desk.basketPrice(principal, params.id);
  }
}
