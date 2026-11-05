import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CancelSessionBookingBody,
  ConfirmSessionBookingBody,
  CreateSessionBookingBody,
  ListSessionBookingsQuery,
  z,
  type Principal,
  type SessionBooking,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { SessionBookingsService } from '../services/session-bookings.service';

const IdParams = z.object({ id: z.uuid() });

/** Session bookings: pickup seats with their own capacity and waitlist (SPK-PLACE-004). */
@Controller('session-bookings')
export class SessionBookingsController {
  constructor(private readonly bookings: SessionBookingsService) {}

  @Post()
  @Idempotent()
  book(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateSessionBookingBody) body: z.infer<typeof CreateSessionBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SessionBooking> {
    return this.bookings.book(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListSessionBookingsQuery) query: z.infer<typeof ListSessionBookingsQuery>,
  ): Promise<SessionBooking[]> {
    return this.bookings.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<SessionBooking> {
    return this.bookings.get(principal, params.id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Idempotent()
  confirm(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ConfirmSessionBookingBody) body: z.infer<typeof ConfirmSessionBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SessionBooking> {
    return this.bookings.confirm(principal, params.id, body, correlationId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  cancel(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CancelSessionBookingBody) body: z.infer<typeof CancelSessionBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SessionBooking> {
    return this.bookings.cancel(principal, params.id, body, correlationId);
  }
}
