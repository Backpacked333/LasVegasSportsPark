/**
 * SPK-UX-009 (NA-A01 "every status change is announced, errors are announced"): results reach
 * VoiceOver as well as TalkBack. React Native's `accessibilityLiveRegion` is Android only, so on
 * iOS each result view posts its words with `AccessibilityInfo.announceForAccessibilityWithOptions`
 * (src/ui/announce.tsx). The jest preset renders as iOS and records those calls.
 */
import { ApiError, type ApiErrorInit } from '@sportspark/api-client';
import { act, render, screen } from '@testing-library/react-native';
import type { NavigationProp, ParamListBase } from 'expo-router/build/react-navigation/core';
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import * as fs from 'fs';
import * as path from 'path';
import { AccessibilityInfo, Platform } from 'react-native';
import { CommandFailure as MoneyCommandFailure } from '../../features/money/CommandFailure';
import {
  FieldError as MoneyFieldError,
  TextField as MoneyTextField,
} from '../../features/money/ui';
import { CommandError as RegistrationCommandError } from '../../features/registration/CommandError';
import { TextField as RegistrationTextField } from '../../features/registration/ui';
import { CommandFailure as TeamsCommandFailure } from '../../features/teams/ui';
import { CommandError as AccountCommandError } from '../../screens/account/components/CommandError';
import { TextField as AccountTextField } from '../../screens/account/components/forms';
import { useConnectivity } from '../../providers/AppProviders';
import { createTestApp } from '../../testing/test-app';
import { LiveRegion, sentences } from '../announce';
import { OUTCOME_LOST_LABEL, OutcomeLost } from '../OutcomeLost';
import { StateView } from '../StateView';

const announce = AccessibilityInfo.announceForAccessibilityWithOptions as jest.Mock;
const NOW = new Date('2026-10-24T12:00:00Z');

function apiError(code: string, overrides: Partial<ApiErrorInit> = {}) {
  return new ApiError({
    kind: 'api',
    status: 409,
    code,
    message: 'The record changed since it was loaded.',
    nextAction: 'reload_and_retry',
    correlationId: 'corr-123',
    ...overrides,
  });
}

/** What a dropped connection after sending looks like to the client (kind `network`). */
const noAnswer = () =>
  new ApiError({
    kind: 'network',
    status: null,
    code: 'NETWORK_UNAVAILABLE',
    message: 'The connection was lost.',
    nextAction: 'retry',
    correlationId: null,
  });

const announced = () => announce.mock.calls.map((call) => call[0] as string);

/** Lets the current JavaScript task end: what follows is a later answer, not the same moment. */
const nextTask = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('SPK-UX-009 announcements reach VoiceOver (ui/announce)', () => {
  it('every live region in the app goes through ui/announce, so none is silent on iOS', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.tsx?$/.test(entry.name) && full !== path.join(root, 'ui', 'announce.tsx')) {
          if (fs.readFileSync(full, 'utf8').includes('accessibilityLiveRegion')) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('posts the words queued behind current speech (polite), once per appearance', () => {
    const { rerender } = render(<LiveRegion announcement="Request sent." />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Request sent.', { queue: true });
    rerender(<LiveRegion announcement="Request sent." />);
    expect(announce).toHaveBeenCalledTimes(1);
    rerender(<LiveRegion announcement={null} />);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('on Android nothing is posted: the view is a polite live region that TalkBack reads', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      render(<LiveRegion announcement="Request sent." testID="live" />);
      expect(announce).not.toHaveBeenCalled();
      expect(screen.getByTestId('live')).toHaveProp('accessibilityLiveRegion', 'polite');
    } finally {
      os.restore();
    }
  });

  it('StateView: an error is announced with its message and next action, never its code or reference', () => {
    render(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    expect(announced()).toEqual([
      'Something went wrong. The record changed since it was loaded. Reload.',
    ]);
    expect(announced()[0]).not.toMatch(/STALE_REVISION|corr-123/);
  });

  it('StateView: the same words for a second failure are announced again', async () => {
    const { rerender } = render(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    // A second answer always arrives in a later task (after another request).
    await nextTask();
    rerender(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('the same words shown by two views at the same moment are announced once', async () => {
    render(
      <>
        <LiveRegion announcement="No answer yet." />
        <LiveRegion announcement="No answer yet." />
        <LiveRegion announcement="Request sent." />
      </>,
    );
    expect(announced()).toEqual(['No answer yet.', 'Request sent.']);
    await nextTask();
    render(<LiveRegion announcement="No answer yet." />);
    expect(announced()).toEqual(['No answer yet.', 'Request sent.', 'No answer yet.']);
  });

  it('a result on a screen that is not in view (a hidden tab, the stack below) is not announced', () => {
    const focused = { value: false };
    const navigation = {
      isFocused: () => focused.value,
    } as unknown as NavigationProp<ParamListBase>;
    const view = (words: string) => (
      <NavigationContext.Provider value={navigation}>
        <LiveRegion announcement={words} testID="live" />
      </NavigationContext.Provider>
    );
    const { rerender } = render(view('Saved.'));
    expect(announce).not.toHaveBeenCalled();
    // TalkBack reads only what is on screen; the live region is still there for when it is.
    expect(screen.getByTestId('live')).toHaveProp('accessibilityLiveRegion', 'polite');
    focused.value = true;
    rerender(view('Saved again.'));
    expect(announced()).toEqual(['Saved again.']);
  });

  it('next actions: an error is announced with what to do next (NA-A01)', () => {
    const app = createTestApp();
    const unknownPayment = apiError('PAYMENT_OUTCOME_UNKNOWN', {
      message: 'The payment provider has not confirmed this payment.',
      nextAction: 'await_reconciliation',
    });
    render(<TeamsCommandFailure error={unknownPayment} onRetry={jest.fn()} />, {
      wrapper: app.wrapper,
    });
    render(<MoneyCommandFailure error={unknownPayment} what="the payment" onRetry={jest.fn()} />, {
      wrapper: app.wrapper,
    });
    render(
      <StateView
        variant="error"
        error={apiError('ACCOUNT_RESTRICTED', {
          message: 'This account cannot do that.',
          nextAction: 'contact_support',
        })}
      />,
    );
    render(
      <StateView
        variant="error"
        error={apiError('VALIDATION_FAILED', {
          message: 'Check the dates.',
          nextAction: 'correct_input',
        })}
      />,
    );
    render(
      <MoneyCommandFailure
        error={apiError('STALE_REVISION')}
        what="the cancellation"
        onReload={jest.fn()}
      />,
    );
    expect(announced()).toEqual([
      'No answer yet: this may already have been recorded. The payment provider has not confirmed this payment. Do not pay again. The outcome is being confirmed.',
      expect.stringMatching(
        /^No answer yet\. We did not get a definite answer about the payment\..* Do not pay again\. The outcome is being confirmed\.$/,
      ),
      'Something went wrong. This account cannot do that. Contact support.',
      'Something went wrong. Check the dates. Review your entries.',
      'This changed since you opened it. The record changed since it was loaded. Reload.',
    ]);
  });

  it('StateView: empty, unavailable, offline and turned-off answers are announced; loading and pending decisions are not', () => {
    render(<StateView variant="loading" label="notifications" />);
    render(
      <StateView variant="pending-decision" subject="Account sign-in" decisions={['DEC-001']} />,
    );
    expect(announce).not.toHaveBeenCalled();

    render(
      <StateView variant="empty" title="No teams yet" description="Teams you join appear here." />,
    );
    render(<StateView variant="unavailable" />);
    render(
      <StateView
        variant="offline-stale"
        updatedAt={new Date('2026-10-24T11:00:00Z')}
        now={NOW}
        offline
        unavailableActions={['Payment']}
      />,
    );
    render(<StateView variant="turned-off" subject="Rentals" decisions={['DEC-016']} />);
    expect(announced()).toEqual([
      'No teams yet. Teams you join appear here.',
      expect.stringMatching(/^Not available\. This is not available\./),
      // The age of the data changes while it is shown, so it is not part of the announcement.
      'You are offline. Needs a connection: Payment.',
      expect.stringMatching(/^Rentals turned off\. This is turned off for this organization\./),
    ]);
  });

  it('StateView: "You are offline" is left to the connectivity announcement while the device is offline', async () => {
    // Shown once the device is known to be offline, as QueryBoundary shows it.
    function OfflineRead() {
      const { reachable } = useConnectivity();
      return reachable === false ? (
        <StateView
          variant="offline-stale"
          updatedAt={null}
          now={NOW}
          offline
          unavailableActions={['Payment']}
          onRetry={jest.fn()}
        />
      ) : null;
    }
    const app = createTestApp({ reachable: false });
    render(<OfflineRead />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('state-offline-stale')).toBeOnTheScreen();
    expect(announce).not.toHaveBeenCalled();
    // Online, a read that got no answer is this view's to announce (the banner says nothing).
    await nextTask();
    const online = createTestApp();
    render(
      <StateView variant="offline-stale" updatedAt={null} now={NOW} offline onRetry={jest.fn()} />,
      { wrapper: online.wrapper },
    );
    expect(announced()).toEqual(['You are offline. Try again.']);
  });

  it('OutcomeLost: "This may already have been done" is announced', () => {
    const app = createTestApp();
    render(<OutcomeLost error={apiError('IDEMPOTENCY_OUTCOME_UNAVAILABLE')} what="the payment" />, {
      wrapper: app.wrapper,
    });
    expect(announced()).toEqual([
      expect.stringMatching(new RegExp(`^${OUTCOME_LOST_LABEL}\\. Your earlier request reached`)),
    ]);
    expect(announced()[0]).toContain('so the payment may already have been done');
  });

  it('"No answer yet" is announced by every shared failure view, with "Check again"', async () => {
    const app = createTestApp();
    const views = [
      <MoneyCommandFailure key="money" error={noAnswer()} what="the payment" onRetry={jest.fn()} />,
      <TeamsCommandFailure key="teams" error={noAnswer()} onRetry={jest.fn()} />,
      <AccountCommandError key="account" error={noAnswer()} onRetry={jest.fn()} />,
      <RegistrationCommandError key="registration" error={noAnswer()} onRetry={jest.fn()} />,
    ];
    for (const view of views) {
      render(view, { wrapper: app.wrapper });
      await nextTask();
    }
    expect(announced()).toEqual([
      expect.stringMatching(
        /^No answer yet\. We did not get a definite answer about the payment\..* Check again\.$/,
      ),
      expect.stringMatching(
        /^No answer yet: this may already have been recorded\. The connection.* Check again\.$/,
      ),
      expect.stringMatching(
        /^No answer yet: this may already have been recorded\. There was no.* Check again\.$/,
      ),
      expect.stringMatching(
        /^No answer yet: this may already have been recorded\. There was no.* Check again\.$/,
      ),
    ]);
  });

  it('R3-SCREEN-STATES-01: offline, "Check again" is disabled with "Needs a connection" in the registration and money failure views', async () => {
    const app = createTestApp({ reachable: false });
    for (const view of [
      <MoneyCommandFailure key="money" error={noAnswer()} what="the payment" onRetry={jest.fn()} />,
      <RegistrationCommandError key="registration" error={noAnswer()} onRetry={jest.fn()} />,
    ]) {
      const { unmount } = render(view, { wrapper: app.wrapper });
      await nextTask();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
      expect(screen.getByText('Needs a connection.')).toBeOnTheScreen();
      unmount();
    }
  });

  it('a stale answer is announced as "This changed since you opened it"', () => {
    render(<MoneyCommandFailure error={apiError('STALE_REVISION')} what="the cancellation" />);
    // No Reload is offered here, so none is announced.
    expect(announced()).toEqual([
      'This changed since you opened it. The record changed since it was loaded.',
    ]);
  });

  it('a field error is announced and is part of the input hint, so it is read with the field', async () => {
    const fields = [
      <MoneyTextField
        key="money"
        label="Reason"
        value=""
        onChangeText={jest.fn()}
        error="Enter a reason."
        hint="For the facility"
        testID="money"
      />,
      <RegistrationTextField
        key="registration"
        label="Reason"
        value=""
        onChangeText={jest.fn()}
        error="Enter a reason."
        hint="For the facility"
        testID="registration"
      />,
      <AccountTextField
        key="account"
        label="Reason"
        value=""
        onChangeText={jest.fn()}
        error="Enter a reason."
        hint="For the facility"
        testID="account"
      />,
    ];
    for (const field of fields) {
      const { getByTestId } = render(field);
      expect(getByTestId(String(field.key))).toHaveProp(
        'accessibilityHint',
        'For the facility. Error: Enter a reason.',
      );
      await nextTask();
    }
    expect(announced()).toEqual(['Enter a reason.', 'Enter a reason.', 'Enter a reason.']);
  });

  it('a choice error (the booking time or space) is announced as a field error', () => {
    render(<MoneyFieldError error="Choose a time." testID="choice-error" />);
    expect(announced()).toEqual(['Choose a time.']);
    expect(screen.getByTestId('choice-error')).toHaveProp('accessibilityRole', 'alert');
  });

  it('sentences joins a badge and its explanation as one announcement', () => {
    expect(sentences('No answer yet', null, 'Check again.', '  ')).toBe(
      'No answer yet. Check again.',
    );
  });
});
