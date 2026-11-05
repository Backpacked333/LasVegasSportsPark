import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CLIENT_INFO_HEADER,
  compareVersions,
  DomainError,
  errors,
  parseClientIdentity,
} from '@sportspark/contracts';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import type { RequestWithContext } from './request-context';

/**
 * The client identification header (SPK-AT-027, §4.13) and its reading are defined once in
 * `packages/contracts/src/commands.ts` (K-03): `sportspark-<app>/<version> (<platform>)`, for
 * example `sportspark-mobile/1.2.0 (ios)`. Re-exported here for the kernel's callers.
 */
export { CLIENT_INFO_HEADER, compareVersions, parseClientIdentity };
export type { ClientIdentity } from '@sportspark/contracts';

export const ANY_CLIENT_VERSION_KEY = 'sportspark:any-client-version';

/** Marks a route every client build may call (liveness and readiness, SPK-AT-027 step 2). */
export const AnyClientVersion = () => SetMetadata(ANY_CLIENT_VERSION_KEY, true);

/**
 * Client compatibility gate (SPK-AT-027 "Old mobile app contacts updated API: supported behavior
 * or clear update requirement", §4.13 minimum supported app version, §4.10 stable errors).
 *
 * - No `X-Sportspark-Client` header: a browser, a server or a provider webhook, served as a
 *   supported client (the fixture's step 3).
 * - A malformed header: 400 VALIDATION_FAILED naming the header.
 * - A build below the configured minimum for its app and platform (`CLIENT_MIN_VERSIONS`):
 *   426 CLIENT_UPDATE_REQUIRED, next action `update_app`, `details.minimumVersion`.
 *
 * It runs after authentication (registered after the AuthGuard), so an unauthenticated old client
 * still gets 401 first; liveness and readiness answer every build (`@AnyClientVersion()`). The
 * minimum versions are pending DEC-061 and none is enforced by default; the error code is the one
 * DEC-092 proposes.
 */
@Injectable()
export class ClientCompatibilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const exempt = this.reflector.getAllAndOverride<boolean>(ANY_CLIENT_VERSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const raw = request.headers[CLIENT_INFO_HEADER];
    if (raw === undefined) return true;
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    const client = parseClientIdentity(value);
    if (!client) {
      throw errors.validation(
        'The X-Sportspark-Client header must read "sportspark-<app>/<major.minor.patch> (<platform>)".',
        { header: 'X-Sportspark-Client' },
      );
    }
    const minimumVersion = this.config.CLIENT_MIN_VERSIONS[`${client.app}-${client.platform}`];
    if (minimumVersion && compareVersions(client.version, minimumVersion) < 0) {
      throw new DomainError(
        'CLIENT_UPDATE_REQUIRED',
        'This version of the app is no longer supported. Update the app to continue.',
        {
          details: {
            app: client.app,
            platform: client.platform,
            clientVersion: client.version,
            minimumVersion,
          },
        },
      );
    }
    return true;
  }
}
