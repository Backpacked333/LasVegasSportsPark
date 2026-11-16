/**
 * SCR-C-06 inbox layout (ADR-008 visual system v2, PA-11 SPK-UX-011 **Proposed**; SPK-COMMS-004,
 * SPK-UX-003, SPK-UX-008): the "All" and "Needs action" tabs, the sections by day, a row that
 * opens the record its notice is about (with the read request the notice sends when opened), the
 * notice sheet with "Acknowledge", the illustrated empty inbox and pull to refresh.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { illustrations } from '../../../artwork/manifest';
import { FIXTURE, notice, scheduleChange } from '../../../features/today/__tests__/fixtures';
import { createTestApp, TEST_NOW } from '../../../testing/test-app';
import { openSheet } from '../../../testing/ui';
import { pullToRefresh } from '../../../testing/ui-surfaces';
import { dayTitle, inboxSections, needsAction } from '../inbox-sections';
import { InboxScreen, openSubjectLabel } from '../InboxScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

beforeEach(() => mockPush.mockClear());

const ZONE = 'America/Los_Angeles';
const page = (items: unknown[]) => ({ status: 200, body: { items, nextCursor: null } });

describe('SCR-C-06 inbox tabs and day sections (ADR-008)', () => {
  it('SPK-UX-003: "Needs action" keeps only the notices that ask for something; "All" lists every notice', async () => {
    const change = scheduleChange({ title: 'Kickoff moved' });
    const broadcast = notice({ title: 'Car park closed', readAt: '2026-10-24T11:30:00.000Z' });
    const promo = notice({ title: 'Spring leagues', category: 'promotional' });
    const app = createTestApp({ routes: { 'GET /me/inbox': page([change, broadcast, promo]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });

    const tabs = await screen.findByLabelText('Show');
    const all = within(tabs).getByRole('tab', { name: 'All' });
    expect(all).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
    expect(screen.getByText('Car park closed')).toBeOnTheScreen();
    expect(screen.getByText('Spring leagues')).toBeOnTheScreen();

    fireEvent.press(within(tabs).getByRole('tab', { name: 'Needs action' }));
    expect(within(tabs).getByRole('tab', { name: 'Needs action' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ selected: true }),
    );
    expect(screen.getByText('Kickoff moved')).toBeOnTheScreen();
    expect(screen.queryByText('Car park closed')).toBeNull();
    expect(screen.queryByText('Spring leagues')).toBeNull();
    // Switching tabs reads nothing and marks nothing read.
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    fireEvent.press(within(tabs).getByRole('tab', { name: 'All' }));
    expect(screen.getByText('Car park closed')).toBeOnTheScreen();
  });

  it('SPK-UX-003: with nothing to act on, "Needs action" says "You\'re all caught up"', async () => {
    const app = createTestApp({
      routes: { 'GET /me/inbox': page([notice({ title: 'Car park closed' })]) },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('tab', { name: 'Needs action' }));
    expect(screen.getByRole('header', { name: "You're all caught up" })).toBeOnTheScreen();
    expect(
      screen.getByText('Nothing in your notifications needs you right now.'),
    ).toBeOnTheScreen();
  });

  it('groups notices in sections by the day they arrived: Today, Yesterday, then the date', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/inbox': page([
          notice({ title: 'This morning', deliveredAt: '2026-10-24T11:00:00.000Z' }),
          notice({ title: 'Last night', deliveredAt: '2026-10-24T05:00:00.000Z' }),
          notice({ title: 'Earlier', deliveredAt: '2026-10-20T18:00:00.000Z' }),
        ]),
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Today' })).toBeOnTheScreen();
    // 05:00 UTC on the 24th is 10:00 PM on the 23rd in Los Angeles.
    expect(screen.getByRole('header', { name: 'Yesterday' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Tue, Oct 20' })).toBeOnTheScreen();
  });

  it('needsAction and inboxSections are pure: no guessing from the title, newest first', () => {
    const change = scheduleChange();
    const acknowledged = scheduleChange({ acknowledgedAt: '2026-10-24T11:30:00.000Z' });
    const replaced = scheduleChange({ supersededByNotificationId: change.notificationId });
    const promo = notice({ category: 'promotional', kind: 'team_invitation' });
    expect(needsAction(change as never, TEST_NOW)).toBe(true);
    expect(needsAction(acknowledged as never, TEST_NOW)).toBe(false);
    expect(needsAction(replaced as never, TEST_NOW)).toBe(false);
    expect(needsAction(promo as never, TEST_NOW)).toBe(false);
    expect(needsAction(notice({ kind: 'team_invitation' }) as never, TEST_NOW)).toBe(true);

    const a = notice({ deliveredAt: '2026-10-24T11:00:00.000Z' });
    const b = notice({ deliveredAt: '2026-10-23T18:00:00.000Z' });
    const c = notice({ deliveredAt: '2026-10-24T10:00:00.000Z' });
    const days = inboxSections([a, b, c] as never, 'all', TEST_NOW, ZONE);
    expect(days.map((d) => [d.title, d.data.map((i) => i.attemptId)])).toEqual([
      ['Today', [a.attemptId, c.attemptId]],
      ['Yesterday', [b.attemptId]],
    ]);
    expect(dayTitle('2026-10-21T18:00:00.000Z', TEST_NOW, ZONE)).toBe('Wed, Oct 21');
  });
});

describe('SCR-C-06 opening a notice (SPK-COMMS-004, PA-11)', () => {
  it('SPK-COMMS-004: a row about a game opens the game and marks the notice read, with its revision and an idempotency key', async () => {
    const item = notice({
      kind: 'result_published',
      title: 'Result published',
      subject: { type: 'fixture', id: FIXTURE },
      revision: 3,
    });
    const app = createTestApp({
      routes: {
        'GET /me/inbox': page([item]),
        'POST /me/inbox/{id}/read': () =>
          fakeResponse(200, { ...item, readAt: '2026-10-24T12:00:00.000Z', revision: 4 }),
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    const row = await screen.findByRole('button', { name: 'Result published, Unread' });
    expect(row).toHaveProp('accessibilityHint', 'Opens what this notice is about');
    await act(async () => {
      fireEvent.press(row);
    });
    expect(mockPush).toHaveBeenCalledWith(`/fixtures/${FIXTURE}`);
    // The record opens instead of the notice: no sheet.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/inbox/{id}/read')).toHaveLength(1),
    );
    const read = app.fake.requests.find((r) => r.route === '/me/inbox/{id}/read');
    expect(read?.params.id).toBe(item.attemptId);
    expect(read?.body).toEqual({ expectedRevision: 3 });
    expect(read?.headers['idempotency-key']).toMatch(/^key-/);
    expect(openSubjectLabel(item as never)).toBe('Open the game');
  });

  it('a row about a game already read opens it without sending anything', async () => {
    const item = notice({
      title: 'Result published',
      subject: { type: 'fixture', id: FIXTURE },
      readAt: '2026-10-24T11:30:00.000Z',
    });
    const app = createTestApp({ routes: { 'GET /me/inbox': page([item]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Result published, Read' }));
    expect(mockPush).toHaveBeenCalledWith(`/fixtures/${FIXTURE}`);
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('§4.9: a notice without a record of its own opens in a sheet titled with the notice, where "Acknowledge" sends the newest revision under one key', async () => {
    const item = notice({ title: 'Bring water', readAt: '2026-10-24T11:30:00.000Z', revision: 2 });
    let current: Record<string, unknown> = { ...item };
    const app = createTestApp({
      routes: {
        'GET /me/inbox': () => fakeResponse(200, { items: [current], nextCursor: null }),
        'POST /me/inbox/{id}/acknowledge': () => {
          current = { ...current, acknowledgedAt: '2026-10-24T12:01:00.000Z', revision: 3 };
          return fakeResponse(200, current);
        },
      },
    });
    render(<InboxScreen />, { wrapper: app.wrapper });
    const row = await screen.findByRole('button', { name: 'Bring water, Read' });
    expect(row).toHaveProp('accessibilityHint', 'Opens the notice');
    fireEvent.press(row);
    const sheet = await waitFor(() => openSheet(screen));
    expect(within(sheet).getByRole('header', { name: 'Bring water' })).toBeOnTheScreen();
    expect(within(sheet).getByText('Something from the facility.')).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.press(within(sheet).getByRole('button', { name: 'Acknowledge' }));
    expect(await within(openSheet(screen)).findByLabelText('Acknowledged')).toBeOnTheScreen();
    const acks = app.fake.requests.filter((r) => r.route === '/me/inbox/{id}/acknowledge');
    expect(acks).toHaveLength(1);
    expect(acks[0]?.params.id).toBe(item.attemptId);
    expect(acks[0]?.body).toEqual({ expectedRevision: 2 });
    expect(acks[0]?.headers['idempotency-key']).toMatch(/^key-/);
    expect(
      await screen.findByRole('button', { name: 'Bring water, Acknowledged' }),
    ).toBeOnTheScreen();

    fireEvent.press(within(openSheet(screen)).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(screen.queryByRole('header', { name: 'Bring water' })).toBeNull();
  });
});

describe('SCR-C-06 empty inbox and refresh (SPK-UX-008, ADR-008)', () => {
  it('the empty inbox shows the empty-inbox illustration, hidden from screen readers, under its title', async () => {
    const app = createTestApp({ routes: { 'GET /me/inbox': page([]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No notifications' })).toBeOnTheScreen();
    const empty = screen.getByTestId('inbox-empty');
    const image = within(empty).UNSAFE_getByType(Image);
    expect(image.props.source).toBe(illustrations['empty-inbox']);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('pull to refresh reads the notices again', async () => {
    const app = createTestApp({ routes: { 'GET /me/inbox': page([notice({ title: 'Kit' })]) } });
    render(<InboxScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Kit')).toBeOnTheScreen();
    const reads = app.fake.requests.filter((r) => r.route === '/me/inbox').length;
    await pullToRefresh(screen);
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/inbox').length).toBeGreaterThan(
        reads,
      ),
    );
  });
});
