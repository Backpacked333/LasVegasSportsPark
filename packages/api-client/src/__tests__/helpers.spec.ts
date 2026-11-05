import { ErrorCodes, NEXT_ACTIONS } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError, networkError, timeoutError } from '../errors';
import { formatClientInfo, parseClientInfo } from '../client-info';
import { apiQueryKey, formatAge, isStale, isTerminalOperationStatus } from '../freshness';
import {
  CommandIntentTracker,
  createCommandIntent,
  defaultKeyGenerator,
  keepsIntentAfter,
  keepsIntentAfterFailure,
  stableStringify,
} from '../idempotency';
import {
  mayHaveTakenEffect,
  mustNotCreateAgain,
  outcomeStillOpen,
  refusedBeforeRunning,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../outcome';
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

  it('§4.9: IDEMPOTENCY_OUTCOME_UNAVAILABLE keeps the key, so an unchanged resubmission never runs the command a second time', () => {
    let n = 0;
    const tracker = new CommandIntentTracker(() => `key-${String(++n).padStart(4, '0')}`);
    const input = { amountMinor: 2500, reason: 'goodwill' };
    const first = tracker.current(input).key;
    const error = apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE');
    expect(keepsIntentAfterFailure(error)).toBe(true);
    tracker.failed(error);
    expect(tracker.current(input).key).toBe(first);
    // Every other definitive answer still ends the intent.
    expect(keepsIntentAfterFailure(apiError('STALE_REVISION'))).toBe(false);
    expect(keepsIntentAfterFailure(timeoutError(1000))).toBe(true);
    expect(keepsIntentAfterFailure(new Error('not a client error'))).toBe(true);
  });
});

describe('what a failure says about the effect (§4.9, SPK-PAY-007, SPK-UX-008)', () => {
  it('SPK-PAY-007: a connection lost after sending may have taken effect, like a timeout, a 5xx or the same key still running', () => {
    for (const error of [
      networkError(new TypeError('Failed to fetch')),
      timeoutError(20_000),
      apiError('IDEMPOTENCY_IN_PROGRESS'),
      apiError('INTERNAL_ERROR', 500),
      apiError('INTEGRATION_UNAVAILABLE', 503),
      apiError('PAYMENT_OUTCOME_UNKNOWN'),
    ]) {
      expect(mayHaveTakenEffect(error), error.code).toBe(true);
    }
    for (const code of ['STALE_REVISION', 'VALIDATION_FAILED', 'ACCESS_DENIED', 'RATE_LIMITED']) {
      expect(mayHaveTakenEffect(apiError(code, code === 'RATE_LIMITED' ? 429 : 409)), code).toBe(
        false,
      );
    }
    // Committed under the key but the answer was lost: not "may have", it did; reload instead.
    expect(mayHaveTakenEffect(apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE'))).toBe(false);
    expect(tookEffectOutcomeLost(apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE'))).toBe(true);
  });

  it('SPK-AT-028, SPK-AUTO-005: a guard refusal before the key is claimed (recovery_mode, disabled) changed nothing and does not lock the form', () => {
    const refusal = (reason: string) =>
      new ApiError({
        kind: 'api',
        status: 503,
        code: 'INTEGRATION_UNAVAILABLE',
        message: 'Payments are paused while the service recovers from a restore. Try again later.',
        nextAction: 'retry_later',
        correlationId: 'corr-r',
        details: { reason },
      });
    for (const reason of ['recovery_mode', 'disabled']) {
      const error = refusal(reason);
      expect(refusedBeforeRunning(error), reason).toBe(true);
      expect(mayHaveTakenEffect(error), reason).toBe(false);
      expect(outcomeStillOpen(error), reason).toBe(false);
      // The guard claimed no key: the same key may be sent again later.
      expect(error.keepsIntent, reason).toBe(true);
    }
    // A provider that did not answer inside a command may still have let part of it commit.
    const provider = refusal('provider_timeout');
    expect(refusedBeforeRunning(provider)).toBe(false);
    expect(mayHaveTakenEffect(provider)).toBe(true);
    expect(outcomeStillOpen(provider)).toBe(true);
    expect(refusedBeforeRunning(apiError('INTEGRATION_UNAVAILABLE', 503))).toBe(false);
  });

  it('SPK-PAY-007: a success status whose answer could not be read may have taken effect and keeps the key', () => {
    const error = new ApiError({
      kind: 'unexpected_response',
      status: 201,
      code: 'RESPONSE_UNREADABLE',
      message: 'The service answered, but its answer could not be read.',
      nextAction: 'retry_with_same_key',
      correlationId: null,
    });
    error.method = 'post';
    expect(mayHaveTakenEffect(error)).toBe(true);
    expect(error.keepsIntent).toBe(true);
    expect(outcomeStillOpen(error)).toBe(true);
    expect(recoveryActionFor(error)).toMatchObject({ retry: true });
  });

  it('§4.14: IDEMPOTENCY_SECRET_WITHHELD names the record that was created', () => {
    const withheld = new ApiError({
      kind: 'api',
      status: 409,
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      message: 'm',
      nextAction: 'revoke_and_reissue',
      correlationId: 'c',
      details: { resourceId: 'export-1' },
    });
    expect(secretWithheldOf(withheld)).toEqual({ resourceId: 'export-1' });
    expect(secretWithheldOf(apiError('STALE_REVISION'))).toBeNull();
    expect(mustNotCreateAgain(withheld)).toBe(true);
    expect(mustNotCreateAgain(apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE'))).toBe(true);
    expect(mustNotCreateAgain(apiError('VALIDATION_FAILED', 400))).toBe(false);
    expect(mustNotCreateAgain(null)).toBe(false);
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

  it('K-11, §5.6: a legacy-authority refusal is not a permission restriction of the principal', () => {
    const legacy = new ApiError({
      kind: 'api',
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'The legacy system is still authoritative for enrollment records.',
      nextAction: 'write_in_authoritative_system',
      correlationId: 'c',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'enrollment', basis: 'assignment' },
    });
    expect(legacy.isLegacyAuthority).toBe(true);
    expect(legacy.isPermissionRestriction).toBe(false);
    expect(legacy.retryable).toBe(false);
    expect(legacy.keepsIntent).toBe(false);
    expect(presentationForError(legacy)).toBe('error');
    expect(recoveryActionFor(legacy).label).toBe('Make this change in the system of record');
    // A plain ACCESS_DENIED stays a permission restriction.
    expect(apiError('ACCESS_DENIED', 'contact_support_or_request_access').isLegacyAuthority).toBe(
      false,
    );
  });

  it('labels every next action the API can send (packages/contracts NEXT_ACTIONS, §4.10)', () => {
    for (const { nextAction } of Object.values(ErrorCodes)) {
      expect(NEXT_ACTIONS, nextAction).toContain(nextAction);
    }
    for (const nextAction of NEXT_ACTIONS) {
      expect(Object.keys(RECOVERY_ACTION_LABELS), nextAction).toContain(nextAction);
      expect(recoveryActionFor(apiError('X', nextAction)).nextAction).toBe(nextAction);
    }
    expect(
      recoveryActionFor(apiError('ACCESS_DENIED', 'write_in_authoritative_system')),
    ).toMatchObject({ label: 'Make this change in the system of record', retry: false });
    expect(recoveryActionFor(apiError('PAYMENT_OUTCOME_UNKNOWN', 'await_reconciliation'))).toEqual({
      nextAction: 'await_reconciliation',
      label: 'Do not pay again. The outcome is being confirmed.',
      retry: false,
    });
  });
});
