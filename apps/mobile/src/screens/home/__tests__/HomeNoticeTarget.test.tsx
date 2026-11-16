/**
 * PA-11 SPK-UX-003 (**Proposed**): a Home notice row opens the item it is about and sends the same
 * "read" request the inbox sends on opening a notice (`POST /v1/me/inbox/{id}/read`, one
 * idempotency key, the revision the list showed, SPK-COMMS-004). A notice without a screen of its
 * own still opens in the inbox, which marks it read itself.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  calendar,
  CHILD,
  enrollmentsPage,
  GUARDIAN_OF_CHILD,
  inboxPage,
  me,
  names,
  notice,
  ok,
  scheduleChange,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { HomeScreen } from '../HomeScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const OBLIGATION = '0192f1a0-0000-7000-8000-00000000b0b1';

function renderHome(items: unknown[]) {
  const app = createTestApp({
    routes: {
      'GET /me': ok(me(GUARDIAN_OF_CHILD)),
      'GET /me/inbox': inboxPage(items),
      'GET /me/family-calendar': ok(calendar([])),
      'GET /enrollments': enrollmentsPage([]),
      'GET /person-names': names({ [CHILD]: 'Sam' }),
      'GET /me/fixtures': ok([]),
      'GET /me/team-entries': ok([]),
      'GET /me/registration-checkouts': ok({ items: [], nextCursor: null }),
      'POST /me/inbox/{id}/read': (req) =>
        fakeResponse(200, {
          ...(items[0] as object),
          readAt: '2026-10-24T12:00:00.000Z',
          id: req.params.id,
        }),
    },
  });
  render(<HomeScreen />, { wrapper: app.wrapper });
  return app;
}

const amountDue = (overrides: Record<string, unknown> = {}) =>
  notice({
    kind: 'payment_attention',
    title: 'Amount due: Junior Skills',
    body: '40.00 is due on Saturday.',
    subject: { type: 'obligation', id: OBLIGATION },
    revision: 3,
    ...overrides,
  });

beforeEach(() => mockPush.mockClear());

describe('SCR-C-03 Home: notice rows open their item (PA-11 SPK-UX-003)', () => {
  it('a row opens the item it is about and sends the inbox "read" request once, with a key and the revision', async () => {
    const item = amountDue();
    const app = renderHome([item]);
    const row = await screen.findByRole('button', { name: /^Amount due: Junior Skills/ });
    expect(row).toHaveProp('accessibilityHint', 'Opens what this notice is about');
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith(`/payments/${OBLIGATION}`);
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/inbox/{id}/read')).toHaveLength(1),
    );
    const read = app.fake.requests.find((r) => r.route === '/me/inbox/{id}/read');
    expect(read?.method).toBe('POST');
    expect(read?.params.id).toBe(item.attemptId);
    expect(read?.headers['idempotency-key']).toMatch(/^key-/);
    expect(read?.body).toEqual({ expectedRevision: 3 });
  });

  it('a notice already read opens its item without another "read" request', async () => {
    const app = renderHome([amountDue({ readAt: '2026-10-24T11:30:00.000Z' })]);
    fireEvent.press(await screen.findByRole('button', { name: /^Amount due: Junior Skills/ }));
    expect(mockPush).toHaveBeenLastCalledWith(`/payments/${OBLIGATION}`);
    expect(app.fake.requests.some((r) => r.route === '/me/inbox/{id}/read')).toBe(false);
  });

  it('offline, the row still opens its item and sends nothing, as the inbox does', async () => {
    const app = renderHome([amountDue()]);
    const row = await screen.findByRole('button', { name: /^Amount due: Junior Skills/ });
    act(() => app.sources.setReachable(false));
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith(`/payments/${OBLIGATION}`);
    expect(app.fake.requests.some((r) => r.route === '/me/inbox/{id}/read')).toBe(false);
  });

  it('a notice without a screen of its own opens in the inbox, which marks it read itself', async () => {
    const urgent = scheduleChange();
    const app = renderHome([urgent]);
    const row = await screen.findByRole('button', { name: /Schedule changed: Junior Skills/ });
    expect(row).toHaveProp('accessibilityHint', 'Opens the notice in your notifications');
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/inbox',
      params: { open: urgent.attemptId },
    });
    expect(app.fake.requests.some((r) => r.route === '/me/inbox/{id}/read')).toBe(false);
  });
});
