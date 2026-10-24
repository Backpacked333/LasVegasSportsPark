/**
 * SCR-C-06 inbox: the reference example of a screen test with a mocked API. Covers the
 * SPK-UX-008 states the screen defines (loading, empty, ready, error with code, unavailable,
 * offline with age, signed out) and the request it sends (§4.8 bearer token, §4.13 client header).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { notice, scheduleChange } from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { InboxScreen, inboxStatus } from '../InboxScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

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

describe('SCR-C-06 InboxScreen: reading, acknowledging, revocation and replaced notices', () => {
  const unread = (overrides: Record<string, unknown> = {}) => notice({ ...overrides });

  it('SPK-COMMS-004: opening a notice marks it read once, with an idempotency key, and shows its category', async () => {
    const item = unread({ title: 'Field update', body: 'The north field opens at 9.' });
    let readAt: string | null = null;
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () =>
          fakeResponse(200, { items: [{ ...item, readAt }], nextCursor: null }),
        'POST /me/inbox/{id}/read': (req) => {
          readAt = '2026-10-24T12:00:00.000Z';
          return fakeResponse(200, { ...item, readAt, id: req.params.id });
        },
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Field update, Unread' }));
    expect(
      await screen.findByText(/^Essential notice\. Received Sat, Oct 24, 4:00 AM PDT/),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: 'Field update, Read' })).toBeOnTheScreen();
    const reads = app.fake.requests.filter((r) => r.route === '/me/inbox/{id}/read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params.id).toBe(item.attemptId);
    expect(reads[0]?.headers['idempotency-key']).toMatch(/^key-/);
    expect(reads[0]?.body).toEqual({});
  });

  it('acknowledges once; a retry after INTEGRATION_UNAVAILABLE reuses the same idempotency key (§4.9)', async () => {
    const item = unread({ readAt: '2026-10-24T11:30:00.000Z', title: 'Bring water' });
    let calls = 0;
    let acknowledgedAt: string | null = null;
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () =>
          fakeResponse(200, { items: [{ ...item, acknowledgedAt }], nextCursor: null }),
        'POST /me/inbox/{id}/acknowledge': () => {
          calls += 1;
          if (calls === 1) {
            return fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', {
                nextAction: 'retry_later',
                correlationId: 'corr-ack',
              }),
            );
          }
          acknowledgedAt = '2026-10-24T12:00:00.000Z';
          return fakeResponse(200, { ...item, acknowledgedAt });
        },
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Bring water, Read' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-ack/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: 'Bring water, Acknowledged' }),
    ).toBeOnTheScreen();
    const acks = app.fake.requests.filter((r) => r.route === '/me/inbox/{id}/acknowledge');
    expect(acks).toHaveLength(2);
    expect(acks[0]?.headers['idempotency-key']).toBe(acks[1]?.headers['idempotency-key']);
  });

  it('SPK-IAM-006 / SPK-AT-017: a protected notice withdrawn after access was removed shows as no longer available and leaves the list', async () => {
    const item = unread({ readAt: '2026-10-24T11:30:00.000Z', title: 'Practice note for Sam' });
    let revoked = false;
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () =>
          fakeResponse(200, { items: revoked ? [] : [item], nextCursor: null }),
        'POST /me/inbox/{id}/acknowledge': () => {
          revoked = true;
          return fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }));
        },
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Practice note for Sam, Read' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('No notifications')).toBeOnTheScreen();
    expect(screen.queryByText('Practice note for Sam')).toBeNull();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('§6.2: a replaced notice says so and opens the newer one, which shows old and new details (SPK-COMMS-005)', async () => {
    const newer = scheduleChange({ readAt: '2026-10-24T11:30:00.000Z' });
    const older = scheduleChange({
      title: 'Schedule changed: Junior Skills (earlier)',
      readAt: '2026-10-24T10:00:00.000Z',
      supersededByNotificationId: newer.notificationId,
    });
    const app = createTestApp({ routes: { 'GET /me/inbox': page([newer, older]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Schedule changed: Junior Skills (earlier), Replaced by a newer update',
      }),
    );
    expect(screen.getByText('A newer update replaces this notice.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByTestId(`notice-detail-${newer.attemptId}`)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Show the newer update' }));
    expect(await screen.findByTestId(`notice-change-${newer.attemptId}`)).toHaveProp(
      'accessibilityLabel',
      'Changed. Was: Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1. Now: Sat, Oct 24, 11:00 AM to 12:00 PM PDT at Pitch 2',
    );
    // Only the current notice can be acknowledged.
    expect(screen.getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(1);
  });

  it('opens the notice a Home link points to, and labels promotional messages apart (SPK-COMMS-007)', async () => {
    const promo = unread({
      category: 'promotional',
      kind: 'renewal_opportunity',
      title: 'Spring leagues',
      readAt: '2026-10-24T11:30:00.000Z',
    });
    const app = createTestApp({ routes: { 'GET /me/inbox': page([promo]) } });
    render(<InboxScreen openId={promo.attemptId} />, { wrapper: app.wrapper });
    expect(await screen.findByText(/^Promotional message\./)).toBeOnTheScreen();
  });

  it('loads older notices from the next cursor', async () => {
    const first = unread({ title: 'Newest' });
    const second = unread({ title: 'Oldest' });
    const app = createTestApp({
      routes: {
        'GET /me/inbox': (req) =>
          fakeResponse(
            200,
            req.query.cursor === 'c2'
              ? { items: [second], nextCursor: null }
              : { items: [first], nextCursor: 'c2' },
          ),
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Show older notices' }));
    expect(await screen.findByText('Oldest')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Show older notices' })).toBeNull();
    expect(app.fake.requests.at(-1)?.query).toEqual({ limit: '50', cursor: 'c2' });
  });

  it('offline: nothing is marked read and acknowledging waits for a connection (§4.15)', async () => {
    const item = unread({ title: 'Kit reminder' });
    const app = createTestApp({ routes: { 'GET /me/inbox': page([item]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Kit reminder')).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    fireEvent.press(screen.getByRole('button', { name: 'Kit reminder, Unread' }));
    expect(screen.getByText('Acknowledging needs a connection.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});
