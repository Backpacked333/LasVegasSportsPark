/**
 * Test doubles for screens and hooks (`@sportspark/api-client/testing`). Deterministic only: no
 * network, no timers, no randomness. Use with `createApiClient({ fetch: fake.fetch, ... })` or the
 * apps' test service factories.
 *
 *   const fake = createFakeFetch({
 *     'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
 *     'POST /assignments/{id}/accept': (req) => fakeResponse(409, apiErrorBody('STALE_REVISION')),
 *   });
 */
import { CAPABILITY_IDS, type CapabilityId } from './capabilities';
import type { FetchLike } from './client';
import type { ErrorCode } from './errors';
import { NAVIGATION_AREAS, type MePermissions, type NavigationAreaId } from './permissions';

export interface FakeRequest {
  method: string;
  /** Path after the base URL, without the query, e.g. `/assignments/abc/accept`. */
  path: string;
  /** The matched route template, e.g. `/assignments/{id}/accept`. */
  route: string | null;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface StaticResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeHandler = StaticResponse | ((request: FakeRequest) => Response | Promise<Response>);

/** A minimal `Response` that works in every test environment (Node, jsdom, React Native jest). */
export function fakeResponse(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  } as unknown as Response;
}

/** The §4.10 error body the API sends. */
export function apiErrorBody(
  code: ErrorCode | (string & {}),
  overrides: {
    message?: string;
    nextAction?: string;
    details?: unknown;
    correlationId?: string;
  } = {},
) {
  return {
    code,
    message: overrides.message ?? `Fake ${code}`,
    correlationId: overrides.correlationId ?? 'test-correlation-id',
    nextAction: overrides.nextAction ?? 'retry_or_contact_support',
    ...(overrides.details === undefined ? {} : { details: overrides.details }),
  };
}

function templateToRegExp(template: string): { regexp: RegExp; names: string[] } {
  const names: string[] = [];
  const pattern = template
    .split('/')
    .map((segment) => {
      const m = /^\{(.+)\}$/.exec(segment);
      if (m) {
        names.push(m[1] as string);
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regexp: new RegExp(`^${pattern}$`), names };
}

export interface FakeFetch {
  fetch: FetchLike;
  /** Every request in order, for assertions on headers, keys and bodies. */
  requests: FakeRequest[];
  /** Replace or add a route during a test. */
  set(route: string, handler: FakeHandler): void;
}

/**
 * Routes are `"<METHOD> <path template>"` with OpenAPI-style `{param}` segments. An unmatched
 * request answers 404 NOT_FOUND, like a record the caller may not see.
 */
export function createFakeFetch(
  routes: Record<string, FakeHandler> = {},
  options: { baseUrl?: string } = {},
): FakeFetch {
  const table = new Map<string, FakeHandler>(Object.entries(routes));
  const requests: FakeRequest[] = [];
  const baseUrl = options.baseUrl ?? '';

  const fetch: FetchLike = async (input, init) => {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const url = input.startsWith(baseUrl) ? input.slice(baseUrl.length) : input;
    const [rawPath = '', rawQuery = ''] = url.replace(/^https?:\/\/[^/]+/, '').split('?');
    const path = rawPath.replace(/^\/v1(?=\/)/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const query = Object.fromEntries(new URLSearchParams(rawQuery));
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

    for (const [key, handler] of table) {
      const [routeMethod, template = ''] = key.split(' ');
      if (routeMethod !== method) continue;
      const { regexp, names } = templateToRegExp(template);
      const match = regexp.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(
        names.map((n, i) => [n, decodeURIComponent(match[i + 1] as string)]),
      );
      const request: FakeRequest = { method, path, route: template, params, query, headers, body };
      requests.push(request);
      if (typeof handler === 'function') return handler(request);
      return fakeResponse(handler.status, handler.body, handler.headers);
    }
    requests.push({ method, path, route: null, params: {}, query, headers, body });
    return fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }));
  };

  return { fetch, requests, set: (route, handler) => void table.set(route, handler) };
}

/** Keys key-00000001, key-00000002, ... so tests can assert which intent a request belonged to. */
export function sequentialKeys(prefix = 'key'): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(8, '0')}`;
}

/** Capabilities the API answers with commands enforcement; the rest are recorded only (K-12). */
const RECORDED_ONLY: ReadonlySet<CapabilityId> = new Set([
  'installments',
  'supervised_pickup',
  'advanced_fairness',
  'retention_tools',
]);

export interface FakePermissionsOptions {
  principalKind?: MePermissions['principalKind'];
  staffRoles?: MePermissions['staffRoles'];
  /** Action ids allowed outright (every facility), or `{ id, facilityIds }` for a scoped one. */
  actions?: readonly (string | { id: string; facilityIds: string[] | null })[];
  conditionalActions?: readonly {
    id: string;
    self?: boolean;
    subjectPermission?: string | null;
    teamRole?: string | null;
  }[];
  /** Visible navigation areas; default every area (a general manager). */
  areas?: readonly NavigationAreaId[];
  /** Switches that are on; every other one is off, as the API starts (DEC-016). */
  enabled?: readonly CapabilityId[];
  evaluatedAt?: string;
}

/**
 * A `GET /v1/me/permissions` body (MePermissions). Defaults: a staff principal, every navigation
 * area visible, no actions, and every capability switch off (the API's starting state).
 *
 *   'GET /me/permissions': { status: 200, body: fakePermissions({ enabled: ['rentals'] }) }
 */
export function fakePermissions(options: FakePermissionsOptions = {}): MePermissions {
  const visible = new Set<NavigationAreaId>(options.areas ?? NAVIGATION_AREAS);
  const enabled = new Set<CapabilityId>(options.enabled ?? []);
  return {
    evaluatedAt: options.evaluatedAt ?? '2026-10-24T12:00:00.000Z',
    principalKind: options.principalKind ?? 'staff',
    staffRoles:
      options.staffRoles ?? (options.principalKind === 'customer' ? [] : ['general_manager']),
    actions: (options.actions ?? []).map((a) =>
      typeof a === 'string'
        ? { id: a, facilityIds: null }
        : { id: a.id, facilityIds: a.facilityIds },
    ),
    conditionalActions: (options.conditionalActions ?? []).map((a) => ({
      id: a.id,
      self: a.self ?? false,
      subjectPermission: a.subjectPermission ?? null,
      teamRole: a.teamRole ?? null,
    })),
    areas: NAVIGATION_AREAS.map((id) => ({ id, visible: visible.has(id), actionIds: [] })),
    capabilities: CAPABILITY_IDS.map((id) => ({
      id,
      enabled: enabled.has(id),
      enforcement: RECORDED_ONLY.has(id) ? 'recorded_only' : 'commands',
    })),
  } as MePermissions;
}

/** The ACCESS_DENIED body a gated command answers while its capability is turned off (K-12). */
export function capabilityDisabledBody(capability: CapabilityId, decisions?: readonly string[]) {
  return apiErrorBody('ACCESS_DENIED', {
    message: `This organization has not enabled ${capability.replaceAll('_', ' ')}.`,
    nextAction: 'contact_support_or_request_access',
    details: {
      code: 'CAPABILITY_DISABLED',
      capability,
      applicabilityReferences: [...(decisions ?? ['DEC-016'])],
    },
  });
}
