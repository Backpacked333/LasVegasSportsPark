/**
 * SCR-C-03 Home and the SCR-C-04 next-activity card on it (SPK-UX-002, SPK-UX-003, SPK-UX-004,
 * SPK-COMMS-005, SPK-UX-008, SPK-UX-009, §4.10, §4.15).
 */
import { fakeResponse, apiErrorBody, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  BOOKING_ITEM,
  calendar,
  calendarItem,
  CHILD,
  ENROLLMENT,
  ENROLLMENT_PENDING,
  enrollment,
  enrollmentsPage,
  fail,
  GUARDIAN_OF_CHILD,
  inboxPage,
  me,
  notice,
  ok,
  OFFERING_TWO,
  offering,
  person,
  PLACEMENT,
  scheduleChange,
  SELF,
  session,
  BASKET,
  checkoutBasket,
  checkoutOrder,
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

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /me/inbox': inboxPage([]),
    'GET /me/family-calendar': ok(calendar([calendarItem(), BOOKING_ITEM])),
    'GET /enrollments': enrollmentsPage([]),
    'GET /people/{id}': (req) =>
      req.params.id === CHILD
        ? fakeResponse(200, person(CHILD, 'Sam'))
        : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    'GET /offerings/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === OFFERING_TWO
          ? offering(OFFERING_TWO, 'Adult Pickup Night', null)
          : offering(),
      ),
    'GET /offerings/{id}/sessions': ok([session()]),
    'GET /enrollments/{id}': ok(enrollment()),
    ...overrides,
  };
}

/** testIDs in document order, to assert the SPK-UX-003 order. */
interface JsonNode {
  props?: { testID?: unknown };
  children?: unknown[] | null;
}
function order(ids: string[]): string[] {
  const seen: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { props, children } = node as JsonNode;
    const id = props?.testID;
    if (typeof id === 'string' && ids.includes(id) && !seen.includes(id)) seen.push(id);
    (children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return seen;
}

beforeEach(() => mockPush.mockClear());

describe('SCR-C-03 Home', () => {
  it('SPK-UX-003: recovery pinned first, then urgent changes, next activity, actions, invitations, results, renewals', async () => {
    // The real shape: the API leaves lastOperationId null while a checkout runs; the state comes
    // from the enrollment's basket and the basket's order.
    const pending = enrollment({
      id: ENROLLMENT_PENDING,
      status: 'pending',
      lastOperationId: null,
      basketId: BASKET,
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([
          notice({ kind: 'renewal_opportunity', title: 'Renew for spring' }),
          notice({ kind: 'result_published', title: 'Result: Lions 2, Tigers 1' }),
          notice({ kind: 'team_invitation', title: 'Join the Lions' }),
          notice({ kind: 'payment_attention', title: 'Installment due' }),
          scheduleChange(),
          notice({ kind: 'renewal_opportunity', category: 'promotional', title: 'Shop sale' }),
        ]),
        'GET /enrollments': (req) =>
          fakeResponse(200, {
            items: req.query.participantPersonId === CHILD ? [pending] : [],
            nextCursor: null,
          }),
        'GET /baskets/{id}': ok(checkoutBasket('fulfilled')),
        'GET /orders/{id}': ok(checkoutOrder('recovery_required')),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });

    expect(await screen.findByText('Renew for spring')).toBeOnTheScreen();
    expect(await screen.findByTestId('home-recovery')).toBeOnTheScreen();
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    expect(
      order([
        'home-recovery',
        'home-urgent',
        'home-next',
        'home-actions',
        'home-invitations',
        'home-results',
        'home-renewals',
      ]),
    ).toEqual([
      'home-recovery',
      'home-urgent',
      'home-next',
      'home-actions',
      'home-invitations',
      'home-results',
      'home-renewals',
    ]);
    // Marketing never appears on Home; it stays in the inbox.
    expect(screen.queryByText('Shop sale')).toBeNull();
    // The pinned registration names the participant and says not to pay again.
    const recovery = screen.getByTestId('home-recovery');
    expect(
      within(recovery).getByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(within(recovery).getByText(/Do not pay again/)).toBeOnTheScreen();
    expect(within(recovery).getByText('For: Sam')).toBeOnTheScreen();
  });

  it('a registration whose payment is running is "Payment processing", and one whose checkout cannot be read is not an action', async () => {
    const running = enrollment({
      id: ENROLLMENT_PENDING,
      status: 'pending',
      lastOperationId: null,
      basketId: BASKET,
    });
    const app = createTestApp({
      routes: routes({
        'GET /enrollments': (req) =>
          fakeResponse(200, {
            items: req.query.participantPersonId === CHILD ? [running] : [],
            nextCursor: null,
          }),
        'GET /baskets/{id}': ok(checkoutBasket('checking_out', null)),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('home-in-progress');
    expect(within(section).getAllByLabelText(/Payment processing/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('home-actions')).toBeNull();
    expect(screen.queryByTestId('home-recovery')).toBeNull();
  });

  it('SPK-UX-004: the next-activity card shows participant, activity, place, time with zone, status and the change as old and new', async () => {
    // The session moved from 10:00 on Pitch 1 to 11:00 on Pitch 2; the calendar has the new time.
    const moved = { start: '2026-10-24T18:00:00.000Z', end: '2026-10-24T19:00:00.000Z' };
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([scheduleChange()]),
        'GET /me/family-calendar': ok(calendar([calendarItem(moved)])),
        'GET /offerings/{id}/sessions': ok([
          session({ scheduledStart: moved.start, scheduledEnd: moved.end }),
        ]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(
      await within(card).findByLabelText(
        'For: Sam. When: Sat, Oct 24, 11:00 AM to 12:00 PM PDT. Where: Pitch 2',
      ),
    ).toBeOnTheScreen();
    expect(within(card).getByRole('header', { name: 'Junior Skills' })).toBeOnTheScreen();
    expect(within(card).getByLabelText('Confirmed')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(
        'Changed. Was: Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1. Now: Sat, Oct 24, 11:00 AM to 12:00 PM PDT at Pitch 2',
      ),
    ).toBeOnTheScreen();
    // Facility zone known from the notice: no device-zone caveat.
    expect(screen.queryByText(/device's time zone/)).toBeNull();
  });

  it('SPK-UX-004: "Confirmed, awaiting placement" is distinct from "Confirmed" on the card', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}': ok(enrollment({ placementRequestId: PLACEMENT })),
        'GET /placement-requests/{id}': ok({ id: PLACEMENT, status: 'unassigned' }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Confirmed in Junior Skills. Awaiting placement.'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Confirmed')).toBeNull();
    // Without the facility's zone the card says the times are on the device clock.
    expect(screen.getByText(/Times are in this device's time zone \(PDT\)/)).toBeOnTheScreen();
  });

  it('opens a notice in the inbox and the activity detail from the card', async () => {
    const urgent = scheduleChange();
    const app = createTestApp({ routes: routes({ 'GET /me/inbox': inboxPage([urgent]) }) });
    render(<HomeScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: /Schedule changed: Junior Skills/ }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/inbox',
      params: { open: urgent.attemptId },
    });
    fireEvent.press(screen.getByRole('button', { name: 'View details' }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/sessions/[sessionId]',
      params: { sessionId: calendarItem().sessionId, enrollmentId: ENROLLMENT },
    });
  });

  it('shows the empty state with Discover when nothing is scheduled and nothing is needed', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })) }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Nothing scheduled yet' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open Discover' }));
    expect(mockPush).toHaveBeenCalledWith('/discover');
    expect(screen.queryByTestId('next-activity-card')).toBeNull();
  });

  it('shows the API error code and a retry for the next activity while the other sections still load', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': fail(
          503,
          'INTEGRATION_UNAVAILABLE',
          'Scheduling is unavailable.',
        ),
        'GET /me/inbox': inboxPage([
          notice({ kind: 'payment_attention', title: 'Installment due' }),
        ]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Scheduling is unavailable.')).toBeOnTheScreen();
    expect(
      screen.getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-1/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(await screen.findByText('Installment due')).toBeOnTheScreen();
  });

  it('§4.10: a child the person may no longer view is left out, and a missing account read is "not available"', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments': (req) =>
          req.query.participantPersonId === CHILD
            ? fakeResponse(404, apiErrorBody('NOT_FOUND'))
            : fakeResponse(200, {
                items: [
                  enrollment({
                    id: ENROLLMENT_PENDING,
                    participantPersonId: SELF,
                    status: 'pending',
                  }),
                ],
                nextCursor: null,
              }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Registration pending')).toBeOnTheScreen();
    expect(screen.getByText('For: You')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();

    const denied = createTestApp({ routes: { 'GET /me': fail(404, 'NOT_FOUND') } });
    screen.unmount();
    render(<HomeScreen />, { wrapper: denied.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('§4.15: offline, keeps what was loaded and says how old it is', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    now = new Date('2026-10-24T12:45:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByLabelText('You are offline')).toBeOnTheScreen();
    expect(screen.getByText(/Showing information from 45 minutes ago\./)).toBeOnTheScreen();
    expect(screen.getByTestId('next-activity-card')).toBeOnTheScreen();
  });

  it('asks a signed-out person to sign in and sends no request', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show facility pass' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('SPK-UX-009: quick access and the unread count are labelled, and status is never colour alone', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([notice(), notice({ readAt: '2026-10-24T11:30:00.000Z' })]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(screen.getByRole('button', { name: 'Show facility pass' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open notifications' })).toBeOnTheScreen();
    expect(await screen.findByLabelText('1 unread')).toBeOnTheScreen();
    const status = await screen.findByTestId('next-activity-card-status');
    expect(status).toHaveProp('accessibilityLabel', 'Confirmed');
    expect(within(status).getByText('✓', { includeHiddenElements: true })).toBeOnTheScreen();
  });
});
