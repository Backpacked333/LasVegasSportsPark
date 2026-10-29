import { Controller, Get, Post } from '@nestjs/common';
import {
  AccessReviewDecisionBody,
  OpenAccessReviewBody,
  ListAccessReviewsQuery,
  z,
  type AccessReview,
  type AccessReviewSummary,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { AccessReviewsService } from '../services/access-reviews.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('access-reviews')
export class AccessReviewsController {
  constructor(private readonly reviews: AccessReviewsService) {}

  @Post()
  @Idempotent()
  open(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(OpenAccessReviewBody) body: z.infer<typeof OpenAccessReviewBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccessReview> {
    return this.reviews.open(principal, body, correlationId);
  }

  /** GET /v1/access-reviews (ID-05): review deciders' queue with allowed decisions. */
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAccessReviewsQuery) query: z.infer<typeof ListAccessReviewsQuery>,
  ): Promise<Page<AccessReviewSummary>> {
    return this.reviews.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<AccessReview> {
    return this.reviews.get(principal, params.id);
  }

  @Post(':id/decisions')
  @Idempotent()
  decide(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AccessReviewDecisionBody) body: z.infer<typeof AccessReviewDecisionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AccessReview> {
    return this.reviews.decide(principal, params.id, body, correlationId);
  }
}
