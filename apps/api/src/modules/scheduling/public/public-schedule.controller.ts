import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import {
  DisableFacilityPublicViewBody,
  EnableFacilityPublicViewBody,
  PublicDayScheduleQuery,
  z,
  type FacilityPublicView,
  type Principal,
  type PublicDaySchedule,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  Public,
  RateLimited,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../controllers/correlation.decorator';
import type { Response } from 'express';
import { PublicAddressParams, allowPublicCache, assertPublicAddress } from './public-access';
import { PublicScheduleService } from './public-schedule.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * The facility day schedule without sign-in (SPK-SCHED-010, proposed amendment PA-06, ADR-005):
 * addressed by organization slug and public code, rate limited per address (`public_views`),
 * cacheable for a short time. Unknown organization, unknown or disabled code and the capability
 * turned off all answer the same "not available". A parameter that is not shaped like a slug or
 * a code answers that too, never a validation message that describes the shape.
 */
@Controller('public')
@RateLimited('public_views')
export class PublicScheduleController {
  constructor(private readonly schedule: PublicScheduleService) {}

  @Get(':organization/schedule/:code')
  @Public()
  async day(
    @ZodParams(PublicAddressParams) params: z.infer<typeof PublicAddressParams>,
    @ZodQuery(PublicDayScheduleQuery) query: z.infer<typeof PublicDayScheduleQuery>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicDaySchedule> {
    const { organization, code } = assertPublicAddress(params);
    const schedule = await this.schedule.day(organization, code, query.date);
    allowPublicCache(response);
    return schedule;
  }
}

/** Staff: enable or disable a facility's public schedule and read its link. */
@Controller()
export class FacilityPublicViewController {
  constructor(private readonly schedule: PublicScheduleService) {}

  @Get('facilities/:id/public-schedule-view')
  view(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FacilityPublicView> {
    return this.schedule.view(principal, params.id);
  }

  @Post('facilities/:id/public-schedule-view/enable')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('A public view switch is not a §5.3 record category')
  enable(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(EnableFacilityPublicViewBody) body: z.infer<typeof EnableFacilityPublicViewBody>,
    @CorrelationId() correlationId: string,
  ): Promise<FacilityPublicView> {
    return this.schedule.enable(principal, params.id, body, correlationId);
  }

  @Post('facilities/:id/public-schedule-view/disable')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('A public view switch is not a §5.3 record category')
  disable(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DisableFacilityPublicViewBody) body: z.infer<typeof DisableFacilityPublicViewBody>,
    @CorrelationId() correlationId: string,
  ): Promise<FacilityPublicView> {
    return this.schedule.disable(principal, params.id, body, correlationId);
  }
}
