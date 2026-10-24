import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  CreateDivisionBody,
  CreateSeasonBody,
  ListDivisionsQuery,
  ListSeasonFixturesQuery,
  ListSeasonsQuery,
  UpdateDivisionBody,
  UpdateSeasonBody,
  z,
  type Division,
  type Fixture,
  type Page,
  type Principal,
  type Season,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { FixturesService } from '../services/fixtures.service';
import { SeasonsService } from '../services/seasons.service';

const IdParams = z.object({ id: z.uuid() });

/** Seasons and divisions (SPK-COMP-001, SPK-COMP-003) and the season fixture list. */
@Controller()
export class SeasonsController {
  constructor(
    private readonly seasons: SeasonsService,
    private readonly fixtures: FixturesService,
  ) {}

  @Post('seasons')
  @Idempotent()
  createSeason(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateSeasonBody) body: z.infer<typeof CreateSeasonBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Season> {
    return this.seasons.createSeason(principal, body, correlationId);
  }

  @Get('seasons')
  listSeasons(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListSeasonsQuery) query: z.infer<typeof ListSeasonsQuery>,
  ): Promise<Season[]> {
    return this.seasons.listSeasons(principal, query);
  }

  @Get('seasons/:id')
  getSeason(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Season> {
    return this.seasons.getSeason(principal, params.id);
  }

  @Patch('seasons/:id')
  @Idempotent()
  updateSeason(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateSeasonBody) body: z.infer<typeof UpdateSeasonBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Season> {
    return this.seasons.updateSeason(principal, params.id, body, correlationId);
  }

  @Get('seasons/:id/fixtures')
  listSeasonFixtures(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListSeasonFixturesQuery) query: z.infer<typeof ListSeasonFixturesQuery>,
  ): Promise<Page<Fixture>> {
    return this.fixtures.listForSeason(principal, params.id, query);
  }

  @Post('divisions')
  @Idempotent()
  createDivision(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateDivisionBody) body: z.infer<typeof CreateDivisionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Division> {
    return this.seasons.createDivision(principal, body, correlationId);
  }

  @Get('divisions')
  listDivisions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListDivisionsQuery) query: z.infer<typeof ListDivisionsQuery>,
  ): Promise<Division[]> {
    return this.seasons.listDivisions(principal, query.seasonId);
  }

  @Get('divisions/:id')
  getDivision(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Division> {
    return this.seasons.getDivision(principal, params.id);
  }

  @Patch('divisions/:id')
  @Idempotent()
  updateDivision(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateDivisionBody) body: z.infer<typeof UpdateDivisionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Division> {
    return this.seasons.updateDivision(principal, params.id, body, correlationId);
  }
}
