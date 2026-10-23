import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  DismissDuplicateBody,
  FlagDuplicateBody,
  MergeDuplicateBody,
  z,
  type DuplicateCandidate,
  type PersonMerge,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
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
