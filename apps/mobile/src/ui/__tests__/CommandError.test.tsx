/**
 * CommandError, the one failure view of the customer screens (SPK-UX-008, §4.9, §4.10,
 * SPK-PAY-007; ADR-008, PA-11): its code and reference in the support fold, `payment` keeping
 * "Do not pay again", and a decision made only with the predicates of `api/command-outcome.ts`.
 * Each wording's announcements are pinned in `announce.test.tsx`.
 */
import { ApiError, type ApiErrorInit } from '@sportspark/api-client';
import { fireEvent, screen } from '@testing-library/react-native';
import * as fs from 'fs';
import * as path from 'path';
import { AccessibilityInfo, Platform } from 'react-native';
import { openSupportDetails, renderSurface } from '../../testing/ui-surfaces';
import { CommandError, PAYMENT_UNKNOWN_LABEL } from '../CommandError';

function apiError(init: Partial<ApiErrorInit> & { code: string }): ApiError {
  return new ApiError({
    kind: 'api',
    status: 409,
    message: 'The record changed since it was loaded.',
    nextAction: 'reload_and_retry',
    correlationId: 'corr-1',
    ...init,
  });
}

const timeout = () =>
  apiError({
    kind: 'timeout',
    status: null,
    code: 'TIMEOUT',
    message: 'The service took too long to answer.',
    nextAction: 'retry_with_same_key',
    correlationId: null,
  });

describe('CommandError (SPK-UX-008)', () => {
  let announce: jest.SpyInstance;
  const os = Platform.OS;
  beforeEach(() => {
    announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => undefined);
    Platform.OS = 'ios';
  });
  afterEach(() => {
    Platform.OS = os;
    announce.mockRestore();
  });

  it('PA-11: the error code, the rule code and the reference are in the support fold, not in the words', async () => {
    await renderSurface(
      <CommandError
        wording="team"
        error={apiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          message: 'A team captain must be an adult.',
          nextAction: 'correct_input',
          details: { code: 'CAPTAIN_MUST_BE_ADULT' },
          correlationId: 'corr-23',
        })}
      />,
    );
    expect(screen.getByText('A team captain must be an adult.')).toBeOnTheScreen();
    expect(screen.queryByText(/Error code/)).toBeNull();
    expect(screen.queryByText(/corr-23/)).toBeNull();
    await openSupportDetails(screen);
    expect(
      screen.getByText('Error code: VALIDATION_FAILED (CAPTAIN_MUST_BE_ADULT)'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Reference: corr-23')).toBeOnTheScreen();
    expect(announce.mock.calls.map(([words]) => words)).toEqual([
      'Not done. A team captain must be an adult. Review your entries.',
    ]);
  });

  it('SPK-PAY-007: payment keeps "Do not pay again" for a payment left without an answer, and "Check again" repeats it', async () => {
    const onRetry = jest.fn();
    await renderSurface(
      <CommandError wording="money" error={timeout()} onRetry={onRetry} payment />,
    );
    expect(screen.getByLabelText(PAYMENT_UNKNOWN_LABEL)).toBeOnTheScreen();
    expect(PAYMENT_UNKNOWN_LABEL).toBe('Payment outcome being confirmed. Do not pay again.');
    fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls.map(([words]) => words)).toEqual([
      'Payment outcome being confirmed. Do not pay again. We did not get a definite answer about this payment. Checking again is safe: it asks with the same request, which can never charge you twice. Check again.',
    ]);
  });

  it('SPK-PAY-007: the registration wording reads PAYMENT_OUTCOME_UNKNOWN as a payment without being told', async () => {
    await renderSurface(
      <CommandError
        wording="registration"
        error={apiError({
          status: 409,
          code: 'PAYMENT_OUTCOME_UNKNOWN',
          message: 'The payment provider has not confirmed this payment.',
          nextAction: 'await_reconciliation',
        })}
      />,
    );
    expect(screen.getByLabelText(PAYMENT_UNKNOWN_LABEL)).toBeOnTheScreen();
    expect(screen.getByTestId('command-error')).toBeOnTheScreen();
  });

  it('renders nothing without an error', async () => {
    await renderSurface(<CommandError wording="registration" error={null} />);
    expect(screen.queryByTestId('command-error')).toBeNull();
  });

  it('§4.9: decides whether a command took effect only through api/command-outcome', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../CommandError.tsx'), 'utf8');
    expect(source).toMatch(/from '\.\.\/api\/command-outcome'/);
    // The client's own flags cover only some outcomes; the shared predicates cover them all.
    expect(source).not.toMatch(/\.outcomeUnknown|\.keepsIntent\b|\.kind === 'network'/);
  });
});
