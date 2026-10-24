import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AssignPlacementBody,
  CreatePlacementRequestBody,
  ListPlacementRequestsQuery,
  ProposePlacementBody,
  RejectPlacementProposalBody,
  ReleasePlacementBody,
  z,
  type Page,
  type PlacementCandidate,
  type PlacementRequest,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { PlacementService } from '../services/placement.service';

const IdParams = z.object({ id: z.uuid() });

/** Free-agent placement, operator-mediated (SPK-PLACE-001..005). No route here is public. */
@Controller('placement-requests')
export class PlacementController {
  constructor(private readonly placement: PlacementService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePlacementRequestBody) body: z.infer<typeof CreatePlacementRequestBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlacementRequest> {
    return this.placement.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPlacementRequestsQuery) query: ListPlacementRequestsQuery,
  ): Promise<Page<PlacementRequest>> {
    return this.placement.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PlacementRequest> {
    return this.placement.get(principal, params.id);
  }

  @Get(':id/candidates')
  candidates(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PlacementCandidate[]> {
    return this.placement.candidates(principal, params.id);
  }

  @Post(':id/propose')
  @HttpCode(200)
  @Idempotent()
  propose(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ProposePlacementBody) body: z.infer<typeof ProposePlacementBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlacementRequest> {
    return this.placement.propose(principal, params.id, body, correlationId);
  }

  @Post(':id/reject-proposal')
  @HttpCode(200)
  @Idempotent()
  rejectProposal(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RejectPlacementProposalBody) body: z.infer<typeof RejectPlacementProposalBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlacementRequest> {
    return this.placement.rejectProposal(principal, params.id, body, correlationId);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Idempotent()
  assign(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AssignPlacementBody) body: z.infer<typeof AssignPlacementBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlacementRequest> {
    return this.placement.assign(principal, params.id, body, correlationId);
  }

  @Post(':id/release')
  @HttpCode(200)
  @Idempotent()
  release(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReleasePlacementBody) body: z.infer<typeof ReleasePlacementBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PlacementRequest> {
    return this.placement.release(principal, params.id, body, correlationId);
  }
}
