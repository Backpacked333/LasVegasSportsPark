import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AutosaveScheduleDraftBody,
  CreateScheduleDraftBody,
  DiscardScheduleDraftBody,
  ListScheduleDraftsQuery,
  PublishScheduleDraftBody,
  ValidateScheduleDraftBody,
  z,
  type Principal,
  type Publication,
  type ScheduleDraft,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { ScheduleDraftsService } from '../services/schedule-drafts.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Schedule drafts and publication (SPK-SCHED-005/006, §4.8 POST /v1/schedule-drafts/{id}/publish). */
@Controller('schedule-drafts')
export class ScheduleDraftsController {
  constructor(private readonly drafts: ScheduleDraftsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateScheduleDraftBody) body: CreateScheduleDraftBody,
    @CorrelationId() correlationId: string,
  ): Promise<ScheduleDraft> {
    return this.drafts.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListScheduleDraftsQuery) query: z.infer<typeof ListScheduleDraftsQuery>,
  ): Promise<ScheduleDraft[]> {
    return this.drafts.list(principal, query.facilityId, query.status);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ScheduleDraft> {
    return this.drafts.get(principal, params.id);
  }

  @Patch(':id')
  @Idempotent()
  autosave(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AutosaveScheduleDraftBody) body: AutosaveScheduleDraftBody,
    @CorrelationId() correlationId: string,
  ): Promise<ScheduleDraft> {
    return this.drafts.autosave(principal, params.id, body, correlationId);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @Idempotent()
  validate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ValidateScheduleDraftBody) body: z.infer<typeof ValidateScheduleDraftBody>,
    @CorrelationId() correlationId: string,
  ): Promise<ScheduleDraft> {
    return this.drafts.validate(principal, params.id, body, correlationId);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Idempotent()
  publish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(PublishScheduleDraftBody) body: z.infer<typeof PublishScheduleDraftBody>,
    @CorrelationId() correlationId: string,
  ): Promise<Publication> {
    return this.drafts.publish(principal, params.id, body, correlationId);
  }

  @Post(':id/discard')
  @HttpCode(200)
  @Idempotent()
  discard(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DiscardScheduleDraftBody) body: z.infer<typeof DiscardScheduleDraftBody>,
    @CorrelationId() correlationId: string,
  ): Promise<ScheduleDraft> {
    return this.drafts.discard(principal, params.id, body, correlationId);
  }
}
