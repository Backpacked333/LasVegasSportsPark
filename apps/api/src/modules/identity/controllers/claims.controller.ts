import { Controller, HttpCode, Post } from '@nestjs/common';
import { z, type Principal } from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { ClaimsService, type ClaimAccepted } from '../services/claims.service';

const TokenParams = z.object({ token: z.string().min(16).max(512) });

@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post(':token/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(TokenParams) params: z.infer<typeof TokenParams>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ClaimAccepted> {
    return this.claims.accept(principal, params.token, correlationId);
  }
}
