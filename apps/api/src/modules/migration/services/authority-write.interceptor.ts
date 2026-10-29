import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUuid, type ImportEntityTypeValue } from '@sportspark/contracts';
import type { Observable } from 'rxjs';
import {
  RECORD_AUTHORITY_KEY,
  type RecordAuthorityClassification,
  type RequestWithContext,
} from '../../../kernel';
import type { AuthorityScopeRef } from '../migration.ports';
import {
  matchAuthorityRoute,
  type AuthorityScopeSource,
  type DeclaredScope,
  type ScopeSourceField,
} from './authority-routes';
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

/** What a write route is guarded for, or null when it changes no record of a §5.3 category. */
interface Guard {
  category: ImportEntityTypeValue;
  scope: AuthorityScopeSource;
}

/**
 * Global interceptor registered by MigrationModule (§5.6, §4.7 invariant 11): refuses the write
 * commands of a record category while the legacy system is authoritative for it, with
 * ACCESS_DENIED and `nextAction: write_in_authoritative_system`. It runs after authentication
 * (guards run before interceptors); with no authority assignment SportsPark is authoritative and
 * nothing changes. It never relaxes any other check: an allowed write still goes through the
 * owning module's own authorization.
 *
 * Classification (MIG-00, IF-41): the handler's K-11 decorator is read first (`@RecordAuthority`
 * guards it, `@NoRecordAuthority` exempts it); a handler without one falls back to the static
 * lists in `authority-routes.ts`. A route both decorated and listed fails the classification test,
 * so the two sources never disagree at run time.
 *
 * The scope is never taken from whatever identifiers a client puts in the body (§4.8): a route
 * either creates a top-level record (organization scope), names the validated field its handler
 * writes to (declared scope), or is `unproven` — then any legacy assignment of the category in
 * effect, at any scope, refuses the write.
 */
@Injectable()
export class AuthorityWriteInterceptor implements NestInterceptor {
  constructor(
    private readonly authority: AuthorityService,
    private readonly reflector: Reflector,
  ) {}

  private guardOf(context: ExecutionContext, method: string, routePath: string | undefined) {
    const declared = this.reflector.get<RecordAuthorityClassification | undefined>(
      RECORD_AUTHORITY_KEY,
      context.getHandler(),
    );
    if (declared) {
      return declared.kind === 'guarded'
        ? ({ category: declared.category, scope: declared.scope } satisfies Guard)
        : null;
    }
    const listed = matchAuthorityRoute(method, routePath);
    return listed ? ({ category: listed.category, scope: listed.scope } satisfies Guard) : null;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RoutedRequest>();
    const method = (request.method ?? '').toUpperCase();
    if (!WRITES.has(method)) return next.handle();
    const principal = request.principal;
    if (!principal || principal.kind === 'anonymous' || !principal.organizationId) {
      return next.handle();
    }
    const guard = this.guardOf(context, method, request.route?.path);
    if (!guard) return next.handle();
    if (guard.scope === 'unproven') {
      await this.authority.assertNoLegacyAuthorityInEffect(
        principal.organizationId,
        guard.category,
      );
    } else {
      await this.authority.assertSportsparkAuthority(
        principal.organizationId,
        guard.category,
        guard.scope === 'organization' ? {} : declaredScope(request, guard.scope),
      );
    }
    return next.handle();
  }
}
