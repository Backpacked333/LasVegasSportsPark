import {
  type CanActivate,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CreateAccountBody,
  DevTokenBody,
  RelinkAccountBody,
  z,
  type Account,
  type Principal,
  errors,
} from '@sportspark/contracts';
import {
  APP_CONFIG,
  type AppConfig,
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

/**
 * §5.2, §4.14: outside development with the local identity provider, `POST /v1/dev/tokens` is
 * indistinguishable from an absent route, before its body is validated.
 */
@Injectable()
class DevTokensAvailable implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (this.config.AUTH_MODE !== 'local' || this.config.NODE_ENV === 'production') {
      throw errors.notFound('route');
    }
    return true;
  }
}

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
  @UseGuards(DevTokensAvailable)
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
