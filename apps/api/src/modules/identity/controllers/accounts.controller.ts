import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  CreateAccountBody,
  DevTokenBody,
  RelinkAccountBody,
  z,
  type Account,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  Public,
  RateLimited,
  ZodBody,
  ZodParams,
} from '../../../kernel';
import { CorrelationId } from '../identity.shared';
import { AccountsService } from '../services/accounts.service';

const IdParams = z.object({ id: z.uuid() });

@Controller()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post('accounts')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAccountBody) body: z.infer<typeof CreateAccountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Account> {
    return this.accounts.createAccount(principal, body, correlationId);
  }

  @Post('accounts/:id/relink')
  @HttpCode(200)
  @Idempotent()
  @RateLimited('account_recovery')
  relink(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RelinkAccountBody) body: z.infer<typeof RelinkAccountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Account> {
    return this.accounts.relinkAccount(principal, params.id, body, correlationId);
  }

  /**
   * Development-only: mints a bearer token for an existing account so the API can be exercised
   * manually. Public because it exists to obtain the first token; the service answers NOT_FOUND
   * unless AUTH_MODE=local outside production, and off a developer's own machine unless
   * DEV_TOKENS_PASSCODE is set (§4.14). Rate limited per client address.
   */
  @Public()
  @RateLimited('dev_tokens')
  @Post('dev/tokens')
  mintDevToken(
    @ZodBody(DevTokenBody) body: z.infer<typeof DevTokenBody>,
    @Req() request: Request,
  ): Promise<{ token: string; accountId: string; expiresAt: string }> {
    return this.accounts.mintDevToken(body, {
      host: request.hostname,
      remoteAddress: request.socket?.remoteAddress ?? null,
    });
  }
}
