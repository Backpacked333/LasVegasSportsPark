import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateProgramBody,
  ListProgramOfferingsQuery,
  ListProgramsQuery,
  UpdateProgramBody,
  z,
  type Offering,
  type Page,
  type Principal,
  type Program,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { OfferingsService } from '../services/offerings.service';
import { ProgramsService } from '../services/programs.service';

const IdParams = z.object({ id: z.uuid() });

/** Reusable program definitions (SPK-CAT-001). */
@Controller()
export class ProgramsController {
  constructor(
    private readonly programs: ProgramsService,
    private readonly offerings: OfferingsService,
  ) {}

  @Post('programs')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateProgramBody) body: z.infer<typeof CreateProgramBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Program> {
    return this.programs.create(principal, body, correlationId);
  }

  @Get('programs')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListProgramsQuery) query: ListProgramsQuery,
  ): Promise<Page<Program>> {
    return this.programs.list(principal, query);
  }

  @Get('programs/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Program> {
    return this.programs.get(principal, params.id);
  }

  @Patch('programs/:id')
  @HttpCode(200)
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateProgramBody) body: z.infer<typeof UpdateProgramBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Program> {
    return this.programs.update(principal, params.id, body, correlationId);
  }

  @Get('programs/:id/offerings')
  listOfferings(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListProgramOfferingsQuery) query: ListProgramOfferingsQuery,
  ): Promise<Page<Offering>> {
    return this.offerings.listForProgram(principal, params.id, query);
  }
}
