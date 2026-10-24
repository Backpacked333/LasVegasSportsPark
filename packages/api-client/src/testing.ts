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
import type { FetchLike } from './client';
import type { ErrorCode } from './errors';

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
