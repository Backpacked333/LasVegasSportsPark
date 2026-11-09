import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@sportspark/contracts';
import type { Request } from 'express';
import type { VerifiedIdentity } from '../auth/identity-provider.port';

export interface RequestWithContext extends Request {
  correlationId: string;
  principal?: Principal;
  /**
   * The identity the bearer token proved, set by the authentication guard whenever a token was
   * presented and verified, also when no account matches it yet (SPK-IAM-002). Its claims are never
   * an authorization on their own.
   */
  verifiedIdentity?: VerifiedIdentity;
}

/** Injects the request's correlation id (`X-Correlation-Id`, §4.10) into a handler parameter. */
export const CurrentCorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

/**
 * Injects the identity the request's bearer token proved, or null when no token was sent
 * (SPK-IAM-002). For the two commands that act before a principal exists or on the provider's
 * verified contact claims; every other handler uses `CurrentPrincipal`.
 */
export const CurrentVerifiedIdentity = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): VerifiedIdentity | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().verifiedIdentity ?? null,
);
