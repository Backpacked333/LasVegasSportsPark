import { Controller, Get } from '@nestjs/common';
import {
  AvailabilityQuery,
  ListEventsQuery,
  ListReservationsQuery,
  z,
  type Event,
  type Interval,
  type Page,
  type Principal,
  type Reservation,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { EventsService } from '../services/events.service';

const IdParams = z.object({ id: z.uuid() });

/** Read access to the schedule: events, reservations and availability (SPK-SCHED-003). */
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('events')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListEventsQuery) query: ListEventsQuery,
  ): Promise<Page<Event>> {
    return this.events.listEvents(principal, query);
  }

  @Get('events/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Event> {
    return this.events.getEvent(principal, params.id);
  }

  @Get('reservations')
  listReservations(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListReservationsQuery) query: z.infer<typeof ListReservationsQuery>,
  ): Promise<Reservation[]> {
    return this.events.listReservations(principal, {
      facilityId: query.facilityId,
      resourceId: query.resourceId,
      interval: { start: query.start, end: query.end },
    });
  }

  @Get('resources/:id/availability')
  async availability(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(AvailabilityQuery) query: AvailabilityQuery,
  ): Promise<{ resourceId: string; slots: Interval[] }> {
    const slots = await this.events.findAvailableSlots(principal, {
      resourceId: params.id,
      interval: { start: query.start, end: query.end },
      durationMinutes: query.durationMinutes,
      setupMinutes: query.setupMinutes,
      cleanupMinutes: query.cleanupMinutes,
      stepMinutes: query.stepMinutes,
    });
    return { resourceId: params.id, slots };
  }
}
