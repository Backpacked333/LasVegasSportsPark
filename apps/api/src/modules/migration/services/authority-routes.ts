import type {
  AuthorityScopeSource,
  DeclaredScope,
  ImportEntityTypeValue,
  ScopeSourceField,
} from '@sportspark/contracts';

/**
 * Where a guarded write's authority scope comes from (§5.6): `organization`, `unproven` (the
 * default) or the validated fields the handler itself uses. The types are defined once in
 * packages/contracts (K-11, IF-41), where the kernel's `@RecordAuthority` decorator uses them, and
 * re-exported here for this module's callers.
 */
export type { AuthorityScopeSource, DeclaredScope, ScopeSourceField };

/**
 * The HTTP write commands of each record category (§5.6 "a synchronized copy does not become an
 * independent writer"). While the legacy system is authoritative for a category, these commands
 * are refused by AuthorityWriteInterceptor, so SportsPark staff and customers cannot create a
 * second, conflicting version of a record the legacy system still owns. Paths are the routes the
 * owning modules register (without the `/v1` prefix).
 *
 * Every served POST/PATCH/PUT/DELETE route is classified exactly once, either here or in
 * AUTHORITY_EXEMPT_ROUTES with the reason it changes no record of an authority category; a test
 * (`__tests__/authority.spec.ts`) fails on an unclassified route, so a new write route is never
 * allowed by default.
 */
export interface AuthorityRoute {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  category: ImportEntityTypeValue;
  scope: AuthorityScopeSource;
}

export interface AuthorityExemptRoute {
  method: AuthorityRoute['method'];
  path: string;
  reason: string;
}

const r = (
  method: AuthorityRoute['method'],
  path: string,
  category: ImportEntityTypeValue,
  scope: AuthorityScopeSource = 'unproven',
): AuthorityRoute => ({ method, path, category, scope });

const ORG = 'organization' as const;

export const AUTHORITY_ROUTES: readonly AuthorityRoute[] = [
  // identity (authority matrix rows 1-4)
  r('POST', '/people', 'person', ORG),
  r('PATCH', '/people/:id', 'person'),
  r('POST', '/people/:id/contact-points', 'person'),
  r('POST', '/duplicate-candidates/:id/merge', 'person'),
  r('POST', '/households', 'household', ORG),
  r('POST', '/households/:id/members', 'household'),
  r('POST', '/relationships', 'relationship_evidence'),
  r('POST', '/access-grants', 'relationship_evidence'),
  r('POST', '/access-grants/:id/revoke', 'relationship_evidence'),
  r('POST', '/access-reviews', 'relationship_evidence'),
  r('POST', '/access-reviews/:id/decisions', 'relationship_evidence'),
  r('POST', '/invitations', 'relationship_evidence'),
  r('POST', '/invitations/:id/accept', 'relationship_evidence'),
  r('POST', '/invitations/:id/revoke', 'relationship_evidence'),
  r('POST', '/accounts', 'account', ORG),
  r('POST', '/accounts/:id/relink', 'account'),
  r('POST', '/people/:id/claims', 'account'),
  r('POST', '/claims/:token/accept', 'account'),
  r('POST', '/claims/accept', 'account'),
  r('POST', '/claims/:id/revoke', 'account'),
  // catalog: programs and offerings, including sessions (row 5)
  r('POST', '/programs', 'program', ORG),
  r('PATCH', '/programs/:id', 'program', { programId: 'params.id' }),
  r('POST', '/offerings', 'program', {
    programId: 'body.programId',
    facilityId: 'body.facilityId',
  }),
  r('PATCH', '/offerings/:id', 'program'),
  r('POST', '/offerings/:id/archive', 'program'),
  r('POST', '/offerings/:id/capacity-pools/sync', 'program'),
  r('POST', '/offerings/:id/close', 'program'),
  r('POST', '/offerings/:id/copy', 'program'),
  r('POST', '/offerings/:id/price-rules', 'program'),
  r('POST', '/offerings/:id/publish', 'program'),
  r('POST', '/offerings/:id/registration/open', 'program'),
  r('POST', '/offerings/:id/registration/pause', 'program'),
  r('POST', '/offerings/:id/registration/resume', 'program'),
  r('POST', '/offerings/:id/sessions', 'program'),
  r('POST', '/sessions/:id/cancel', 'program'),
  // enrollment: youth-program participation follows its offering (authority matrix §4.1, a
  // proposed reading pending DEC-014; refusing is the conservative behaviour until decided)
  r('POST', '/capacity-pools', 'program'),
  r('POST', '/capacity-pools/:id/adjust', 'program'),
  r('POST', '/applications', 'program'),
  r('POST', '/applications/:id/accept', 'program'),
  r('POST', '/applications/:id/decline', 'program'),
  r('POST', '/applications/:id/override-eligibility', 'program'),
  r('POST', '/applications/:id/withdraw', 'program'),
  r('POST', '/baskets', 'program'),
  r('POST', '/baskets/:id/complete', 'program'),
  r('POST', '/baskets/:id/hold', 'program'),
  r('POST', '/baskets/:id/lines', 'program'),
  r('POST', '/baskets/:id/lines/:lineId/remove', 'program'),
  r('POST', '/baskets/:id/release', 'program'),
  r('POST', '/enrollments/:id/cancel', 'program'),
  r('POST', '/enrollments/:id/complete', 'program'),
  r('POST', '/enrollments/:id/transfer', 'program'),
  r('POST', '/waitlist-entries', 'program'),
  r('POST', '/waitlist-entries/:id/remove', 'program'),
  r('POST', '/waitlist-entries/:id/withdraw', 'program'),
  r('POST', '/waitlist-offers/:id/accept', 'program'),
  r('POST', '/waitlist-offers/:id/decline', 'program'),
  r('POST', '/placement-requests', 'program'),
  r('POST', '/placement-requests/:id/assign', 'program'),
  r('POST', '/placement-requests/:id/propose', 'program'),
  r('POST', '/placement-requests/:id/reject-proposal', 'program'),
  r('POST', '/placement-requests/:id/release', 'program'),
  r('POST', '/session-bookings', 'program'),
  r('POST', '/session-bookings/:id/cancel', 'program'),
  r('POST', '/session-bookings/:id/confirm', 'program'),
  r('POST', '/trial-participations', 'program'),
  r('POST', '/trial-participations/:id/convert', 'program'),
  r('POST', '/trial-participations/:id/outcome', 'program'),
  // makeup entitlements are credits for authority purposes (row 14)
  r('POST', '/makeup-entitlements', 'credit'),
  r('POST', '/makeup-entitlements/:id/redeem', 'credit'),
  r('POST', '/makeup-entitlements/:id/revoke', 'credit'),
  // documents: the forms and waivers a person signs (row 16)
  r('POST', '/acknowledgments', 'document'),
  r('POST', '/acknowledgments/:id/withdraw', 'document'),
  // competition: competitions, seasons, divisions (row 6), teams (7), rosters (8), results (11)
  r('POST', '/competitions', 'season', ORG),
  r('PATCH', '/competitions/:id', 'season', { competitionId: 'params.id' }),
  r('POST', '/seasons', 'season', { competitionId: 'body.competitionId' }),
  r('PATCH', '/seasons/:id', 'season'),
  // A division's `facilityId` names a venue, not the authority scope: unproven.
  r('POST', '/divisions', 'season'),
  r('PATCH', '/divisions/:id', 'season'),
  r('POST', '/divisions/:id/fixture-specifications', 'season'),
  r('POST', '/seasons/:id/bracket-nodes', 'season'),
  r('POST', '/team-entries', 'team'),
  r('POST', '/team-entries/:id/approve', 'team'),
  r('POST', '/team-entries/:id/reject', 'team'),
  r('POST', '/team-entries/:id/withdraw', 'team'),
  r('PATCH', '/teams/:id', 'team'),
  r('POST', '/team-entries/:id/roster', 'roster'),
  r('POST', '/team-entries/:id/invitations', 'roster'),
  r('POST', '/team-invitations/:id/accept', 'roster'),
  r('POST', '/team-invitations/:id/revoke', 'roster'),
  r('POST', '/team-entries/:id/join-requests', 'roster'),
  r('POST', '/join-requests/:id/decide', 'roster'),
  r('POST', '/fixtures/:id/results', 'result'),
  r('POST', '/results/:id/submit', 'result'),
  r('POST', '/results/:id/publish', 'result'),
  r('POST', '/results/:id/return', 'result'),
  r('POST', '/fixtures/:id/disputes', 'result'),
  r('POST', '/disputes/:id/decide', 'result'),
  r('POST', '/bracket-nodes/:id/publish', 'result'),
  // scheduling: one effective scheduling authority for shared pitches (§5.6, rows 9 and 18).
  // Schedule authority is organization- or facility-scoped only.
  r('POST', '/schedule-drafts', 'future_schedule', { facilityId: 'body.facilityId' }),
  r('PATCH', '/schedule-drafts/:id', 'future_schedule'),
  r('POST', '/schedule-drafts/:id/publish', 'future_schedule'),
  r('POST', '/schedule-drafts/:id/discard', 'future_schedule'),
  r('POST', '/event-series', 'future_schedule', { facilityId: 'body.facilityId' }),
  r('POST', '/event-series/:id/edits', 'future_schedule'),
  r('POST', '/fixtures', 'future_schedule', { facilityId: 'body.schedule.facilityId' }),
  // A reschedule may move a fixture from one facility to another: unproven.
  r('PATCH', '/fixtures/:id', 'future_schedule'),
  r('POST', '/fixture-specifications/:id/generate', 'future_schedule'),
  r('POST', '/closures', 'future_schedule', { facilityId: 'body.facilityId' }),
  r('POST', '/closures/:id/apply', 'future_schedule'),
  r('POST', '/closures/:id/lift', 'future_schedule'),
  // facilities: maintenance restrictions occupy pitches through a closure (row 18)
  r('POST', '/maintenance-restrictions', 'future_schedule', { facilityId: 'body.facilityId' }),
  r('POST', '/maintenance-restrictions/:id/approve', 'future_schedule'),
  r('POST', '/maintenance-restrictions/:id/release', 'future_schedule'),
  // entry: attendance (row 10)
  r('POST', '/attendance-observations', 'attendance_history'),
  r('POST', '/attendance-observations/:id/corrections', 'attendance_history'),
  r('POST', '/offline-sync', 'attendance_history'),
  r('POST', '/session-checkins', 'attendance_history'),
  r('POST', '/session-checkins/:id/recheck', 'attendance_history'),
  r('POST', '/session-checkins/:id/withdraw', 'attendance_history'),
  r('POST', '/visits', 'attendance_history'),
  r('POST', '/visits/:id/void', 'attendance_history'),
  r('POST', '/departures', 'attendance_history'),
  r('POST', '/releases', 'attendance_history'),
  // finance: orders (row 12), open obligations (13), credits (14), refunds (15)
  r('POST', '/registration-checkouts', 'order'),
  r('POST', '/registration-checkouts/:id/payments', 'order'),
  r('POST', '/obligations', 'open_obligation'),
  r('POST', '/obligations/:id/payments', 'open_obligation'),
  r('POST', '/obligations/:id/contribution-requests', 'open_obligation'),
  r('POST', '/contribution-requests/:id/pay', 'open_obligation'),
  r('POST', '/installments/:id/collect', 'open_obligation'),
  r('POST', '/installments/:id/extend', 'open_obligation'),
  r('POST', '/cash-tenders', 'open_obligation'),
  r('POST', '/credits', 'credit'),
  r('POST', '/credits/:id/redeem', 'credit'),
  r('POST', '/credits/:id/approve', 'credit'),
  r('POST', '/payments/:id/refunds', 'refund'),
  // communications (row 17)
  r('PATCH', '/me/communication-preferences', 'communication_preference'),
];

const NOT_A_CATEGORY = 'Not a §5.3 record category (authority matrix §4.1 scope notes).';
const OWN = 'Migration owns these records; the authority matrix governs other modules.';
const RESOLVE_UNKNOWN =
  'Resolves an unknown or in-flight outcome of a command already accepted (§4.11); refusing it would strand money.';
const PROVIDER = 'Provider evidence (§5.2); recording an outcome never creates a second writer.';
const PREVIEW = 'Preview or evaluation; writes no record of an authority category.';

const x = (
  method: AuthorityRoute['method'],
  path: string,
  reason: string,
): AuthorityExemptRoute => ({ method, path, reason });

/** Served write routes that change no record of an authority category, with the reason. */
export const AUTHORITY_EXEMPT_ROUTES: readonly AuthorityExemptRoute[] = [
  // kernel
  x(
    'POST',
    '/recovery/resume',
    'Ends recovery mode after a restore once provider facts are reconciled (§5.8, SPK-AT-028); resolves an operational exception, no record of an authority category.',
  ),
  // Kernel capability switches (K-12). The handlers also carry @NoRecordAuthority; these two
  // entries leave this list when MIG-00 counts the decorators (a route listed and decorated then
  // fails the classification test).
  x(
    'POST',
    '/admin/capabilities/:capability/enable',
    'Not a §5.3 record category: changes an organization capability switch (DEC-016).',
  ),
  x(
    'POST',
    '/admin/capabilities/:capability/disable',
    'Not a §5.3 record category: changes an organization capability switch (DEC-016).',
  ),
  // identity
  x('POST', '/duplicate-candidates', 'Flags a possible duplicate for review; changes no person.'),
  x('POST', '/duplicate-candidates/:id/dismiss', 'Dismisses a flag; changes no person.'),
  x('POST', '/staff-memberships', NOT_A_CATEGORY),
  x('POST', '/staff-memberships/:id/end', NOT_A_CATEGORY),
  x('PATCH', '/staff-memberships/:id', NOT_A_CATEGORY),
  x('POST', '/dev/tokens', 'Development token issuer; not served in production.'),
  // catalog and competition configuration
  x('POST', '/discounts', NOT_A_CATEGORY),
  x('PATCH', '/discounts/:id', NOT_A_CATEGORY),
  x('POST', '/discounts/:id/retire', NOT_A_CATEGORY),
  x('POST', '/discounts/evaluate', PREVIEW),
  x('POST', '/entitlement-definitions', NOT_A_CATEGORY),
  x('PATCH', '/entitlement-definitions/:id', NOT_A_CATEGORY),
  x('POST', '/rule-sets', NOT_A_CATEGORY),
  // Policy text is configuration that exists before SportsPark takes any authority (rule 5); the
  // acknowledgments a person signs are the document records of row 16 and are guarded.
  x('POST', '/policy-versions', NOT_A_CATEGORY),
  x('POST', '/policy-versions/:id/approve', NOT_A_CATEGORY),
  x('POST', '/policy-versions/:id/retire', NOT_A_CATEGORY),
  x('POST', '/fixtures/:id/availability', NOT_A_CATEGORY),
  // discipline records are not assigned (authority matrix §4.1)
  x('POST', '/disciplinary-decisions', NOT_A_CATEGORY),
  x('POST', '/disciplinary-decisions/:id/overturn', NOT_A_CATEGORY),
  x('POST', '/suspensions', NOT_A_CATEGORY),
  x('PATCH', '/suspensions/:id', NOT_A_CATEGORY),
  x('POST', '/appeals', NOT_A_CATEGORY),
  x('POST', '/appeals/:id/decide', NOT_A_CATEGORY),
  x('POST', '/incidents', NOT_A_CATEGORY),
  x('PATCH', '/incidents/:id', NOT_A_CATEGORY),
  // scheduling: the facility inventory is supplied by Operations, not imported (DEC-001)
  x('POST', '/resources', NOT_A_CATEGORY),
  x('PATCH', '/resources/:id', NOT_A_CATEGORY),
  x('POST', '/resource-configurations', NOT_A_CATEGORY),
  x('PATCH', '/resource-configurations/:id', NOT_A_CATEGORY),
  x('POST', '/conflict-units', NOT_A_CATEGORY),
  x('POST', '/operating-hours', NOT_A_CATEGORY),
  x('DELETE', '/operating-hours/:id', NOT_A_CATEGORY),
  x('POST', '/schedule-drafts/:id/validate', PREVIEW),
  // facilities: maintenance assets and tasks are not assigned (authority matrix §4.1)
  x('POST', '/assets', NOT_A_CATEGORY),
  x('PATCH', '/assets/:id', NOT_A_CATEGORY),
  x('DELETE', '/assets/:id', NOT_A_CATEGORY),
  x('POST', '/maintenance-tasks', NOT_A_CATEGORY),
  x('PATCH', '/maintenance-tasks/:id', NOT_A_CATEGORY),
  x('POST', '/maintenance-tasks/:id/inspections', NOT_A_CATEGORY),
  x('POST', '/preventive-schedules', NOT_A_CATEGORY),
  x('PATCH', '/preventive-schedules/:id', NOT_A_CATEGORY),
  x('POST', '/preventive-schedules/:id/generate', NOT_A_CATEGORY),
  // entry
  x('POST', '/passes', NOT_A_CATEGORY),
  x('POST', '/passes/:id/revoke', NOT_A_CATEGORY),
  x('POST', '/passes/scan', 'A scan writes nothing but its audit record.'),
  x(
    'POST',
    '/facilities/:id/occupancy-snapshots',
    'A head count derived from observations; writes no attendance observation.',
  ),
  x('POST', '/webhooks/access-control/:provider', PROVIDER),
  // finance
  x('POST', '/registration-quotes', PREVIEW),
  x('POST', '/registration-checkouts/:id/recover', RESOLVE_UNKNOWN),
  x('POST', '/registration-checkouts/:id/compensate', RESOLVE_UNKNOWN),
  x('POST', '/registration-checkouts/:id/abort', RESOLVE_UNKNOWN),
  x('POST', '/payments/:id/reconcile', RESOLVE_UNKNOWN),
  x('POST', '/refunds/:id/reconcile', RESOLVE_UNKNOWN),
  x('POST', '/settlement-reconciliations', RESOLVE_UNKNOWN),
  x('POST', '/webhooks/payments/:provider', PROVIDER),
  // communications
  x('POST', '/notifications', NOT_A_CATEGORY),
  x('POST', '/notifications/:id/send', NOT_A_CATEGORY),
  x('POST', '/me/inbox/:id/acknowledge', NOT_A_CATEGORY),
  x('POST', '/me/inbox/:id/read', NOT_A_CATEGORY),
  x('POST', '/me/calendar-feeds', NOT_A_CATEGORY),
  x('POST', '/me/calendar-feeds/:id/revoke', NOT_A_CATEGORY),
  x('POST', '/webhooks/messaging/:provider', PROVIDER),
  // workforce: staff availability and assignments are not assigned (authority matrix §4.1)
  x('POST', '/availability', NOT_A_CATEGORY),
  x('POST', '/availability/:id/withdraw', NOT_A_CATEGORY),
  x('POST', '/assignment-requirements', NOT_A_CATEGORY),
  x('PATCH', '/assignment-requirements/:id', NOT_A_CATEGORY),
  x('POST', '/assignments', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/accept', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/complete', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/decline', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/offer', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/replacements', NOT_A_CATEGORY),
  x('POST', '/assignments/:id/withdraw', NOT_A_CATEGORY),
  x('POST', '/qualifications', NOT_A_CATEGORY),
  x('POST', '/qualifications/:id/reject', NOT_A_CATEGORY),
  x('POST', '/qualifications/:id/revoke', NOT_A_CATEGORY),
  x('POST', '/qualifications/:id/verify', NOT_A_CATEGORY),
  x('POST', '/fee-submissions', NOT_A_CATEGORY),
  x('POST', '/fee-submissions/:id/adjust', NOT_A_CATEGORY),
  x('POST', '/fee-submissions/:id/approve', NOT_A_CATEGORY),
  x('POST', '/fee-submissions/:id/reject', NOT_A_CATEGORY),
  x('POST', '/fee-export-batches', NOT_A_CATEGORY),
  // support: cases are not assigned; the refund helper runs finance.refund, which finance guards
  // in-process (RefundsService.request), and the resend helper sends a message.
  x('POST', '/cases', NOT_A_CATEGORY),
  x('PATCH', '/cases/:id', NOT_A_CATEGORY),
  x('POST', '/cases/:id/assign', NOT_A_CATEGORY),
  x('POST', '/cases/:id/notes', NOT_A_CATEGORY),
  x('POST', '/cases/:id/transition', NOT_A_CATEGORY),
  x('POST', '/cases/:id/actions', 'Links the evidence of a command that already ran.'),
  x('POST', '/cases/:id/actions/:actionId/settle', 'Records what the owning module reports.'),
  x(
    'POST',
    '/cases/:id/request-refund',
    'finance.refund is guarded inside RefundsService.request.',
  ),
  x('POST', '/cases/:id/resend-notification', NOT_A_CATEGORY),
  x('POST', '/exception-queues', NOT_A_CATEGORY),
  x('PATCH', '/exception-queues/:id', NOT_A_CATEGORY),
  x('POST', '/exceptions/:id/acknowledge', NOT_A_CATEGORY),
  x('POST', '/exceptions/:id/resolve', NOT_A_CATEGORY),
  x('POST', '/exceptions/:id/close', NOT_A_CATEGORY),
  // reporting
  x('POST', '/reports/runs', NOT_A_CATEGORY),
  x('POST', '/reports/runs/:id/reproduce', NOT_A_CATEGORY),
  x('POST', '/reports/exports', NOT_A_CATEGORY),
  x('POST', '/reports/exports/:id/revoke', NOT_A_CATEGORY),
  x('POST', '/reports/cost-inputs', NOT_A_CATEGORY),
  x('POST', '/reports/cost-inputs/:id/withdraw', NOT_A_CATEGORY),
  // automation: proposals are applied through the owning modules' exported commands, in-process
  // (README "Known gaps"; refunds are guarded inside finance).
  x('POST', '/assistant/requests', NOT_A_CATEGORY),
  x('POST', '/recommendations/:id/approve', NOT_A_CATEGORY),
  x('POST', '/recommendations/:id/reject', NOT_A_CATEGORY),
  x('POST', '/recommendations/:id/apply', 'Runs owning-module commands in-process.'),
  // migration
  x('POST', '/import-batches', OWN),
  x('POST', '/import-batches/:id/rows', OWN),
  x('POST', '/import-batches/:id/validate', OWN),
  x('POST', '/import-batches/:id/review', OWN),
  x('POST', '/import-batches/:id/apply', OWN),
  x('POST', '/import-batches/:id/abort', OWN),
  x('POST', '/import-batches/:id/reconciliation-reports', OWN),
  x('POST', '/import-exceptions/:id/decide', OWN),
  x('POST', '/import-reconciliation-reports/:id/approvals', OWN),
  x('POST', '/authority-assignments', OWN),
  x('POST', '/authority-assignments/:id/end', OWN),
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
