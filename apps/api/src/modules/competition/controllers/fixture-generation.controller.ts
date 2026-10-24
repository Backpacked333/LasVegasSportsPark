import { Controller, Get, Post } from '@nestjs/common';
import {
  CreateFixtureSpecificationBody,
  GenerateFixturesBody,
  z,
  type FixtureSpecification,
  type Principal,
  type SolverRun,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { FixtureGenerationService } from '../services/fixture-generation.service';

const IdParams = z.object({ id: z.uuid() });

/** Fixture specifications and solver runs (SPK-FIX-001..005). */
@Controller()
export class FixtureGenerationController {
  constructor(private readonly generation: FixtureGenerationService) {}

  @Post('divisions/:id/fixture-specifications')
  @Idempotent()
  createSpecification(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateFixtureSpecificationBody) body: z.infer<typeof CreateFixtureSpecificationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<FixtureSpecification> {
    return this.generation.createSpecification(principal, params.id, body, correlationId);
  }

  @Get('fixture-specifications/:id')
  getSpecification(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<FixtureSpecification> {
    return this.generation.getSpecification(principal, params.id);
  }

  @Post('fixture-specifications/:id/generate')
  @Idempotent()
  generate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(GenerateFixturesBody) body: z.infer<typeof GenerateFixturesBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<SolverRun> {
    return this.generation.generate(principal, params.id, body, correlationId);
  }

  @Get('solver-runs/:id')
  getRun(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<SolverRun> {
    return this.generation.getRun(principal, params.id);
  }
}
