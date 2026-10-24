import type { ImportEntityTypeValue } from '@sportspark/contracts';

/**
 * The HTTP write commands of each record category (§5.6 "a synchronized copy does not become an
 * independent writer"). While the legacy system is authoritative for a category, these commands
 * are refused by AuthorityWriteInterceptor, so SportsPark staff and customers cannot create a
 * second, conflicting version of a record the legacy system still owns. Paths are the routes the
 * owning modules register (without the `/v1` prefix); the scope of a write is taken from the
 * request body (`facilityId`, `programId`, `competitionId`) and, where marked, from the route's
 * `:id` (a program update is scoped to that program).
 *
 * Commands that only read, preview or evaluate (quotes, discount evaluation, pass scans) and
 * provider webhooks are not listed: they change no authoritative record.
 */
export interface AuthorityRoute {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  category: ImportEntityTypeValue;
  /** The route `:id` is the program the write is scoped to. */
  idIsProgram?: boolean;
}

const r = (
  method: AuthorityRoute['method'],
  path: string,
  category: ImportEntityTypeValue,
  options: Pick<AuthorityRoute, 'idIsProgram'> = {},
): AuthorityRoute => ({ method, path, category, ...options });

export const AUTHORITY_ROUTES: readonly AuthorityRoute[] = [
  // identity
  r('POST', '/people', 'person'),
  r('PATCH', '/people/:id', 'person'),
  r('POST', '/people/:id/contact-points', 'person'),
  r('POST', '/households', 'household'),
  r('POST', '/households/:id/members', 'household'),
  r('POST', '/relationships', 'relationship_evidence'),
  r('POST', '/access-grants', 'relationship_evidence'),
  r('POST', '/access-grants/:id/revoke', 'relationship_evidence'),
  r('POST', '/invitations', 'relationship_evidence'),
  r('POST', '/invitations/:id/accept', 'relationship_evidence'),
  r('POST', '/accounts', 'account'),
  r('POST', '/accounts/:id/relink', 'account'),
  r('POST', '/people/:id/claims', 'account'),
  r('POST', '/claims/:token/accept', 'account'),
  // catalog
  r('POST', '/programs', 'program'),
  r('PATCH', '/programs/:id', 'program', { idIsProgram: true }),
  // competition
  r('POST', '/seasons', 'season'),
  r('PATCH', '/seasons/:id', 'season'),
  r('POST', '/divisions', 'season'),
  r('PATCH', '/divisions/:id', 'season'),
  r('POST', '/team-entries', 'team'),
  r('POST', '/team-entries/:id/approve', 'team'),
  r('POST', '/team-entries/:id/reject', 'team'),
  r('POST', '/team-entries/:id/withdraw', 'team'),
  r('PATCH', '/teams/:id', 'team'),
  r('POST', '/team-entries/:id/roster', 'roster'),
  r('POST', '/team-entries/:id/invitations', 'roster'),
  r('POST', '/team-invitations/:id/accept', 'roster'),
  r('POST', '/team-entries/:id/join-requests', 'roster'),
  r('POST', '/join-requests/:id/decide', 'roster'),
  r('POST', '/fixtures/:id/results', 'result'),
  r('POST', '/results/:id/submit', 'result'),
  r('POST', '/results/:id/publish', 'result'),
  // scheduling: one effective scheduling authority for shared pitches (§5.6)
  r('POST', '/schedule-drafts', 'future_schedule'),
  r('PATCH', '/schedule-drafts/:id', 'future_schedule'),
  r('POST', '/schedule-drafts/:id/publish', 'future_schedule'),
  r('POST', '/event-series', 'future_schedule'),
  r('POST', '/event-series/:id/edits', 'future_schedule'),
  r('POST', '/fixtures', 'future_schedule'),
  r('PATCH', '/fixtures/:id', 'future_schedule'),
  // entry
  r('POST', '/attendance-observations', 'attendance_history'),
  r('POST', '/attendance-observations/:id/corrections', 'attendance_history'),
  // finance
  r('POST', '/registration-checkouts', 'order'),
  r('POST', '/registration-checkouts/:id/payments', 'order'),
  r('POST', '/obligations', 'open_obligation'),
  r('POST', '/obligations/:id/payments', 'open_obligation'),
  r('POST', '/obligations/:id/contribution-requests', 'open_obligation'),
  r('POST', '/contribution-requests/:id/pay', 'open_obligation'),
  r('POST', '/installments/:id/collect', 'open_obligation'),
  r('POST', '/cash-tenders', 'open_obligation'),
  r('POST', '/credits', 'credit'),
  r('POST', '/credits/:id/redeem', 'credit'),
  r('POST', '/credits/:id/approve', 'credit'),
  r('POST', '/payments/:id/refunds', 'refund'),
  // communications
  r('PATCH', '/me/communication-preferences', 'communication_preference'),
];

const BY_KEY = new Map(AUTHORITY_ROUTES.map((route) => [`${route.method} ${route.path}`, route]));

/** Matches the Express route pattern of a request (e.g. `/v1/people/:id`). */
export function matchAuthorityRoute(
  method: string,
  routePath: string | undefined,
): AuthorityRoute | undefined {
  if (!routePath) return undefined;
  const path = routePath.replace(/^\/v1(?=\/)/, '').replace(/\/+$/, '');
  return BY_KEY.get(`${method.toUpperCase()} ${path}`);
}
