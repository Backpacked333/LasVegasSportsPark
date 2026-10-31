import { ErrorCodes } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, networkError, timeoutError } from '../errors';
import { formatClientInfo, parseClientInfo } from '../client-info';
import { apiQueryKey, formatAge, isStale, isTerminalOperationStatus } from '../freshness';
import {
  CommandIntentTracker,
  createCommandIntent,
  defaultKeyGenerator,
  keepsIntentAfter,
  stableStringify,
} from '../idempotency';
import { RECOVERY_ACTION_LABELS, presentationForError, recoveryActionFor } from '../screen-state';
import { MemorySessionStore, parseStoredSession } from '../session';

describe('idempotency keys (§4.9)', () => {
  it('generates distinct keys the API accepts (8 to 128 characters)', () => {
    const a = createCommandIntent();
    const b = createCommandIntent();
    expect(a.key).not.toBe(b.key);
    expect(a.key.length).toBeGreaterThanOrEqual(8);
    expect(a.key.length).toBeLessThanOrEqual(128);
    expect(Object.isFrozen(a)).toBe(true);
    expect(typeof defaultKeyGenerator()).toBe('string');
  });

  it('rejects keys outside the accepted length', () => {
    expect(() => createCommandIntent(() => 'short')).toThrow(/8 to 128/);
    expect(() => createCommandIntent(() => 'x'.repeat(129))).toThrow(/8 to 128/);
  });

  it('fingerprints input independently of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
    const tracker = new CommandIntentTracker(() => 'fixed-key-123');
    expect(tracker.current().key).toBe('fixed-key-123');
  });
});

function apiError(code: string, status = 409): ApiError {
  return new ApiError({
    kind: 'api',
    status,
    code,
    message: code,
    nextAction: (ErrorCodes as Record<string, { nextAction: string }>)[code]?.nextAction ?? 'x',
    correlationId: 'corr-1',
  });
}

describe('intent after a failed attempt (§4.9, the API replays stored 4xx answers)', () => {
  it('a definitive refusal ends the intent: the next attempt of the same input gets a new key', () => {
    let n = 0;
    const tracker = new CommandIntentTracker(() => `key-${String(++n).padStart(4, '0')}`);
    const input = { expectedRevision: 3 };
    const first = tracker.current(input).key;
    tracker.failed(apiError('MISSING_ACKNOWLEDGMENT', 422));
    expect(tracker.current(input).key).not.toBe(first);
  });

  it.each([
    'MISSING_ACKNOWLEDGMENT',
    'STALE_REVISION',
    'INVALID_TRANSITION',
    'CAPACITY_UNAVAILABLE',
    'ELIGIBILITY_FAILED',
    'ACCESS_DENIED',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
  ])('%s is definitive and does not keep the key', (code) => {
    expect(apiError(code).keepsIntent).toBe(false);
    expect(keepsIntentAfter(apiError(code))).toBe(false);
  });

  it('an unknown outcome or a retryable answer keeps the key for the retry', () => {
    let n = 0;
    const tracker = new CommandIntentTracker(() => `key-${String(++n).padStart(4, '0')}`);
    const first = tracker.current({ a: 1 }).key;
    for (const error of [
      timeoutError(20_000),
      networkError(new Error('reset')),
      apiError('IDEMPOTENCY_IN_PROGRESS'),
      apiError('PAYMENT_OUTCOME_UNKNOWN'),
      apiError('INTEGRATION_UNAVAILABLE', 503),
      apiError('RATE_LIMITED', 429),
      apiError('INTERNAL_ERROR', 500),
      new Error('not a client error'),
    ]) {
      tracker.failed(error);
      expect(tracker.current({ a: 1 }).key).toBe(first);
    }
  });

  it('IDEMPOTENCY_OUTCOME_UNAVAILABLE asks for a reload, not a retry', () => {
    const error = apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE');
    expect(error.isStale).toBe(true);
    expect(recoveryActionFor(error)).toMatchObject({ label: 'Reload', retry: false });
  });
});

describe('client identification (§4.13)', () => {
  it('round-trips the header value and refuses unsafe versions', () => {
    const value = formatClientInfo({ app: 'staff', platform: 'web', version: '1.2.3-rc.1' });
    expect(value).toBe('sportspark-staff/1.2.3-rc.1 (web)');
    expect(parseClientInfo(value)).toEqual({
      app: 'staff',
      platform: 'web',
      version: '1.2.3-rc.1',
    });
    expect(parseClientInfo('curl/8')).toBeNull();
    expect(() => formatClientInfo({ app: 'mobile', platform: 'ios', version: '1 (x)' })).toThrow();
  });
});

describe('sessions (§4.13)', () => {
  it('treats corrupt stored values as no session', async () => {
    expect(parseStoredSession(null)).toBeNull();
    expect(parseStoredSession('not json')).toBeNull();
    expect(parseStoredSession('{"token":""}')).toBeNull();
    expect(parseStoredSession('{"token":"t","expiresAt":5}')).toEqual({
      token: 't',
      expiresAt: null,
      accountId: null,
    });
    const store = new MemorySessionStore();
    await store.save({ token: 't', expiresAt: null, accountId: null });
    expect(await store.load()).toMatchObject({ token: 't' });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe('freshness (§4.15, SPK-UX-008)', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  it('describes data age in words', () => {
    expect(formatAge(new Date('2026-10-24T11:59:40Z'), now)).toBe('just now');
    expect(formatAge(new Date('2026-10-24T11:59:00Z'), now)).toBe('1 minute ago');
    expect(formatAge(new Date('2026-10-24T11:15:00Z'), now)).toBe('45 minutes ago');
    expect(formatAge(new Date('2026-10-24T09:00:00Z'), now)).toBe('3 hours ago');
    expect(formatAge(new Date('2026-10-22T12:00:00Z'), now)).toBe('2 days ago');
    expect(isStale(new Date('2026-10-24T11:00:00Z'), now, 30 * 60_000)).toBe(true);
    expect(isStale(new Date('2026-10-24T11:50:00Z'), now, 30 * 60_000)).toBe(false);
  });

  it('knows which operation statuses are terminal and builds stable query keys', () => {
    expect(isTerminalOperationStatus('running')).toBe(false);
    expect(isTerminalOperationStatus('recovery_required')).toBe(true);
    expect(apiQueryKey('/operations/{id}', { path: { id: 'x' } })).toEqual([
      'api',
      '/operations/{id}',
      { id: 'x' },
      null,
    ]);
  });
});

describe('error presentation (SPK-UX-008, §4.10)', () => {
  const apiError = (code: string, nextAction: string, kind: ApiError['kind'] = 'api') =>
    new ApiError({ kind, status: 409, code, message: 'm', nextAction, correlationId: 'c' });

  it('maps protected not-found and permission restrictions to "unavailable", never to an error', () => {
    expect(presentationForError(apiError('NOT_FOUND', 'verify_reference'))).toBe('unavailable');
    expect(presentationForError(apiError('ACCESS_DENIED', 'x'))).toBe('unavailable');
    expect(presentationForError(apiError('PARTICIPANT_AUTHORITY_REQUIRED', 'x'))).toBe(
      'unavailable',
    );
    expect(presentationForError(apiError('NETWORK_UNAVAILABLE', 'x', 'network'))).toBe('offline');
    expect(presentationForError(apiError('AUTHENTICATION_REQUIRED', 'authenticate'))).toBe(
      'session_expired',
    );
    expect(presentationForError(apiError('STALE_REVISION', 'reload_and_retry'))).toBe('error');
    expect(presentationForError(new Error('boom'))).toBe('error');
  });

  it('labels every next action in packages/contracts ErrorCodes', () => {
    for (const { nextAction } of Object.values(ErrorCodes)) {
      expect(Object.keys(RECOVERY_ACTION_LABELS), nextAction).toContain(nextAction);
      expect(recoveryActionFor(apiError('X', nextAction)).nextAction).toBe(nextAction);
    }
    expect(recoveryActionFor(apiError('PAYMENT_OUTCOME_UNKNOWN', 'await_reconciliation'))).toEqual({
      nextAction: 'await_reconciliation',
      label: 'Do not pay again. The outcome is being confirmed.',
      retry: false,
    });
  });
});
