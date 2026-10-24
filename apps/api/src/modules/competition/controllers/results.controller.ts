import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  PublishResultBody,
  ResubmitResultBody,
  ReturnResultBody,
  StandingsQuery,
  SubmitResultBody,
  z,
  type Principal,
  type PublishResultOutcome,
  type ResultRevision,
  type Standings,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { ResultsService } from '../services/results.service';
import { StandingsService } from '../services/standings.service';

const IdParams = z.object({ id: z.uuid() });

/** Results (§4.8 POST /fixtures/{id}/results, POST /results/{id}/publish; SPK-RESULT-001..004) and standings (SPK-RESULT-003). */
@Controller()
export class ResultsController {
  constructor(
    private readonly results: ResultsService,
    private readonly standings: StandingsService,
  ) {}

  @Post('fixtures/:id/results')
  @Idempotent()
  submit(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SubmitResultBody) body: z.infer<typeof SubmitResultBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ResultRevision> {
    return this.results.submit(principal, params.id, body, correlationId);
  }

  @Get('fixtures/:id/results')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ResultRevision[]> {
    return this.results.listForFixture(principal, params.id);
  }

  @Get('results/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<ResultRevision> {
    return this.results.get(principal, params.id);
  }

  @Post('results/:id/submit')
  @HttpCode(200)
  @Idempotent()
  resubmit(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ResubmitResultBody) body: z.infer<typeof ResubmitResultBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ResultRevision> {
    return this.results.resubmit(principal, params.id, body, correlationId);
  }

  @Post('results/:id/return')
  @HttpCode(200)
  @Idempotent()
  returnForCorrection(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReturnResultBody) body: z.infer<typeof ReturnResultBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ResultRevision> {
    return this.results.returnForCorrection(principal, params.id, body, correlationId);
  }

  @Post('results/:id/publish')
  @HttpCode(200)
  @Idempotent()
  publish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(PublishResultBody) body: z.infer<typeof PublishResultBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PublishResultOutcome> {
    return this.results.publish(principal, params.id, body, correlationId);
  }

  @Get('seasons/:id/standings')
  standingsOf(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(StandingsQuery) query: z.infer<typeof StandingsQuery>,
  ): Promise<Standings> {
    return this.standings.get(principal, params.id, query);
  }
}
