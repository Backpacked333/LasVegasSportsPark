import { Controller, HttpCode, Post } from '@nestjs/common';
import {
  AcceptClaimBody,
  RevokeClaimBody,
  z,
  type Claim,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { ClaimsService, type ClaimAccepted } from '../services/claims.service';

const TokenParams = z.object({ token: z.string().min(16).max(512) });
const IdParams = z.object({ id: z.uuid() });

@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  /** §4.14: the claim token travels in the body, never in the URL path (proxies log paths). */
  @Post('accept')
  @HttpCode(200)
  @Idempotent()
  acceptWithBody(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(AcceptClaimBody) body: z.infer<typeof AcceptClaimBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ClaimAccepted> {
    return this.claims.accept(principal, body.token, correlationId);
  }

  /** Deprecated (token in the path); kept until clients move to `POST /claims/accept`. */
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

  @Post(':id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RevokeClaimBody) body: z.infer<typeof RevokeClaimBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Claim> {
    return this.claims.revoke(principal, params.id, body, correlationId);
  }
}
