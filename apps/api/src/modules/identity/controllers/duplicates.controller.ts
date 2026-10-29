import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  DismissDuplicateBody,
  FlagDuplicateBody,
  MergeDuplicateBody,
  ListDuplicateCandidatesQuery,
  z,
  type DuplicateCandidate,
  type DuplicateCandidateDetail,
  type DuplicateCandidateView,
  type Page,
  type PersonMerge,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { DuplicatesService } from '../services/duplicates.service';

const IdParams = z.object({ id: z.uuid() });

@Controller('duplicate-candidates')
export class DuplicatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  @Post()
  @Idempotent()
  flag(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(FlagDuplicateBody) body: z.infer<typeof FlagDuplicateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DuplicateCandidate> {
    return this.duplicates.flag(principal, body, correlationId);
  }

  /** GET /v1/duplicate-candidates (ID-05): default open, names and signals, no dates of birth. */
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListDuplicateCandidatesQuery) query: z.infer<typeof ListDuplicateCandidatesQuery>,
  ): Promise<Page<DuplicateCandidateView>> {
    return this.duplicates.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<DuplicateCandidateDetail> {
    return this.duplicates.get(principal, params.id);
  }

  @Post(':id/merge')
  @Idempotent()
  merge(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(MergeDuplicateBody) body: z.infer<typeof MergeDuplicateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PersonMerge> {
    return this.duplicates.merge(principal, params.id, body, correlationId);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @Idempotent()
  dismiss(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DismissDuplicateBody) body: z.infer<typeof DismissDuplicateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DuplicateCandidate> {
    return this.duplicates.dismiss(principal, params.id, body, correlationId);
  }
}
