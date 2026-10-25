import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { isUuid } from '@sportspark/contracts';
import type { Observable } from 'rxjs';
import type { RequestWithContext } from '../../../kernel';
import type { AuthorityScopeRef } from '../migration.ports';
import { matchAuthorityRoute, type DeclaredScope, type ScopeSourceField } from './authority-routes';
import { AuthorityService } from './authority.service';

type RoutedRequest = RequestWithContext & {
  route?: { path?: string };
  params?: Record<string, string>;
};

const WRITES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function field(value: unknown, name: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;
}

/** The value of one declared scope source; anything that is not a UUID is no scope at all. */
function read(request: RoutedRequest, source: ScopeSourceField): string | null {
  const value =
    source === 'params.id'
      ? request.params?.['id']
      : source === 'body.schedule.facilityId'
        ? field(field(request.body, 'schedule'), 'facilityId')
        : field(request.body, source.slice('body.'.length));
  return isUuid(value) ? value : null;
}

function declaredScope(request: RoutedRequest, scope: DeclaredScope): AuthorityScopeRef {
  return {
    facilityId: scope.facilityId ? read(request, scope.facilityId) : null,
    programId: scope.programId ? read(request, scope.programId) : null,
    competitionId: scope.competitionId ? read(request, scope.competitionId) : null,
  };
}

/**
 * Global interceptor registered by MigrationModule (§5.6, §4.7 invariant 11): refuses the write
 * commands of a record category while the legacy system is authoritative for it, with
 * ACCESS_DENIED and `nextAction: write_in_authoritative_system`. It runs after authentication
 * (guards run before interceptors) and only for the routes in AUTHORITY_ROUTES; with no authority
 * assignment SportsPark is authoritative and nothing changes. It never relaxes any other check:
 * an allowed write still goes through the owning module's own authorization.
 *
 * The scope is never taken from whatever identifiers a client puts in the body (§4.8): a route
 * either creates a top-level record (organization scope), names the validated field its handler
 * writes to (declared scope), or is `unproven` — then any legacy assignment of the category in
 * effect, at any scope, refuses the write.
 */
@Injectable()
export class AuthorityWriteInterceptor implements NestInterceptor {
  constructor(private readonly authority: AuthorityService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RoutedRequest>();
    const method = (request.method ?? '').toUpperCase();
    if (!WRITES.has(method)) return next.handle();
    const principal = request.principal;
    if (!principal || principal.kind === 'anonymous' || !principal.organizationId) {
      return next.handle();
    }
    const route = matchAuthorityRoute(method, request.route?.path);
    if (!route) return next.handle();
    if (route.scope === 'unproven') {
      await this.authority.assertNoLegacyAuthorityInEffect(
        principal.organizationId,
        route.category,
      );
    } else {
      await this.authority.assertSportsparkAuthority(
        principal.organizationId,
        route.category,
        route.scope === 'organization' ? {} : declaredScope(request, route.scope),
      );
    }
    return next.handle();
  }
}
