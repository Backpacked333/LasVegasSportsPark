import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApproveBookingBody,
  BookingAvailabilityQuery,
  CancelBookingBody,
  CreateBookingBody,
  DeclineBookingBody,
  ListBookingsQuery,
  ListMyBookingsQuery,
  z,
  type Booking,
  type BookingAvailability,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { BookingsService } from '../services/bookings.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Rentals and parties (ENR-13; capabilities rentals and parties: DEC-016, DEC-076, DEC-077).
 * Record authority: the reservation is future schedule (§5.3); the facility comes from the
 * offering, so the routes are `unproven` and scheduling's in-process check decides with the exact
 * facility (SCH-02).
 */
@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get('offerings/:id/booking-availability')
  availability(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(BookingAvailabilityQuery) query: BookingAvailabilityQuery,
  ): Promise<BookingAvailability> {
    return this.bookings.bookingAvailability(principal, params.id, query);
  }

  @Post('bookings')
  @Idempotent()
  @RecordAuthority('future_schedule')
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateBookingBody) body: z.infer<typeof CreateBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Booking> {
    return this.bookings.create(principal, body, correlationId);
  }

  @Post('bookings/:id/approve')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('future_schedule')
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveBookingBody) body: z.infer<typeof ApproveBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Booking> {
    return this.bookings.approve(principal, params.id, body, correlationId);
  }

  @Post('bookings/:id/decline')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('future_schedule')
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineBookingBody) body: z.infer<typeof DeclineBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Booking> {
    return this.bookings.decline(principal, params.id, body, correlationId);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('future_schedule')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CancelBookingBody) body: z.infer<typeof CancelBookingBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Booking> {
    return this.bookings.cancel(principal, params.id, body, correlationId);
  }

  @Get('me/bookings')
  mine(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMyBookingsQuery) query: ListMyBookingsQuery,
  ): Promise<Page<Booking>> {
    return this.bookings.listMine(principal, query);
  }

  @Get('bookings/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Booking> {
    return this.bookings.get(principal, params.id);
  }

  @Get('bookings')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListBookingsQuery) query: ListBookingsQuery,
  ): Promise<Page<Booking>> {
    return this.bookings.list(principal, query);
  }
}
