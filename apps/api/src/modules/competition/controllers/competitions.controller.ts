import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  CreateCompetitionBody,
  CreateRuleSetBody,
  ListCompetitionsQuery,
  ListRuleSetsQuery,
  UpdateCompetitionBody,
  z,
  type Competition,
  type Principal,
  type RuleSet,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { CompetitionsService } from '../services/competitions.service';

const IdParams = z.object({ id: z.uuid() });

/** Competitions and immutable rule-set versions (SPK-COMP-001, SPK-COMP-002). */
@Controller()
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Post('competitions')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateCompetitionBody) body: z.infer<typeof CreateCompetitionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Competition> {
    return this.competitions.create(principal, body, correlationId);
  }

  @Get('competitions')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListCompetitionsQuery) query: z.infer<typeof ListCompetitionsQuery>,
  ): Promise<Competition[]> {
    return this.competitions.list(principal, query);
  }

  @Get('competitions/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Competition> {
    return this.competitions.get(principal, params.id);
  }

  @Patch('competitions/:id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateCompetitionBody) body: z.infer<typeof UpdateCompetitionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Competition> {
    return this.competitions.update(principal, params.id, body, correlationId);
  }

  /** Posting an existing name creates its next version; rule sets are never edited (SPK-COMP-002). */
  @Post('rule-sets')
  @Idempotent()
  createRuleSet(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateRuleSetBody) body: z.infer<typeof CreateRuleSetBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<RuleSet> {
    return this.competitions.createRuleSet(principal, body, correlationId);
  }

  @Get('rule-sets')
  listRuleSets(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListRuleSetsQuery) query: z.infer<typeof ListRuleSetsQuery>,
  ): Promise<RuleSet[]> {
    return this.competitions.listRuleSets(principal, query);
  }

  @Get('rule-sets/:id')
  getRuleSet(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<RuleSet> {
    return this.competitions.getRuleSet(principal, params.id);
  }
}
