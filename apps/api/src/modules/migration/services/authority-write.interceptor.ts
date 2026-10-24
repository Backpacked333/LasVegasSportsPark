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
import { matchAuthorityRoute } from './authority-routes';
import { AuthorityService } from './authority.service';

type RoutedRequest = RequestWithContext & {
  route?: { path?: string };
  params?: Record<string, string>;
};

const WRITES = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function uuidField(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  return isUuid(value) ? value : null;
}

/**
 * Global interceptor registered by MigrationModule (§5.6, §4.7 invariant 11): refuses the write
 * commands of a record category while the legacy system is authoritative for it, with
 * ACCESS_DENIED and `nextAction: write_in_authoritative_system`. It runs after authentication
 * (guards run before interceptors) and only for the routes in AUTHORITY_ROUTES; with no authority
 * assignment SportsPark is authoritative and nothing changes. It never relaxes any other check:
 * an allowed write still goes through the owning module's own authorization.
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
    const scope: AuthorityScopeRef = {
      facilityId: uuidField(request.body, 'facilityId'),
      programId:
        route.idIsProgram && isUuid(request.params?.['id'])
          ? (request.params?.['id'] ?? null)
          : uuidField(request.body, 'programId'),
      competitionId: uuidField(request.body, 'competitionId'),
    };
    await this.authority.assertSportsparkAuthority(principal.organizationId, route.category, scope);
    return next.handle();
  }
}
