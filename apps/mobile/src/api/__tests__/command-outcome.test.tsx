/**
 * The customer app decides what a command's failure says about its effect with the shared
 * predicates of `@sportspark/api-client`, the same ones the staff dashboard uses (§4.9, §4.10,
 * SPK-PAY-007, SPK-UX-008, SPK-AT-028, R4-CLIENTS-A11Y-COPY-01): a success status whose answer could
 * not be read (RESPONSE_UNREADABLE) may have taken effect, a refusal before running (503
 * INTEGRATION_UNAVAILABLE `recovery_mode`) did not, and a failed read changed nothing.
 */
import * as shared from '@sportspark/api-client';
import { ApiError } from '@sportspark/api-client';
import { render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { CommandError } from '../../screens/account/components/CommandError';
import { createTestApp } from '../../testing/test-app';
import * as outcome from '../command-outcome';

const PAUSED = 'Payments are paused while the service recovers from a restore. Try again later.';

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
