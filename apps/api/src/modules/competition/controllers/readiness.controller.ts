import { Controller, Get } from '@nestjs/common';
import {
  SeasonReadinessQuery,
  z,
  type FixtureReadiness,
  type Principal,
  type SeasonReadiness,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { ReadinessService } from '../services/readiness.service';

const IdParams = z.object({ id: z.uuid() });

/** `GET /v1/fixtures/{id}/readiness` (§4.8, SPK-READY-001..004): derived on every read. */
@Controller()
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('fixtures/:id/readiness')
  evaluate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureReadiness> {
    return this.readiness.evaluate(principal, params.id);
  }

  /** CMP-01 (SPK-READY-001): each fixture of a season in one read, at most 100 (staff). */
  @Get('seasons/:id/readiness')
  season(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(SeasonReadinessQuery) query: z.infer<typeof SeasonReadinessQuery>,
  ): Promise<SeasonReadiness> {
    return this.readiness.seasonSummary(principal, params.id, query);
  }
}
