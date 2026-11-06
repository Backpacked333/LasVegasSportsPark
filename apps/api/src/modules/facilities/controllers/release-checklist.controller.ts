import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AddChecklistItemBody,
  CompleteChecklistItemBody,
  FacilityDaySummaryQuery,
  RemoveChecklistItemBody,
  ReopenChecklistItemBody,
  z,
  type FacilityDaySummary,
  type Principal,
  type ReleaseChecklist,
  type ReleaseChecklistItem,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { FacilityDaySummaryService } from '../services/facility-day-summary.service';
import { ReleaseChecklistService } from '../services/release-checklist.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
const ItemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

/** Release checklists (migration 0909, SPK-FAC-004) and the facility day summary (page headers). */
@Controller()
export class ReleaseChecklistController {
  constructor(
    private readonly checklist: ReleaseChecklistService,
    private readonly summaries: FacilityDaySummaryService,
  ) {}

  @Get('facilities/:id/day-summary')
  daySummary(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(FacilityDaySummaryQuery) query: FacilityDaySummaryQuery,
  ): Promise<FacilityDaySummary> {
    return this.summaries.summarize(principal, params.id, query.date);
  }

  @Get('maintenance-restrictions/:id/release-checklist')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ReleaseChecklist> {
    return this.checklist.get(principal, params.id);
  }

  @Post('maintenance-restrictions/:id/checklist-items')
  @NoRecordAuthority('Release checklist evidence on a restriction, not a §5.3 record category')
  @Idempotent()
  add(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddChecklistItemBody) body: AddChecklistItemBody,
    @CorrelationId() correlationId: string,
  ): Promise<ReleaseChecklistItem> {
    return this.checklist.addItem(principal, params.id, body, correlationId);
  }

  @Post('maintenance-restrictions/:id/checklist-items/:itemId/complete')
  @NoRecordAuthority('Release checklist evidence on a restriction, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  complete(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ItemParams) params: z.infer<typeof ItemParams>,
    @ZodBody(CompleteChecklistItemBody) body: CompleteChecklistItemBody,
    @CorrelationId() correlationId: string,
  ): Promise<ReleaseChecklist> {
    return this.checklist.complete(principal, params.id, params.itemId, body, correlationId);
  }

  @Post('maintenance-restrictions/:id/checklist-items/:itemId/reopen')
  @NoRecordAuthority('Release checklist evidence on a restriction, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  reopen(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ItemParams) params: z.infer<typeof ItemParams>,
    @ZodBody(ReopenChecklistItemBody) body: ReopenChecklistItemBody,
    @CorrelationId() correlationId: string,
  ): Promise<ReleaseChecklist> {
    return this.checklist.reopen(principal, params.id, params.itemId, body, correlationId);
  }

  @Post('maintenance-restrictions/:id/checklist-items/:itemId/remove')
  @NoRecordAuthority('Release checklist evidence on a restriction, not a §5.3 record category')
  @HttpCode(200)
  @Idempotent()
  remove(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ItemParams) params: z.infer<typeof ItemParams>,
    @ZodBody(RemoveChecklistItemBody) body: RemoveChecklistItemBody,
    @CorrelationId() correlationId: string,
  ): Promise<ReleaseChecklist> {
    return this.checklist.remove(principal, params.id, params.itemId, body, correlationId);
  }
}
