import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreatePreventiveScheduleBody,
  GeneratePreventiveOccurrencesBody,
  ListPreventiveSchedulesQuery,
  UpdatePreventiveScheduleBody,
  z,
  type PreventiveGenerationResult,
  type PreventiveSchedule,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { PreventiveSchedulesService } from '../services/preventive-schedules.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Preventive maintenance schedules (SPK-FAC-005). */
@Controller('preventive-schedules')
export class PreventiveSchedulesController {
  constructor(private readonly schedules: PreventiveSchedulesService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePreventiveScheduleBody) body: CreatePreventiveScheduleBody,
    @CorrelationId() correlationId: string,
  ): Promise<PreventiveSchedule> {
    return this.schedules.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPreventiveSchedulesQuery) query: ListPreventiveSchedulesQuery,
  ): Promise<PreventiveSchedule[]> {
    return this.schedules.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PreventiveSchedule> {
    return this.schedules.get(principal, params.id);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdatePreventiveScheduleBody) body: UpdatePreventiveScheduleBody,
    @CorrelationId() correlationId: string,
  ): Promise<PreventiveSchedule> {
    return this.schedules.update(principal, params.id, body, correlationId);
  }

  @Post(':id/generate')
  @HttpCode(200)
  @Idempotent()
  generate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(GeneratePreventiveOccurrencesBody) body: GeneratePreventiveOccurrencesBody,
    @CorrelationId() correlationId: string,
  ): Promise<PreventiveGenerationResult> {
    return this.schedules.generate(principal, params.id, { ...body, correlationId });
  }
}
