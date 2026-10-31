/**
 * SPK-UX-009 (NA-A01 "every status change is announced, errors are announced"): results reach
 * VoiceOver as well as TalkBack. React Native's `accessibilityLiveRegion` is Android only, so on
 * iOS each result view posts its words with `AccessibilityInfo.announceForAccessibilityWithOptions`
 * (src/ui/announce.tsx). The jest preset renders as iOS and records those calls.
 */
import { ApiError, type ApiErrorInit } from '@sportspark/api-client';
import { render, screen } from '@testing-library/react-native';
import * as fs from 'fs';
import * as path from 'path';
import { AccessibilityInfo, Platform } from 'react-native';
import { CommandFailure as MoneyCommandFailure } from '../../features/money/CommandFailure';
import { TextField as MoneyTextField } from '../../features/money/ui';
import { CommandError as RegistrationCommandError } from '../../features/registration/CommandError';
import { TextField as RegistrationTextField } from '../../features/registration/ui';
import { CommandFailure as TeamsCommandFailure } from '../../features/teams/ui';
import { CommandError as AccountCommandError } from '../../screens/account/components/CommandError';
import { TextField as AccountTextField } from '../../screens/account/components/forms';
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

  it('StateView: an error is announced with its message, never its code or reference', () => {
    render(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    expect(announced()).toEqual(['Something went wrong. The record changed since it was loaded.']);
    expect(announced()[0]).not.toMatch(/STALE_REVISION|corr-123/);
  });

  it('StateView: the same words for a second failure are announced again', () => {
    const { rerender } = render(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    rerender(<StateView variant="error" error={apiError('STALE_REVISION')} />);
    expect(announce).toHaveBeenCalledTimes(2);
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

  it('"No answer yet" is announced by every shared failure view', () => {
    const app = createTestApp();
    const views = [
      <MoneyCommandFailure key="money" error={noAnswer()} what="the payment" onRetry={jest.fn()} />,
      <TeamsCommandFailure key="teams" error={noAnswer()} onRetry={jest.fn()} />,
      <AccountCommandError key="account" error={noAnswer()} onRetry={jest.fn()} />,
      <RegistrationCommandError key="registration" error={noAnswer()} onRetry={jest.fn()} />,
    ];
    for (const view of views) render(view, { wrapper: app.wrapper });
    expect(announced()).toEqual([
      expect.stringMatching(
        /^No answer yet\. We did not get a definite answer about the payment\./,
      ),
      expect.stringMatching(/^No answer yet: this may already have been recorded\. The connection/),
      expect.stringMatching(/^No answer yet: this may already have been recorded\. There was no/),
      expect.stringMatching(/^No answer yet: this may already have been recorded\. There was no/),
    ]);
  });

  it('a stale answer is announced as "This changed since you opened it"', () => {
    render(<MoneyCommandFailure error={apiError('STALE_REVISION')} what="the cancellation" />);
    expect(announced()).toEqual([
      'This changed since you opened it. The record changed since it was loaded.',
    ]);
  });

  it('a field error is announced and is part of the input hint, so it is read with the field', () => {
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
    }
    expect(announced()).toEqual(['Enter a reason.', 'Enter a reason.', 'Enter a reason.']);
  });

  it('sentences joins a badge and its explanation as one announcement', () => {
    expect(sentences('No answer yet', null, 'Check again.', '  ')).toBe(
      'No answer yet. Check again.',
    );
  });
});
