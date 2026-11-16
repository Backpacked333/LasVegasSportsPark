/**
 * StateView v2 (SPK-UX-008; PA-11, SPK-UX-011 **Proposed**; SPK-UX-009): plain words on screen,
 * decision identifiers, owners, error codes and references only in the collapsed "Details for
 * support" fold. The SPK-UX-008 basics of every variant stay in primitives.test.tsx.
 */
import { ApiError } from '@sportspark/api-client';
import { fireEvent, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { openSupportDetails, renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import {
  announcementFor,
  PENDING_DECISION_FALLBACK,
  StateView,
  TURNED_OFF_MESSAGE,
} from '../StateView';
import { classicTheme, legendsTheme } from '../theme';

const CODES = /DEC-\d|POL-\d|owner|Error code|Reference|corr-/i;

function apiError(code: string, nextAction: string) {
  return new ApiError({
    kind: 'api',
    status: 409,
    code,
    message: 'The record changed since it was loaded.',
    nextAction,
    correlationId: 'corr-123',
  });
}

describe('StateView pending-decision (PA-11)', () => {
  it('SPK-UX-011: says what to do instead, offers the action, and keeps the decision in the fold', async () => {
    const onAction = jest.fn();
    await renderSurface(
      <StateView
        variant="pending-decision"
        subject="Paying in the app"
        decisions={['DEC-019']}
        owner="Technical lead/account owners"
        message="Pay at the front desk for now."
        action={{ label: 'Call the front desk', onPress: onAction }}
      />,
    );
    expect(
      screen.getByLabelText('Paying in the app. Pay at the front desk for now.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(CODES)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Call the front desk' }));
    expect(onAction).toHaveBeenCalledTimes(1);

    const fold = screen.getByRole('button', { name: 'Details for support' });
    expect(fold).toBeCollapsed();
    await openSupportDetails(screen);
    expect(screen.getByRole('button', { name: 'Details for support' })).toBeExpanded();
    expect(screen.getByText('Decision: DEC-019')).toBeOnTheScreen();
    expect(screen.getByText('Owner: Technical lead/account owners')).toBeOnTheScreen();
  });

  it('SPK-UX-011: without a message, says plainly that it is not in the app yet', async () => {
    await renderSurface(
      <StateView variant="pending-decision" subject="Account sign-in" decisions={['DEC-018']} />,
    );
    expect(PENDING_DECISION_FALLBACK).toBe("This isn't available in the app yet.");
    expect(
      screen.getByLabelText("Account sign-in. This isn't available in the app yet."),
    ).toBeOnTheScreen();
    expect(screen.queryByText(CODES)).toBeNull();
    // Only the fold is a control: no action is invented.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('SPK-UX-009: is not announced on iOS (it answers nothing), and is a polite live region', async () => {
    expect(
      announcementFor({
        variant: 'pending-decision',
        subject: 'Account sign-in',
        decisions: ['DEC-018'],
        message: 'Ask at the front desk.',
      }),
    ).toBeNull();
    await renderSurface(
      <StateView variant="pending-decision" subject="Account sign-in" decisions={['DEC-018']} />,
    );
    expect(screen.getByTestId('state-pending-decision')).toHaveProp(
      'accessibilityLiveRegion',
      'polite',
    );
  });
});

describe('StateView error and turned-off (PA-11)', () => {
  it('SPK-UX-011 / §4.10: an error keeps its message and recovery visible and its code and reference in the fold', async () => {
    const onAction = jest.fn();
    await renderSurface(
      <StateView
        variant="error"
        error={apiError('STALE_REVISION', 'reload_and_retry')}
        onAction={onAction}
      />,
    );
    expect(screen.getByLabelText('Something went wrong')).toBeOnTheScreen();
    expect(screen.getByText('The record changed since it was loaded.')).toBeOnTheScreen();
    expect(screen.queryByText(CODES)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: STALE_REVISION')).toBeOnTheScreen();
    expect(screen.getByText('Reference: corr-123')).toBeOnTheScreen();
    // The announcement never carries the code.
    expect(
      announcementFor({ variant: 'error', error: apiError('STALE_REVISION', 'reload_and_retry') }),
    ).toBe('Something went wrong. The record changed since it was loaded. Reload.');
  });

  it('SPK-UX-011: turned off reads "This isn\'t available right now." with its decisions in the fold', async () => {
    await renderSurface(
      <StateView
        variant="turned-off"
        subject="Rentals"
        decisions={['DEC-016', 'DEC-076']}
        owner="Product owner"
        stillAvailable="Bookings you already have stay listed."
      />,
    );
    expect(TURNED_OFF_MESSAGE).toBe("This isn't available right now.");
    const state = screen.getByTestId('state-turned-off');
    expect(within(state).getByLabelText('Rentals turned off')).toBeOnTheScreen();
    expect(within(state).getByText("This isn't available right now.")).toBeOnTheScreen();
    expect(within(state).getByText('Bookings you already have stay listed.')).toBeOnTheScreen();
    expect(within(state).queryByText(CODES)).toBeNull();
    await openSupportDetails(within(state));
    expect(within(state).getByText('Decisions: DEC-016, DEC-076')).toBeOnTheScreen();
    expect(within(state).getByText('Owner: Product owner')).toBeOnTheScreen();
    expect(
      announcementFor({
        variant: 'turned-off',
        subject: 'Rentals',
        decisions: ['DEC-016', 'DEC-076'],
        stillAvailable: 'Bookings you already have stay listed.',
      }),
    ).toBe(
      "Rentals turned off. This isn't available right now. Bookings you already have stay listed.",
    );
  });
});

describe('StateView controls and looks (SPK-UX-009)', () => {
  it('the fold and the actions are at least 44 pt tall', async () => {
    await renderSurface(
      <StateView
        variant="pending-decision"
        subject="Paying in the app"
        decisions={['DEC-019']}
        message="Pay at the front desk for now."
        action={{ label: 'Call the front desk', onPress: () => undefined }}
      />,
    );
    for (const name of ['Details for support', 'Call the front desk']) {
      const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style) as {
        minHeight: number;
      };
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('loading keeps one busy progress indicator named "Loading …", over a static skeleton', async () => {
    const view = <StateView variant="loading" label="your teams" />;
    const { rerender } = await renderSurface(view);
    expect(screen.getByRole('progressbar', { name: 'Loading your teams' })).toBeBusy();
    expect(screen.getByTestId('state-loading-outline', { includeHiddenElements: true })).toHaveProp(
      'importantForAccessibility',
      'no-hide-descendants',
    );
    // Reduced motion or not, nothing moves and the indicator is the same.
    rerender(<MotionProvider reduced={false}>{view}</MotionProvider>);
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'draws the pending notice on the info tint and the skeleton on its fill in the %s theme',
    async (name, theme) => {
      await renderSurface(
        <>
          <StateView variant="pending-decision" subject="Account sign-in" decisions={['DEC-018']} />
          <StateView variant="loading" label="your teams" />
        </>,
        { theme: name },
      );
      const notice = screen.getByLabelText("Account sign-in. This isn't available in the app yet.");
      // The InfoCard is the host view around the notice's words.
      let card = notice.parent;
      while (card && typeof card.type !== 'string') card = card.parent;
      expect(card).toHaveStyle({ backgroundColor: theme.toneBackgrounds.info });
      const outline = screen.getByTestId('state-loading-outline', { includeHiddenElements: true });
      const bars = outline.findAll((node) => typeof node.type === 'string' && node !== outline);
      expect(bars).toHaveLength(2);
      for (const bar of bars) expect(bar).toHaveStyle({ backgroundColor: theme.colors.skeleton });
    },
  );

  it('SPK-UX-009 reduced motion: the fold opens at once, and the same way with motion allowed', async () => {
    const view = <StateView variant="error" error={apiError('TIMEOUT', 'retry_later')} />;
    const { rerender } = await renderSurface(view);
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: TIMEOUT')).toBeOnTheScreen();
    rerender(<MotionProvider reduced={false}>{view}</MotionProvider>);
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: TIMEOUT')).toBeOnTheScreen();
  });
});
