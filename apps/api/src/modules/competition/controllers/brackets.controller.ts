import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateBracketNodeBody,
  ListBracketNodesQuery,
  PublishBracketNodeBody,
  z,
  type BracketNode,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { BracketsService } from '../services/brackets.service';

const IdParams = z.object({ id: z.uuid() });

/** Bracket nodes (§4.4 BracketNode, SPK-RESULT-004). */
@Controller()
export class BracketsController {
  constructor(private readonly brackets: BracketsService) {}

  @Post('seasons/:id/bracket-nodes')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateBracketNodeBody) body: z.infer<typeof CreateBracketNodeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BracketNode> {
    return this.brackets.create(principal, params.id, body, correlationId);
  }

  @Get('seasons/:id/bracket-nodes')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(ListBracketNodesQuery) query: z.infer<typeof ListBracketNodesQuery>,
  ): Promise<BracketNode[]> {
    return this.brackets.list(principal, params.id, query);
  }

  @Post('bracket-nodes/:id/publish')
  @HttpCode(200)
  @Idempotent()
  publish(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(PublishBracketNodeBody) body: z.infer<typeof PublishBracketNodeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<BracketNode> {
    return this.brackets.publish(principal, params.id, body, correlationId);
  }
}
