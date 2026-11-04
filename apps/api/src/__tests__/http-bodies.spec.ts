import { Logger } from '@nestjs/common';
import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nestingDepthExceeds } from '../kernel/http/body-depth.middleware';
import { canonicalHash, canonicalize } from '../kernel/http/idempotency.interceptor';
import { CatalogModule } from '../modules/catalog/catalog.module';
import { EntryModule } from '../modules/entry/entry.module';
import { IdentityModule } from '../modules/identity/identity.module';
import {
  authHeaderForPerson,
  createStaffMemberFixture,
} from '../modules/identity/testing/identity-fixtures';
import { createTestApp, type TestApp } from '../testing/test-app';

const key = () => `k-${newId()}`;

/** The recursive canonical form the interceptor used before R3-SECURITY-03 (reference). */
function recursiveCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(recursiveCanonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${recursiveCanonical(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * A contract-maximum offline batch (`OfflineSyncBody`, §4.15): 500 release items, the widest item
 * kind, with every bounded string at its maximum length and made of characters JSON must escape,
 * plus the command meta at its maximum. This is the largest body the published contract admits.
 */
function maximalOfflineBatch(facilityId: string) {
  const escaped = (length: number) => '\u0001'.repeat(length);
  const items = Array.from({ length: 500 }, () => ({
    kind: 'release',
    clientObservationId: newId(),
    observedAt: '2026-10-23T11:00:00.000Z',
    childPersonId: newId(),
    collector: { description: `x${escaped(199)}` },
    activity: { type: 'session', offeringId: newId(), sessionId: newId() },
    manualProcedureReference: `x${escaped(199)}`,
  }));
  return {
    deviceId: `d${escaped(199)}`,
    clientBatchId: newId(),
    facilityId,
    snapshot: { reference: `s${escaped(199)}`, takenAt: '2026-10-23T10:59:00.000Z' },
    items,
    reason: escaped(2000),
    policyReferences: Array.from({ length: 20 }, () => `p${escaped(199)}`),
  };
}

describe('HTTP request bodies (R3-SECURITY-02, R3-SECURITY-03, R3-SECURITY-04, §4.10, §4.15)', () => {
  let t: TestApp;
  let header: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule, CatalogModule, EntryModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    header = await authHeaderForPerson(t, staff.personId);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('R3-SECURITY-02 / §4.15: a contract-maximum offline batch is read and answered by the API, not refused for its size', async () => {
    const body = maximalOfflineBatch(t.facilityId);
    const bytes = Buffer.byteLength(JSON.stringify(body));
    // Far beyond the framework's former 100 KB default, within HTTP_BODY_LIMIT_BYTES.
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bytes).toBeLessThan(t.config.HTTP_BODY_LIMIT_BYTES);
    const res = await t.http
      .post('/v1/offline-sync')
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(res.status).toBeLessThan(500);
    expect(res.body?.details?.code).not.toBe('body_too_large');
    expect(res.status).toBe(201);
  }, 120_000);

  it('R3-SECURITY-02 / §4.10: a body over the limit answers 400 VALIDATION_FAILED body_too_large with the limit (correct_input, never a 5xx to retry), also before authentication', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const huge = { padding: 'x'.repeat(t.config.HTTP_BODY_LIMIT_BYTES + 10) };
      const anonymous = await t.http.post('/v1/offline-sync').send(huge);
      expect(anonymous.status).toBe(400);
      expect(anonymous.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        nextAction: 'correct_input',
        details: { code: 'body_too_large', limitBytes: t.config.HTTP_BODY_LIMIT_BYTES },
      });
      expect(anonymous.body.correlationId).toEqual(anonymous.headers['x-correlation-id']);
      const signedIn = await t.http
        .post('/v1/offline-sync')
        .set(header)
        .set('Idempotency-Key', key())
        .send(huge);
      expect(signedIn.status).toBe(400);
      expect(signedIn.body.details).toMatchObject({ code: 'body_too_large' });
      // R3-SECURITY-03: refused at warn, never logged as an unhandled fault.
      expect(error).not.toHaveBeenCalled();
      expect(warn.mock.calls.some(([m]) => String(m).includes('entity.too.large'))).toBe(true);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('R3-SECURITY-03 / §4.10: a body in an unsupported charset answers 400 unsupported_charset, not 500', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await t.http
        .post('/v1/offline-sync')
        .set(header)
        .set('Idempotency-Key', key())
        .set('Content-Type', 'application/json; charset=latin1')
        .send(JSON.stringify({ deviceId: 'd' }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        nextAction: 'correct_input',
        details: { code: 'unsupported_charset' },
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('R3-SECURITY-03 / §4.10: a body nested deeper than HTTP_BODY_MAX_DEPTH answers 400 VALIDATION_FAILED body_too_deep (correct_input), also before authentication, never 500', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // About 40 KB: written out as text, since serializing it would exhaust the test's own stack.
      const deep = `${'['.repeat(20_000)}1${']'.repeat(20_000)}`;
      const body = `{"kind":"adult","givenName":"Pat","familyName":"Doe","dateOfBirth":"1990-01-01","extra":${deep}}`;
      for (const res of [
        await t.http
          .post('/v1/people')
          .set(header)
          .set('Idempotency-Key', key())
          .set('Content-Type', 'application/json')
          .send(body),
        await t.http.post('/v1/people').set('Content-Type', 'application/json').send(body),
      ]) {
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          nextAction: 'correct_input',
          details: { code: 'body_too_deep', limitDepth: t.config.HTTP_BODY_MAX_DEPTH },
        });
        expect(res.body.correlationId).toEqual(res.headers['x-correlation-id']);
      }
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('R3-SECURITY-03 / §4.10: a deep value in an open record field (POST /v1/policy-versions content) answers 400 body_too_deep instead of overflowing JSON.stringify into a 500; a body within the limit is accepted', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
      const pm = await authHeaderForPerson(t, manager.personId);
      const policy = (depth: number) => {
        const deep = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
        return `{"kind":"eligibility","key":"elig-${newId().slice(-8)}","title":"Deep","content":{"x":${deep}},"effectiveFrom":"2026-10-01T00:00:00Z"}`;
      };
      const send = (depth: number) =>
        t.http
          .post('/v1/policy-versions')
          .set(pm)
          .set('Idempotency-Key', key())
          .set('Content-Type', 'application/json')
          .send(policy(depth));
      // The body object and `content` take two levels; the arrays the rest. At the limit exactly:
      const within = await send(t.config.HTTP_BODY_MAX_DEPTH - 2);
      expect(within.status).toBe(201);
      for (const depth of [t.config.HTTP_BODY_MAX_DEPTH - 1, 20_000]) {
        const refused = await send(depth);
        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          nextAction: 'correct_input',
          details: { code: 'body_too_deep' },
        });
      }
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('R3-SECURITY-03: the depth check counts nested objects and arrays and never recurses', () => {
    expect(nestingDepthExceeds(null, 1)).toBe(false);
    expect(nestingDepthExceeds('text', 1)).toBe(false);
    expect(nestingDepthExceeds({}, 1)).toBe(false);
    expect(nestingDepthExceeds({ a: [] }, 1)).toBe(true);
    expect(nestingDepthExceeds({ a: [1, 2], b: { c: 'x' } }, 2)).toBe(false);
    expect(nestingDepthExceeds({ a: [1, [2]] }, 2)).toBe(true);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(nestingDepthExceeds(deep, 64)).toBe(true);
    expect(nestingDepthExceeds(deep, 100_000)).toBe(false);
  });

  it('R3-SECURITY-03: the iterative canonical form equals the earlier recursive one, so stored request hashes keep matching', () => {
    const samples: unknown[] = [
      null,
      0,
      -1.5,
      'text "quoted" \n',
      true,
      [],
      {},
      [1, [2, [3, null]], { b: 1, a: [true, false] }],
      { z: 1, a: { y: [1, 2, { c: undefined, d: 'x' }], x: null }, m: [], e: {} },
      {
        method: 'POST',
        path: '/v1/people',
        body: { kind: 'adult', tags: ['a', 'b'], n: { k: 1 } },
      },
      [undefined, 1],
    ];
    for (const sample of samples) {
      expect(canonicalize(sample)).toBe(recursiveCanonical(sample));
    }
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 50_000; i += 1) deep = { n: deep };
    expect(canonicalize(deep).length).toBeGreaterThan(50_000);
  });

  it('R3-SECURITY-04 / §4.14: an authenticated answer is no-store and nosniff and does not name the framework', async () => {
    const res = await t.http.get('/v1/me/permissions').set(header);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    const refused = await t.http.get('/v1/me/permissions');
    expect(refused.status).toBe(401);
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.headers['x-powered-by']).toBeUndefined();
  });
});
