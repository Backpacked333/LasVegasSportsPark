/**
 * The customer app decides what a command's failure says about its effect with the shared
 * predicates of `@sportspark/api-client`, the same ones the staff dashboard uses (§4.9, §4.10,
 * SPK-PAY-007, SPK-UX-008, SPK-AT-028, R4-CLIENTS-A11Y-COPY-01): a success status whose answer could
 * not be read (RESPONSE_UNREADABLE) may have taken effect, a refusal before running (503
 * INTEGRATION_UNAVAILABLE `recovery_mode`) did not, and a failed read changed nothing.
 */
import * as shared from '@sportspark/api-client';
import { ApiError } from '@sportspark/api-client';
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { CommandFailure as MoneyCommandFailure } from '../../features/money/CommandFailure';
import { CommandError } from '../../screens/account/components/CommandError';
import { createTestApp } from '../../testing/test-app';
import * as outcome from '../command-outcome';
import { useApiCommand } from '../useApiCommand';

const PAUSED = 'Payments are paused while the service recovers from a restore. Try again later.';

function noAnswer(): ApiError {
  const error = new ApiError({
    kind: 'network',
    status: null,
    code: 'NETWORK_UNAVAILABLE',
    message: 'No connection.',
    nextAction: 'retry_with_same_key',
    correlationId: null,
  });
  error.method = 'post';
  return error;
}

function refused(code: string, status: number): ApiError {
  const error = new ApiError({
    kind: 'api',
    status,
    code,
    message: 'Refused.',
    nextAction: 'review_and_correct',
    correlationId: null,
  });
  error.method = 'post';
  return error;
}

function unreadable(method: string | null = 'post'): ApiError {
  const error = new ApiError({
    kind: 'unexpected_response',
    status: 200,
    code: 'RESPONSE_UNREADABLE',
    message: 'The service answered, but its answer could not be read.',
    nextAction: 'retry_with_same_key',
    correlationId: 'c-unreadable',
  });
  error.method = method;
  return error;
}

/** `reason: null` for an INTEGRATION_UNAVAILABLE without one (a provider that did not answer). */
function paused(reason: string | null = 'recovery_mode'): ApiError {
  const error = new ApiError({
    kind: 'api',
    status: 503,
    code: 'INTEGRATION_UNAVAILABLE',
    message: PAUSED,
    nextAction: 'retry_later',
    correlationId: 'c-paused',
    details: reason === null ? undefined : { reason },
  });
  error.method = 'post';
  return error;
}

describe('R4-CLIENTS-A11Y-COPY-01 command outcome predicates (src/api/command-outcome.ts)', () => {
  it('are the shared api-client predicates, not a copy of the customer app', () => {
    expect(outcome.mayHaveTakenEffect).toBe(shared.mayHaveTakenEffect);
    expect(outcome.refusedBeforeRunning).toBe(shared.refusedBeforeRunning);
    expect(outcome.outcomeStillOpen).toBe(shared.outcomeStillOpen);
    expect(outcome.tookEffectOutcomeLost).toBe(shared.tookEffectOutcomeLost);
    expect(outcome.keepsIntentAfterFailure).toBe(shared.keepsIntentAfterFailure);
    expect(outcome.secretWithheldOf).toBe(shared.secretWithheldOf);
    expect(outcome.mustNotCreateAgain).toBe(shared.mustNotCreateAgain);
  });

  it('SPK-PAY-007: a command answered success whose body could not be read may have taken effect and keeps its key', () => {
    expect(outcome.mayHaveTakenEffect(unreadable())).toBe(true);
    expect(outcome.keepsIntentAfterFailure(unreadable())).toBe(true);
    expect(outcome.refusedBeforeRunning(unreadable())).toBe(false);
  });

  it('SPK-AT-028: a refusal before running is not "may have taken effect", although it is a 503', () => {
    expect(outcome.refusedBeforeRunning(paused())).toBe(true);
    expect(outcome.mayHaveTakenEffect(paused())).toBe(false);
    expect(outcome.outcomeStillOpen(paused())).toBe(false);
    // A provider that did not answer is still no definite answer.
    expect(outcome.refusedBeforeRunning(paused(null))).toBe(false);
    expect(outcome.mayHaveTakenEffect(paused(null))).toBe(true);
  });

  it('a failed read changed nothing, whatever answer it lost', () => {
    expect(outcome.mayHaveTakenEffect(unreadable('get'))).toBe(false);
  });
});

describe('R4-CLIENTS-A11Y-COPY-01 account CommandError', () => {
  it('SPK-AT-028: a refusal before running reads "Not done" with the API message and that nothing was changed, announced with "Try again"', () => {
    const app = createTestApp();
    const onRetry = jest.fn();
    render(<CommandError error={paused()} onRetry={onRetry} />, { wrapper: app.wrapper });
    expect(screen.getByLabelText('Not done')).toBeOnTheScreen();
    expect(screen.getByText(PAUSED)).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Nothing was changed: the service did not run this request, so nothing was paid or recorded.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-paused'),
    ).toBeOnTheScreen();
    expect(
      screen.queryByLabelText('No answer yet: this may already have been recorded'),
    ).toBeNull();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      `Not done. ${PAUSED} Nothing was changed: the service did not run this request, so nothing was paid or recorded. Try again.`,
      { queue: true },
    );
  });

  it('SPK-PAY-007: an answer that could not be read reads "No answer yet" with "Check again", never "Something went wrong"', () => {
    const app = createTestApp();
    render(<CommandError error={unreadable()} onRetry={jest.fn()} />, { wrapper: app.wrapper });
    expect(
      screen.getByLabelText('No answer yet: this may already have been recorded'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    expect(screen.queryByLabelText('Not done')).toBeNull();
  });
});

describe('R4-CLIENTS-A11Y-COPY-01 a refusal before running of a re-check (refusedAfterNoAnswer)', () => {
  it('SPK-AT-028: marks a refusal under the key whose last attempt got no answer, and only then', () => {
    const memory = new outcome.NoAnswerMemory();
    // A first attempt refused: nothing ran.
    const first = paused();
    memory.failed('key-a', first);
    expect(outcome.refusedAfterNoAnswer(first)).toBe(false);
    // No answer, then the check of it refused: only the check did not run.
    memory.failed('key-a', noAnswer());
    const check = paused();
    memory.failed('key-a', check);
    expect(outcome.refusedAfterNoAnswer(check)).toBe(true);
    // A later refusal of the same check is still one; another key's is not.
    const again = paused();
    memory.failed('key-a', again);
    expect(outcome.refusedAfterNoAnswer(again)).toBe(true);
    const other = paused();
    memory.failed('key-b', other);
    expect(outcome.refusedAfterNoAnswer(other)).toBe(false);
  });

  it('a definite answer or a success settles the earlier attempt', () => {
    const memory = new outcome.NoAnswerMemory();
    memory.failed('key-a', noAnswer());
    memory.failed('key-a', refused('PAYMENT_FAILED', 402));
    const afterRefusal = paused();
    memory.failed('key-a', afterRefusal);
    expect(outcome.refusedAfterNoAnswer(afterRefusal)).toBe(false);
    memory.failed('key-a', noAnswer());
    memory.settled();
    const afterSuccess = paused();
    memory.failed('key-a', afterSuccess);
    expect(outcome.refusedAfterNoAnswer(afterSuccess)).toBe(false);
    // An earlier attempt that committed with its answer lost is open too.
    memory.failed('key-c', refused('IDEMPOTENCY_OUTCOME_UNAVAILABLE', 409));
    const afterLost = paused();
    memory.failed('key-c', afterLost);
    expect(outcome.refusedAfterNoAnswer(afterLost)).toBe(true);
  });

  it('SPK-PAY-007: useApiCommand marks the refused check of an intent that got no answer, under the same key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /obligations/{id}/payments': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('Network request failed');
          return fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              message: PAUSED,
              nextAction: 'retry_later',
              details: { reason: 'recovery_mode' },
            }),
          );
        },
      },
    });
    const { result } = renderHook(() => useApiCommand('post', '/obligations/{id}/payments'), {
      wrapper: app.wrapper,
    });
    await act(async () => undefined);
    const request = {
      path: { id: '0192f1a0-0000-7000-8000-000000000501' },
      body: { paymentMethodToken: 'pm_fake_visa' },
    };
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.code).toBe('NETWORK_UNAVAILABLE'));
    await act(async () => {
      await result.current.submit(request).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error?.code).toBe('INTEGRATION_UNAVAILABLE'));
    expect(outcome.refusedAfterNoAnswer(result.current.error)).toBe(true);
    const keys = app.fake.requests.map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('the shared failure views read "Check not run" for it, never "Nothing was changed"', () => {
    const memory = new outcome.NoAnswerMemory();
    memory.failed('key-a', noAnswer());
    const check = paused();
    memory.failed('key-a', check);
    const app = createTestApp();
    render(<MoneyCommandFailure error={check} what="the cancellation" onRetry={jest.fn()} />, {
      wrapper: app.wrapper,
    });
    expect(screen.getByLabelText('Check not run')).toBeOnTheScreen();
    expect(screen.getByText(PAUSED)).toBeOnTheScreen();
    expect(
      screen.getByText(
        'This check could not run now, so the earlier attempt may still have gone through. Check again later before doing it again.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/nothing was paid or recorded/)).toBeNull();
    expect(screen.queryByLabelText('Not done')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      `Check not run. ${PAUSED} This check could not run now, so the earlier attempt may still have gone through. Check again later before doing it again. Check again.`,
      { queue: true },
    );
  });
});
