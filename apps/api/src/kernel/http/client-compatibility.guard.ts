import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, errors } from '@sportspark/contracts';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import type { RequestWithContext } from './request-context';

/**
 * The client identification header (SPK-AT-027, §4.13), as the generated API client already sends
 * it (`packages/api-client/src/client-info.ts`): `sportspark-<app>/<version> (<platform>)`, for
 * example `sportspark-mobile/1.2.0 (ios)`. It carries no device or user data.
 */
export const CLIENT_INFO_HEADER = 'x-sportspark-client';

const CLIENT_INFO = /^sportspark-(mobile|staff)\/([0-9A-Za-z.+-]+) \((ios|android|web)\)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const ANY_CLIENT_VERSION_KEY = 'sportspark:any-client-version';

/** Marks a route every client build may call (liveness and readiness, SPK-AT-027 step 2). */
export const AnyClientVersion = () => SetMetadata(ANY_CLIENT_VERSION_KEY, true);

export interface ClientIdentity {
  app: 'mobile' | 'staff';
  platform: 'ios' | 'android' | 'web';
  version: string;
}

export function parseClientIdentity(value: string): ClientIdentity | null {
  const match = CLIENT_INFO.exec(value.trim());
  if (!match || !SEMVER.test(match[2] as string)) return null;
  return {
    app: match[1] as ClientIdentity['app'],
    version: match[2] as string,
    platform: match[3] as ClientIdentity['platform'],
  };
}

/** Semantic-version order: numeric major.minor.patch, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a semantic version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return 0;
}

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
