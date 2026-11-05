/**
 * SPK-UX-008 state primitives and SPK-UX-009 accessibility of the shared UI components.
 */
import { ApiError } from '@sportspark/api-client';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Button } from '../Button';
import { ListRow } from '../ListRow';
import { STATUS_GLYPHS, StatusBadge } from '../StatusBadge';
import { StateView } from '../StateView';

const NOW = new Date('2026-10-24T12:00:00Z');

function apiError(code: string, nextAction: string, kind: ApiError['kind'] = 'api') {
  return new ApiError({
    kind,
    status: 409,
    code,
    message: 'The record changed since it was loaded.',
    nextAction,
    correlationId: 'corr-123',
  });
}

describe('StateView (SPK-UX-008)', () => {
  it('loading: announces what is loading as a busy progress indicator', () => {
    render(<StateView variant="loading" label="notifications" />);
    const progress = screen.getByRole('progressbar');
    expect(screen.getByLabelText('Loading notifications')).toBeOnTheScreen();
    expect(progress).toBeBusy();
  });

  it('empty: says what would appear and offers the permitted way to create it', () => {
    const onAction = jest.fn();
    render(
      <StateView
        variant="empty"
        title="No teams yet"
        description="Teams you join or create appear here."
        actionLabel="Create a team"
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('header', { name: 'No teams yet' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Create a team' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('error: shows the API error code, the correlation reference and the recovery action', () => {
    const onAction = jest.fn();
    render(
      <StateView
        variant="error"
        error={apiError('STALE_REVISION', 'reload_and_retry')}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('The record changed since it was loaded.')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: STALE_REVISION\. Reference: corr-123/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('error: a retryable failure retries; an unknown payment outcome never offers to pay again', () => {
    const onRetry = jest.fn();
    const { rerender } = render(
      <StateView
        variant="error"
        error={apiError('INTEGRATION_UNAVAILABLE', 'retry_later')}
        onRetry={onRetry}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <StateView
        variant="error"
        error={apiError('PAYMENT_OUTCOME_UNKNOWN', 'await_reconciliation')}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Do not pay again. The outcome is being confirmed.')).toBeOnTheScreen();
  });

  it('offline-stale: shows the age of what is shown and the actions that need a connection', () => {
    render(
      <StateView
        variant="offline-stale"
        offline
        updatedAt={new Date('2026-10-24T11:48:00Z')}
        now={NOW}
        unavailableActions={['RSVP', 'payment']}
      />,
    );
    expect(screen.getByLabelText('You are offline')).toBeOnTheScreen();
    expect(screen.getByText('Showing information from 12 minutes ago.')).toBeOnTheScreen();
    expect(screen.getByText('Needs a connection: RSVP, payment.')).toBeOnTheScreen();
  });

  it('unavailable: never implies that a protected record exists (§4.10)', () => {
    render(<StateView variant="unavailable" />);
    expect(screen.getByLabelText('Not available')).toBeOnTheScreen();
    const text = screen.getByText(/This is not available/).props.children as string;
    expect(text).not.toMatch(/permission|denied|exists|another (household|account)/i);
  });

  it('pending-decision: names the decision and its owner instead of inventing a policy', () => {
    render(
      <StateView
        variant="pending-decision"
        subject="Account sign-in"
        decisions={['DEC-018']}
        owner="Technical lead/account owners"
      />,
    );
    expect(screen.getByLabelText('Waiting on a decision')).toBeOnTheScreen();
    expect(
      screen.getByText(/Account sign-in is not available yet: it depends on DEC-018/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/owner: Technical lead\/account owners/)).toBeOnTheScreen();
  });
});

describe('StatusBadge (SPK-UX-004, SPK-UX-009)', () => {
  it('carries status as text plus a distinct glyph per tone, never colour alone', () => {
    const glyphs = Object.values(STATUS_GLYPHS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    render(<StatusBadge tone="pending" label="Payment processing" />);
    expect(screen.getByLabelText('Payment processing')).toBeOnTheScreen();
    expect(screen.getByText('Payment processing')).toBeOnTheScreen();
    // The glyph is decorative: rendered, but hidden from VoiceOver and TalkBack.
    expect(
      screen.getByText(STATUS_GLYPHS.pending, { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(STATUS_GLYPHS.pending)).toBeNull();
  });

  it('keeps "Payment processing", "Confirmed, awaiting placement" and "Confirmed" distinct', () => {
    render(
      <>
        <StatusBadge tone="pending" label="Payment processing" />
        <StatusBadge tone="info" label="Confirmed in U10 Fall. Awaiting placement." />
        <StatusBadge tone="success" label="Confirmed: U10 Red" />
      </>,
    );
    const labels = [
      'Payment processing',
      'Confirmed in U10 Fall. Awaiting placement.',
      'Confirmed: U10 Red',
    ];
    for (const label of labels) expect(screen.getByLabelText(label)).toBeOnTheScreen();
  });
});

describe('Button and ListRow accessibility (SPK-UX-009)', () => {
  it('exposes role, label, disabled and busy state', () => {
    const onPress = jest.fn();
    const { rerender } = render(<Button label="Accept" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(<Button label="Accept" onPress={onPress} busy />);
    const busy = screen.getByRole('button', { name: 'Accept' });
    expect(busy).toBeBusy();
    expect(busy).toBeDisabled();
    fireEvent.press(busy);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('reads a row as one element: title, detail, status', () => {
    render(
      <ListRow
        title="Field change"
        detail="Pitch 2 to Pitch 4"
        status={{ tone: 'info', label: 'Unread' }}
        onPress={() => undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Field change, Pitch 2 to Pitch 4, Unread' }),
    ).toBeOnTheScreen();
  });
});
