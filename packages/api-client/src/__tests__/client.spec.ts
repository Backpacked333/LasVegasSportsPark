import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createApiClient, type ApiClientOptions } from '../client';
import { CLIENT_INFO_HEADER } from '../client-info';
import { ApiError, UpdateRequiredError } from '../errors';
import { MemorySessionStore } from '../session';
import { fakeFetch, jsonResponse, sequentialKeys, type Responder } from './fake-fetch';

const ASSIGNMENT_ID = '0192f1a0-0000-7000-8000-000000000001';
const FIXED_NOW = new Date('2026-10-24T12:00:00.000Z');

function setup(responder: Responder, overrides: Partial<ApiClientOptions> = {}) {
  const fetch = fakeFetch(responder);
  const session = new MemorySessionStore({
    token: 'token-abc',
    expiresAt: null,
    accountId: '0192f1a0-0000-7000-8000-0000000000aa',
  });
  const api = createApiClient({
    baseUrl: 'http://api.test/v1/',
    session,
    clientInfo: { app: 'mobile', platform: 'ios', version: '0.1.0' },
    fetch,
    generateKey: sequentialKeys(),
    now: () => FIXED_NOW,
    ...overrides,
  });
  return { api, fetch, session };
}

const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code,
  message: `safe message for ${code}`,
  correlationId: 'corr-1',
  nextAction: 'next',
  ...extra,
});

describe('createApiClient (§4.8 to §4.10, §4.13)', () => {
  it('attaches the bearer token from the injected session store, and none without a session', async () => {
    const { api, fetch, session } = setup(() => jsonResponse(200, { status: 'ok' }));
    await api.get('/health');
    expect(fetch.requests[0]?.headers.authorization).toBe('Bearer token-abc');

    await session.clear();
    await api.get('/health');
    expect(fetch.requests[1]?.headers.authorization).toBeUndefined();
  });

  it('identifies app, platform and version on every request (§4.13, SPK-AT-027)', async () => {
    const { api, fetch } = setup(() => jsonResponse(200, {}));
    await api.get('/health');
    expect(fetch.requests[0]?.headers[CLIENT_INFO_HEADER.toLowerCase()]).toBe(
      'sportspark-mobile/0.1.0 (ios)',
    );
    expect(fetch.requests[0]?.headers.accept).toBe('application/json');
  });

  it('substitutes and encodes path parameters, serializes the query and joins the base URL', async () => {
    const { api, fetch } = setup(() => jsonResponse(200, { evaluatedAt: 'x', items: [] }));
    await api.get('/me/assignments', { query: { status: 'offered', from: undefined } });
    expect(fetch.requests[0]?.url).toBe('http://api.test/v1/me/assignments?status=offered');

    expect(buildUrl('/v1', '/fixtures/{id}/readiness', { id: 'a/b c' })).toBe(
      '/v1/fixtures/a%2Fb%20c/readiness',
    );
    expect(() => buildUrl('/v1', '/fixtures/{id}', {})).toThrow(/Missing path parameter "id"/);
  });

  it('sends the intent key as Idempotency-Key and reuses it when the same intent is retried (§4.9)', async () => {
    let calls = 0;
    const { api, fetch } = setup(() => {
      calls += 1;
      if (calls === 1) throw new TypeError('Network request failed');
      return jsonResponse(200, { ok: true }, { 'Idempotent-Replayed': 'true' });
    });
    const intent = api.newIntent();
    const first = await api
      .post('/assignments/{id}/accept', {
        path: { id: ASSIGNMENT_ID },
        body: { expectedRevision: 3 },
        intent,
      })
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ApiError);
    expect((first as ApiError).code).toBe('NETWORK_UNAVAILABLE');
    expect((first as ApiError).retryable).toBe(true);

    const retried = await api.request('post', '/assignments/{id}/accept', {
      path: { id: ASSIGNMENT_ID },
      body: { expectedRevision: 3 },
      intent,
    });
    expect(retried.replayed).toBe(true);
    expect(retried.receivedAt).toEqual(FIXED_NOW);
    expect(fetch.requests.map((r) => r.headers['idempotency-key'])).toEqual([
      'key-00000001',
      'key-00000001',
    ]);
    expect(fetch.requests[1]?.body).toEqual({ expectedRevision: 3 });
    expect(fetch.requests[1]?.headers['content-type']).toBe('application/json');

    await api.post('/assignments/{id}/accept', {
      path: { id: ASSIGNMENT_ID },
      body: { expectedRevision: 4 },
      intent: api.newIntent(),
    });
    expect(fetch.requests[2]?.headers['idempotency-key']).toBe('key-00000002');
  });

  it('keeps one intent per unchanged input and starts a new one when the input changes or completes', () => {
    const { api } = setup(() => jsonResponse(200, {}));
    const tracker = api.intentTracker();
    const a = tracker.current({ id: 1, reason: 'late' });
    expect(tracker.current({ reason: 'late', id: 1 })).toBe(a);
    const b = tracker.current({ id: 1, reason: 'injured' });
    expect(b.key).not.toBe(a.key);
    tracker.complete();
    expect(tracker.current({ id: 1, reason: 'injured' }).key).not.toBe(b.key);
  });

  it('refuses a command without an intent at runtime as well as at compile time', async () => {
    const { api, fetch } = setup(() => jsonResponse(200, {}));
    await expect(
      // @ts-expect-error a command must carry a CommandIntent
      api.post('/assignments/{id}/accept', { path: { id: ASSIGNMENT_ID } }),
    ).rejects.toThrow(/needs a CommandIntent/);
    expect(fetch.requests).toHaveLength(0);
  });

  it('parses the §4.10 error body into a typed ApiError', async () => {
    const { api } = setup(() =>
      jsonResponse(
        409,
        errorBody('STALE_REVISION', { details: { expectedRevision: 3, currentRevision: 4 } }),
      ),
    );
    const error = (await api
      .post('/assignments/{id}/accept', {
        path: { id: ASSIGNMENT_ID },
        body: { expectedRevision: 3 },
        intent: api.newIntent(),
      })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'api',
      status: 409,
      code: 'STALE_REVISION',
      message: 'safe message for STALE_REVISION',
      nextAction: 'next',
      correlationId: 'corr-1',
      details: { expectedRevision: 3, currentRevision: 4 },
    });
    expect(error.isStale).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it.each([
    ['NOT_FOUND', 404, { isNotFound: true, retryable: false }],
    ['ACCESS_DENIED', 403, { isPermissionRestriction: true, retryable: false }],
    ['PARTICIPANT_AUTHORITY_REQUIRED', 403, { isPermissionRestriction: true }],
    ['IDEMPOTENCY_IN_PROGRESS', 409, { retryable: true }],
    ['INTEGRATION_UNAVAILABLE', 503, { retryable: true }],
    ['RATE_LIMITED', 429, { retryable: true }],
    ['PAYMENT_OUTCOME_UNKNOWN', 409, { retryable: false, outcomeUnknown: true }],
  ] as const)('classifies %s', async (code, status, expected) => {
    const { api } = setup(() => jsonResponse(status, errorBody(code)));
    const error = (await api.get('/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe(code);
    expect(error).toMatchObject(expected);
  });

  it('surfaces the proposed update-required answer as UpdateRequiredError (DEC-061, DEC-092)', async () => {
    const onUpdateRequired = vi.fn();
    const { api } = setup(
      () =>
        jsonResponse(
          426,
          errorBody('CLIENT_UPDATE_REQUIRED', { details: { minimumVersion: '0.2.0' } }),
        ),
      { onUpdateRequired },
    );
    const error = await api.get('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateRequiredError);
    expect((error as UpdateRequiredError).minimumVersion).toBe('0.2.0');
    expect((error as UpdateRequiredError).kind).toBe('update_required');
    expect(onUpdateRequired).toHaveBeenCalledTimes(1);

    const bare = setup(() => new Response('Upgrade Required', { status: 426 }));
    const bareError = await bare.api.get('/me').catch((e: unknown) => e);
    expect(bareError).toBeInstanceOf(UpdateRequiredError);
    expect((bareError as UpdateRequiredError).minimumVersion).toBeNull();
  });

  it('reports an expired or revoked session through onAuthenticationRequired', async () => {
    const onAuthenticationRequired = vi.fn();
    const { api } = setup(() => jsonResponse(401, errorBody('AUTHENTICATION_REQUIRED')), {
      onAuthenticationRequired,
    });
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(onAuthenticationRequired).toHaveBeenCalledTimes(1);
  });

  it('turns a timeout into TIMEOUT with an unknown outcome, retryable with the same key', async () => {
    const { api } = setup(
      (_req, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 5 },
    );
    const error = (await api
      .post('/assignments/{id}/accept', {
        path: { id: ASSIGNMENT_ID },
        intent: api.newIntent(),
      })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.kind).toBe('timeout');
    expect(error.outcomeUnknown).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.isOffline).toBe(true);
  });

  it('lets a caller abort pass through untouched (screen left, query cancelled)', async () => {
    const abortError = new Error('The operation was aborted');
    let started: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const { api, fetch } = setup(
      (_req, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError));
          started();
        }),
    );
    const inFlight = new AbortController();
    const pending = api.get('/me', { signal: inFlight.signal });
    await fetchStarted;
    inFlight.abort();
    await expect(pending).rejects.toBe(abortError);

    const before = new AbortController();
    const reason = new Error('left the screen');
    before.abort(reason);
    await expect(api.get('/me', { signal: before.signal })).rejects.toBe(reason);
    expect(fetch.requests).toHaveLength(1);
  });

  it('treats a non-contract 5xx (gateway) as a retryable INTERNAL_ERROR and keeps the correlation header', async () => {
    const { api } = setup(
      () =>
        new Response('<html>Bad gateway</html>', {
          status: 502,
          headers: { 'X-Correlation-Id': 'corr-gw' },
        }),
    );
    const error = (await api.get('/me').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({
      kind: 'unexpected_response',
      code: 'INTERNAL_ERROR',
      status: 502,
      correlationId: 'corr-gw',
    });
    expect(error.retryable).toBe(true);
  });

  it('returns typed data and the correlation id of a successful response', async () => {
    const { api } = setup(() =>
      jsonResponse(
        200,
        { status: 'ok', version: '0.1.0', database: 'ok' },
        { 'X-Correlation-Id': 'corr-ok' },
      ),
    );
    const response = await api.request('get', '/health');
    expect(response).toMatchObject({ status: 200, correlationId: 'corr-ok', replayed: false });
    const health = await api.get('/health');
    expect(health.status).toBe('ok');
  });
});

describe('compile-time contract (type-only assertions, checked by tsc)', () => {
  it('rejects paths, methods and parameters that the OpenAPI document does not define', () => {
    const { api } = setup(() => jsonResponse(200, {}));
    const typeOnly = () => {
      // @ts-expect-error unknown path
      void api.get('/not-a-real-path');
      // @ts-expect-error the path needs its id
      void api.get('/operations/{id}');
      // @ts-expect-error GET does not take an intent
      void api.get('/me', { intent: api.newIntent() });
      void api.get('/operations/{id}', { path: { id: ASSIGNMENT_ID } });
    };
    expect(typeof typeOnly).toBe('function');
  });
});
