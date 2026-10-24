import { describe, expect, it } from 'vitest';
import { createApiClient } from '../client';
import type { ApiError } from '../errors';
import { MemorySessionStore } from '../session';
import { apiErrorBody, createFakeFetch, fakeResponse, sequentialKeys } from '../testing';

describe('@sportspark/api-client/testing', () => {
  it('routes by method and template, records requests, and answers unmatched requests NOT_FOUND', async () => {
    const fake = createFakeFetch({
      'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
      'POST /assignments/{id}/accept': (req) =>
        fakeResponse(409, apiErrorBody('STALE_REVISION', { details: { id: req.params.id } })),
    });
    const api = createApiClient({
      baseUrl: 'http://api.test/v1',
      session: new MemorySessionStore(),
      clientInfo: { app: 'staff', platform: 'web', version: '0.1.0' },
      fetch: fake.fetch,
      generateKey: sequentialKeys(),
    });
    expect(await api.get('/me/inbox', { query: { limit: 5 } })).toEqual({
      items: [],
      nextCursor: null,
    });
    const error = (await api
      .post('/assignments/{id}/accept', { path: { id: 'a1' }, intent: api.newIntent() })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('STALE_REVISION');
    expect(error.details).toEqual({ id: 'a1' });
    await expect(api.get('/me')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(fake.requests.map((r) => [r.method, r.route, r.query])).toEqual([
      ['GET', '/me/inbox', { limit: '5' }],
      ['POST', '/assignments/{id}/accept', {}],
      ['GET', null, {}],
    ]);
    expect(fake.requests[1]?.headers['idempotency-key']).toBe('key-00000001');
  });
});
