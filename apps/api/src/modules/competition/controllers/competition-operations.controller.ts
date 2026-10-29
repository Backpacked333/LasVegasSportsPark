import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AddPoolEntryBody,
  CreatePoolBody,
  ListAppealsQuery,
  ListDisciplinaryDecisionsQuery,
  ListDisputesQuery,
  ListResultRevisionsQuery,
  ListSolverRunsQuery,
  RemovePoolEntryBody,
  SeedFromStandingsBody,
  UpdateFixtureSpecificationBody,
  WithdrawDisputeBody,
  z,
  type Appeal,
  type BracketNode,
  type DisciplinaryDecision,
  type Dispute,
  type FixtureSpecification,
  type Page,
  type Pool,
  type PoolStandings,
  type Principal,
  type ResultRevision,
  type SolverRun,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { BracketsService } from '../services/brackets.service';
import { DisciplineService } from '../services/discipline.service';
import { DisputesService } from '../services/disputes.service';
import { FixtureGenerationService } from '../services/fixture-generation.service';
import { PoolsService } from '../services/pools.service';
import { ResultsService } from '../services/results.service';
import { StandingsService } from '../services/standings.service';

const IdParams = z.object({ id: z.uuid() });
const PoolEntryParams = z.object({ id: z.uuid(), teamEntryId: z.uuid() });

/**
 * Stage-3 league operations: staff lists (CMP-05), seeding brackets from standings (CMP-10),
 * dispute withdrawal and specification changes (CMP-12), and tournament pools (CMP-15).
 */
@Controller()
export class CompetitionOperationsController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly discipline: DisciplineService,
    private readonly generation: FixtureGenerationService,
    private readonly results: ResultsService,
    private readonly brackets: BracketsService,
    private readonly pools: PoolsService,
    private readonly standings: StandingsService,
  ) {}

  // CMP-05 staff lists ------------------------------------------------------------------------
  @Get('disputes')
  listDisputes(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListDisputesQuery) query: z.infer<typeof ListDisputesQuery>,
  ): Promise<Page<Dispute>> {
    return this.disputes.list(principal, query);
  }

  @Get('appeals')
  listAppeals(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAppealsQuery) query: z.infer<typeof ListAppealsQuery>,
  ): Promise<Page<Appeal>> {
    return this.discipline.listAppeals(principal, query);
  }

  @Get('disciplinary-decisions')
  listDecisions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListDisciplinaryDecisionsQuery) query: z.infer<typeof ListDisciplinaryDecisionsQuery>,
  ): Promise<Page<DisciplinaryDecision>> {
    return this.discipline.listDecisions(principal, query);
  }

  @Get('divisions/:id/fixture-specifications')
  listSpecifications(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<{ items: FixtureSpecification[] }> {
    return this.generation.listForDivision(principal, params.id);
  }

  @Get('fixture-specifications/:id/solver-runs')
  listSolverRuns(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListSolverRunsQuery) query: z.infer<typeof ListSolverRunsQuery>,
  ): Promise<Page<SolverRun>> {
    return this.generation.listRuns(principal, params.id, query);
  }

  @Get('seasons/:id/result-revisions')
  listResultRevisions(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListResultRevisionsQuery) query: z.infer<typeof ListResultRevisionsQuery>,
  ): Promise<Page<ResultRevision>> {
    return this.results.listForSeason(principal, params.id, query);
  }

  // CMP-10 seeding ----------------------------------------------------------------------------
  @Post('bracket-nodes/:id/seed-from-standings')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('season')
  seedFromStandings(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SeedFromStandingsBody) body: z.infer<typeof SeedFromStandingsBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BracketNode> {
    return this.brackets.seedFromStandings(principal, params.id, body, correlationId);
  }

  // CMP-12 ------------------------------------------------------------------------------------
  @Post('disputes/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('result')
  withdrawDispute(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawDisputeBody) body: z.infer<typeof WithdrawDisputeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Dispute> {
    return this.disputes.withdraw(principal, params.id, body, correlationId);
  }

  @Patch('fixture-specifications/:id')
  @Idempotent()
  @RecordAuthority('season')
  updateSpecification(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateFixtureSpecificationBody) body: z.infer<typeof UpdateFixtureSpecificationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureSpecification> {
    return this.generation.updateSpecification(principal, params.id, body, correlationId);
  }

  // CMP-15 tournament pools -------------------------------------------------------------------
  @Post('divisions/:id/pools')
  @Idempotent()
  @RecordAuthority('season')
  createPool(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreatePoolBody) body: z.infer<typeof CreatePoolBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Pool> {
    return this.pools.create(principal, params.id, body, correlationId);
  }

  @Get('pools/:id')
  getPool(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Pool> {
    return this.pools.get(principal, params.id);
  }

  @Post('pools/:id/entries')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('season')
  addPoolEntry(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddPoolEntryBody) body: z.infer<typeof AddPoolEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Pool> {
    return this.pools.addEntry(principal, params.id, body, correlationId);
  }

  @Post('pools/:id/entries/:teamEntryId/remove')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('season')
  removePoolEntry(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(PoolEntryParams) params: z.infer<typeof PoolEntryParams>,
    @ZodBody(RemovePoolEntryBody) body: z.infer<typeof RemovePoolEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Pool> {
    return this.pools.removeEntry(principal, params.id, params.teamEntryId, body, correlationId);
  }

  @Get('pools/:id/standings')
  poolStandings(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PoolStandings> {
    return this.standings.poolStandings(principal, params.id);
  }
}
