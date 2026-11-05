import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANONYMOUS_PRINCIPAL, errors } from '@sportspark/contracts';
import type { RequestWithContext } from '../http/request-context';
import { IDENTITY_PROVIDER, PRINCIPAL_RESOLVER_PORT } from '../tokens';
import type { IdentityProviderPort } from './identity-provider.port';
import type { PrincipalResolverPort } from './principal-resolver.port';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Global authentication guard. Every route requires a bearer token unless marked @Public().
 * The organization context of the principal comes from the resolver, never from the request (§4.8).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(IDENTITY_PROVIDER) private readonly identityProvider: IdentityProviderPort,
    @Inject(PRINCIPAL_RESOLVER_PORT) private readonly resolver: PrincipalResolverPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token) {
      if (isPublic) {
        request.principal = ANONYMOUS_PRINCIPAL;
        return true;
      }
      throw errors.authenticationRequired();
    }

    const identity = await this.identityProvider.verify(token);
    const principal = await this.resolver.resolve(identity);
    if (!principal) {
      if (isPublic) {
        request.principal = ANONYMOUS_PRINCIPAL;
        return true;
      }
      throw errors.authenticationRequired('No active account matches this token.');
    }
    if (principal.kind !== 'anonymous' && !principal.organizationId) {
      throw errors.authenticationRequired('The account is not attached to an organization.');
    }
    request.principal = principal;
    return true;
  }
}
