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
  RegisterAccountBody,
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
  CurrentVerifiedIdentity,
  Idempotent,
  Public,
  RateLimited,
  ZodBody,
  ZodParams,
  type VerifiedIdentity,
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

  /**
   * Public because the caller has no account yet; the bearer token the identity provider signed is
   * required and is the only proof (SPK-IAM-002). Not `@Idempotent()`: an idempotency key is
   * scoped to a principal, and `(issuer, subject)` is unique, so a repeat answers the same account.
   */
  @Public()
  @RateLimited('account_registration')
  @Post('accounts/register')
  @HttpCode(200)
  register(
    @CurrentVerifiedIdentity() identity: VerifiedIdentity | null,
    @ZodBody(RegisterAccountBody) body: z.infer<typeof RegisterAccountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Account> {
    if (!identity) throw errors.authenticationRequired();
    return this.accounts.registerAccount(identity, body, correlationId);
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
    const headers = request.headers;
    return this.accounts.mintDevToken(body, {
      // The Host header itself, never `request.hostname`: with TRUST_PROXY that would come from a
      // caller-supplied X-Forwarded-Host.
      host: hostOf(headers.host),
      remoteAddress: request.socket?.remoteAddress ?? null,
      // A request a proxy forwarded is never the developer's own machine or network (§4.14).
      forwarded: FORWARDING_HEADERS.some((name) => headers[name] !== undefined),
    });
  }
}

/** Headers a reverse proxy or load balancer adds to what it forwards. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'];

/** The host of a Host header without its port (`10.0.2.2:3000` → `10.0.2.2`, `[::1]:3000` → `::1`). */
function hostOf(header: string | undefined): string | null {
  if (!header) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  if (bracketed) return bracketed[1] ?? null;
  return header.replace(/:\d+$/, '');
}
