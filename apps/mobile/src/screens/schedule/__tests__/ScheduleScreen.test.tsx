/**
 * SCR-C-18 Schedule (SPK-UX-002, SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005, SPK-YOUTH-007,
 * SPK-UX-008, SPK-UX-009, §4.10, §4.15).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  BOOKING,
  BOOKING_ITEM,
  calendar,
  calendarItem,
  CHILD,
  enrollment,
  fail,
  GUARDIAN_OF_CHILD,
  inboxPage,
  me,
  ok,
  offering,
  person,
  scheduleChange,
  SELF,
  session,
  SESSION_TWO,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { ScheduleScreen } from '../ScheduleScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const LATER = calendarItem({
  id: 'enrollment:later',
  title: 'Junior Skills',
  start: '2026-11-28T18:00:00.000Z',
  end: '2026-11-28T19:00:00.000Z',
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /me/inbox': inboxPage([]),
    'GET /me/family-calendar': (req) =>
      fakeResponse(
        200,
        req.query.from === '2026-10-24T07:00:00.000Z'
          ? calendar([calendarItem(), BOOKING_ITEM])
          : calendar([LATER]),
      ),
    'GET /people/{id}': (req) =>
      req.params.id === CHILD
        ? fakeResponse(200, person(CHILD, 'Sam'))
        : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([session()]),
    'GET /enrollments/{id}': ok(enrollment()),
    ...overrides,
  };
}

beforeEach(() => mockPush.mockClear());

describe('SCR-C-18 ScheduleScreen', () => {
  it('SPK-SCHED-008: lists activities by local day with the time zone, participant and status', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const day = await screen.findByTestId('day-2026-10-24');
    expect(within(day).getByRole('header', { name: 'Sat, Oct 24' })).toBeOnTheScreen();
    // Participant names come from their own reads: wait for them (deterministic, no race).
    expect(
      await within(day).findByRole('button', {
        name: 'Junior Skills, 10:00 AM to 11:00 AM PDT. For: Sam, Confirmed',
      }),
    ).toBeOnTheScreen();
    expect(
      await within(day).findByRole('button', {
        name: 'Adult Pickup Night, 6:00 PM to 7:30 PM PDT. For: You, Booking pending',
      }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('zone-notice')).toHaveTextContent(
      "In the list below: Times are in this device's time zone (PDT). The facility's time zone is not provided to the app yet.",
    );
    // The next-activity card (SCR-C-04) sits on top, with its own zone caption (SPK-SCHED-008).
    expect(await screen.findByTestId('schedule-next')).toBeOnTheScreen();
    expect(await screen.findByTestId('schedule-next-zone')).toHaveTextContent(/time zone/);
    const request = app.fake.requests.find((r) => r.route === '/me/family-calendar');
    expect(request?.query).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-11-21T08:00:00.000Z',
    });
  });

  it('SPK-COMMS-005: shows published changes and cancellations as old and new details', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([
          scheduleChange(),
          scheduleChange({
            kind: 'cancellation',
            title: 'Canceled: Junior Skills',
            detailsAfter: null,
            subject: { type: 'event', id: 'another-event' },
          }),
        ]),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const changes = await screen.findByTestId('schedule-changes');
    expect(
      within(changes).getByLabelText(
        'Changed. Was: Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1. Now: Sat, Oct 24, 11:00 AM to 12:00 PM PDT at Pitch 2',
      ),
    ).toBeOnTheScreen();
    expect(
      within(changes).getByLabelText(
        'Canceled. Was: Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1. Now: Canceled',
      ),
    ).toBeOnTheScreen();
  });

  it('loads the following weeks as another window while the first stays on screen', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Show the following 28 days' }));
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
    expect(await screen.findByTestId('day-2026-11-28')).toBeOnTheScreen();
    const windows = app.fake.requests
      .filter((r) => r.route === '/me/family-calendar')
      .map((r) => r.query.from);
    expect(windows).toEqual(['2026-10-24T07:00:00.000Z', '2026-11-21T08:00:00.000Z']);
  });

  it('offers the family calendar only when the API shares family members, and opens activities', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Open family calendar' }));
    expect(mockPush).toHaveBeenLastCalledWith('/family-calendar');
    fireEvent.press(screen.getByRole('button', { name: /^Adult Pickup Night/ }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/sessions/[sessionId]',
      params: { sessionId: SESSION_TWO, bookingId: BOOKING },
    });

    screen.unmount();
    const solo = createTestApp({
      routes: routes({
        'GET /me': ok(me()),
        'GET /me/family-calendar': ok(calendar([BOOKING_ITEM], { participants: [SELF] })),
      }),
    });
    render(<ScheduleScreen />, { wrapper: solo.wrapper });
    expect(await screen.findByRole('button', { name: /^Adult Pickup Night/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Open family calendar' })).toBeNull();
  });

  it('shows the empty state with Discover', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })) }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No activities' })).toBeOnTheScreen();
    expect(screen.getByText(/Nothing is scheduled for you before Sat, Nov 21\./)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open Discover' }));
    expect(mockPush).toHaveBeenCalledWith('/discover');
  });

  it('shows the error code with a retry, and NOT_FOUND as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': fail(
          503,
          'INTEGRATION_UNAVAILABLE',
          'Scheduling is unavailable.',
        ),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();

    screen.unmount();
    const hidden = createTestApp({
      routes: routes({ 'GET /me/family-calendar': fail(404, 'NOT_FOUND') }),
    });
    render(<ScheduleScreen />, { wrapper: hidden.wrapper });
    expect(await screen.findByText('Your schedule is not available right now.')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('§4.15: keeps the cached schedule offline with its age', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    now = new Date('2026-10-24T13:00:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByText(/Showing information from 1 hour ago\./)).toBeOnTheScreen();
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
  });
});
