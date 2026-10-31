import { Logger } from '@nestjs/common';
import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalHash, canonicalize } from '../kernel/http/idempotency.interceptor';
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
      imports: [IdentityModule, EntryModule],
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

  it('R3-SECURITY-03 / §4.10: a deeply nested body on an @Idempotent command is hashed and validated like any other (the unknown field is dropped), never answered 500 from hashing', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      // About 40 KB: written out as text, since serializing it would exhaust the test's own stack.
      const deep = `${'['.repeat(20_000)}1${']'.repeat(20_000)}`;
      const res = await t.http
        .post('/v1/people')
        .set(header)
        .set('Idempotency-Key', key())
        .set('Content-Type', 'application/json')
        .send(
          `{"kind":"adult","givenName":"Pat","familyName":"Doe","dateOfBirth":"1990-01-01","extra":${deep}}`,
        );
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('extra');
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
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
