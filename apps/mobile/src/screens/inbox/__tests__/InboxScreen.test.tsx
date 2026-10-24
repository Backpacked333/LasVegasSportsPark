/**
 * SCR-C-06 inbox: the reference example of a screen test with a mocked API. Covers the
 * SPK-UX-008 states the screen defines (loading, empty, ready, error with code, unavailable,
 * offline with age, signed out) and the request it sends (§4.8 bearer token, §4.13 client header).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen } from '@testing-library/react-native';
import { createTestApp } from '../../../testing/test-app';
import { InboxScreen, inboxStatus } from '../InboxScreen';

const ITEM = {
  attemptId: '0192f1a0-0000-7000-8000-000000000101',
  notificationId: '0192f1a0-0000-7000-8000-000000000201',
  kind: 'schedule_change',
  category: 'operational',
  title: 'Kickoff moved',
  body: 'Saturday 10:00 is now 11:00 on Pitch 2.',
  facilityId: null,
  subject: null,
  detailsBefore: null,
  detailsAfter: null,
  status: 'delivered',
  deliveredAt: '2026-10-24T11:00:00.000Z',
  readAt: null,
  acknowledgedAt: null,
  supersededByNotificationId: null,
  createdAt: '2026-10-24T11:00:00.000Z',
};

const page = (items: unknown[]) => ({ status: 200, body: { items, nextCursor: null } });

describe('SCR-C-06 InboxScreen', () => {
  it('loads with the bearer token and client header, then lists notices with their status', async () => {
    const app = createTestApp({ routes: { 'GET /me/inbox': page([ITEM]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });

    expect(await screen.findByText('Kickoff moved')).toBeOnTheScreen();
    expect(screen.getByLabelText('Unread')).toBeOnTheScreen();
    expect(screen.getByText('Updated just now')).toBeOnTheScreen();

    const request = app.fake.requests[0];
    expect(request?.headers.authorization).toBe('Bearer test-token');
    expect(request?.headers['x-sportspark-client']).toBe('sportspark-mobile/0.1.0 (ios)');
    expect(request?.query).toEqual({ limit: '50' });
  });

  it('shows a loading state first', async () => {
    const app = createTestApp({ routes: { 'GET /me/inbox': page([]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
    expect(await screen.findByText('No notifications')).toBeOnTheScreen();
  });

  it('shows the empty state when nothing is in scope', async () => {
    const app = createTestApp({ routes: { 'GET /me/inbox': page([]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No notifications' })).toBeOnTheScreen();
  });

  it('shows the API error code, reference and recovery action', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              message: 'Messaging is currently unavailable.',
              nextAction: 'retry_later',
              correlationId: 'corr-9',
            }),
          ),
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Messaging is currently unavailable.')).toBeOnTheScreen();
    expect(
      screen.getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-9/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('shows NOT_FOUND as unavailable, without implying a record exists (§4.10)', async () => {
    const app = createTestApp({ routes: {} }); // unmatched requests answer NOT_FOUND
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('keeps the last loaded notices when offline and says how old they are (§4.15)', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: { 'GET /me/inbox': page([ITEM]) }, now: () => now });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Kickoff moved')).toBeOnTheScreen();

    now = new Date('2026-10-24T12:20:00.000Z');
    act(() => app.sources.setReachable(false));
    // The screen notice and the SCR-C-40 banner both state the age of what is shown.
    expect(screen.getAllByLabelText('You are offline')).toHaveLength(2);
    expect(screen.getByText('Showing information from 20 minutes ago.')).toBeOnTheScreen();
    expect(screen.getByText('Kickoff moved')).toBeOnTheScreen();
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTestApp({ session: null, routes: { 'GET /me/inbox': page([ITEM]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('labels statuses with the journeys.md vocabulary', () => {
    expect(inboxStatus(ITEM as never).label).toBe('Unread');
    expect(inboxStatus({ ...ITEM, readAt: 'x' } as never).label).toBe('Read');
    expect(inboxStatus({ ...ITEM, readAt: 'x', acknowledgedAt: 'y' } as never).label).toBe(
      'Acknowledged',
    );
    expect(inboxStatus({ ...ITEM, supersededByNotificationId: 'n2' } as never).label).toBe(
      'Replaced by a newer update',
    );
  });
});
