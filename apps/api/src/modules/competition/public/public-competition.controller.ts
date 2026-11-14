import { Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import {
  ChangeCompetitionPublicationBody,
  z,
  type CompetitionPublication,
  type Principal,
  type PublicCompetitionView,
  type PublicSeasonView,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  Public,
  RateLimited,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import type { Response } from 'express';
import { PublicAddressParams, allowPublicCache, assertPublicAddress } from '../../scheduling';
import { CorrelationId } from '../competition.shared';
import { PublicCompetitionService } from './public-competition.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Competition views without sign-in (SPK-SCHED-010, proposed amendment PA-06, ADR-005): addressed
 * by organization slug and public code, rate limited per address (`public_views`), cacheable for
 * a short time. Unknown organization, unknown code, a competition that is not public (or has a
 * division for players under 18) and the capability turned off all answer the same "not
 * available".
 */
@Controller('public')
@RateLimited('public_views')
export class PublicCompetitionController {
  constructor(private readonly competitions: PublicCompetitionService) {}

  @Get(':organization/competitions/:code')
  @Public()
  async competition(
    @ZodParams(PublicAddressParams) params: z.infer<typeof PublicAddressParams>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicCompetitionView> {
    const { organization, code } = assertPublicAddress(params);
    const view = await this.competitions.competitionView(organization, code);
    allowPublicCache(response);
    return view;
  }

  /** Fixtures, results, standings and, in a tournament, the bracket of one season. */
  @Get(':organization/seasons/:code')
  @Public()
  async season(
    @ZodParams(PublicAddressParams) params: z.infer<typeof PublicAddressParams>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicSeasonView> {
    const { organization, code } = assertPublicAddress(params);
    const view = await this.competitions.seasonView(organization, code);
    allowPublicCache(response);
    return view;
  }
}

/** Staff: make a competition public or private and read its links. */
@Controller()
export class CompetitionPublicationController {
  constructor(private readonly competitions: PublicCompetitionService) {}

  @Get('competitions/:id/publication')
  publication(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<CompetitionPublication> {
    return this.competitions.publication(principal, params.id);
  }

  @Post('competitions/:id/publish')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Public visibility is not a §5.3 record category')
  publish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ChangeCompetitionPublicationBody)
    body: z.infer<typeof ChangeCompetitionPublicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CompetitionPublication> {
    return this.competitions.publish(principal, params.id, body, correlationId);
  }

  @Post('competitions/:id/unpublish')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Public visibility is not a §5.3 record category')
  unpublish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ChangeCompetitionPublicationBody)
    body: z.infer<typeof ChangeCompetitionPublicationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CompetitionPublication> {
    return this.competitions.unpublish(principal, params.id, body, correlationId);
  }
}
