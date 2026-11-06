import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AvailabilityQuery,
  DirectCancelEventBody,
  DirectMoveEventBody,
  FacilityAvailabilityQuery,
  ListEventsQuery,
  ListReservationsQuery,
  z,
  type DirectEventChange,
  type Event,
  type EventDetail,
  type FacilityAvailability,
  type Interval,
  type Page,
  type Principal,
  type Reservation,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { EventsService } from '../services/events.service';
import { ScheduleDraftsService } from '../services/schedule-drafts.service';
import { ScheduleInsightsService } from '../services/schedule-insights.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Read access to the schedule: events, reservations and availability (SPK-SCHED-003). */
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly drafts: ScheduleDraftsService,
    private readonly insights: ScheduleInsightsService,
  ) {}

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

  /** The schedule detail rail: teams, staff, attendee counts and message audience (staff). */
  @Get('events/:id/detail')
  detail(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<EventDetail> {
    return this.insights.eventDetail(principal, params.id);
  }

  /** Cross-resource availability: free start times per resource of a facility. */
  @Get('resource-availability')
  facilityAvailability(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(FacilityAvailabilityQuery) query: FacilityAvailabilityQuery,
  ): Promise<FacilityAvailability> {
    return this.insights.facilityAvailability(principal, query);
  }

  /** Direct move from the timeline: a single-change draft published at once (SPK-SCHED-005/006). */
  @Post('events/:id/move')
  @RecordAuthority('future_schedule')
  @HttpCode(200)
  @Idempotent()
  move(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DirectMoveEventBody) body: DirectMoveEventBody,
    @CorrelationId() correlationId: string,
  ): Promise<DirectEventChange> {
    return this.drafts.publishDirect(
      principal,
      params.id,
      { change: 'move', ...body },
      correlationId,
    );
  }

  /** Direct cancel from the timeline: a single-change draft published at once (SPK-SCHED-005/006). */
  @Post('events/:id/cancel')
  @RecordAuthority('future_schedule')
  @HttpCode(200)
  @Idempotent()
  cancel(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DirectCancelEventBody) body: DirectCancelEventBody,
    @CorrelationId() correlationId: string,
  ): Promise<DirectEventChange> {
    return this.drafts.publishDirect(
      principal,
      params.id,
      { change: 'cancel', ...body },
      correlationId,
    );
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
