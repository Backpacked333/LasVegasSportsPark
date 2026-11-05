import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateEventSeriesBody,
  EditEventSeriesBody,
  z,
  type EventSeries,
  type Principal,
  type SeriesEditPreview,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { EventSeriesService } from '../services/event-series.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Recurring series and recurrence edits (SPK-SCHED-007/008). */
@Controller('event-series')
export class EventSeriesController {
  constructor(private readonly series: EventSeriesService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateEventSeriesBody) body: CreateEventSeriesBody,
    @CorrelationId() correlationId: string,
  ): Promise<EventSeries> {
    return this.series.createSeries(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<EventSeries> {
    return this.series.getSeries(principal, params.id);
  }

  @Post(':id/edits')
  @HttpCode(200)
  @Idempotent()
  edit(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(EditEventSeriesBody) body: EditEventSeriesBody,
    @CorrelationId() correlationId: string,
  ): Promise<SeriesEditPreview> {
    return this.series.editSeries(principal, params.id, body, correlationId);
  }
}
