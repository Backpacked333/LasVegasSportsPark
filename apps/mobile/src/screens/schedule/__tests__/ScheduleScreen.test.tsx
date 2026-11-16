/**
 * SCR-C-18 Calendar (SPK-UX-002, SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005, SPK-YOUTH-007,
 * SPK-UX-008, SPK-UX-009, §4.10, §4.15), which absorbs SCR-C-19 Family calendar (PA-11, ADR-008;
 * SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007, SPK-SCHED-008, SPK-PLACE-004, §4.14). The family
 * calendar's tests moved here with their requirement names.
 */
import { apiQueryKey } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { calendarWindowQuery } from '../../../features/today/calendar';
import {
  BOOKING,
  BOOKING_ITEM,
  calendar,
  calendarItem,
  CHILD,
  CHILD_TWO,
  enrollment,
  fail,
  GUARDIAN_OF_CHILD,
  inboxPage,
  LA,
  me,
  ok,
  offering,
  names,
  facility,
  fixtureDetail,
  myTeamEntry,
  DENVER,
  FIXTURE,
  scheduleChange,
  SELF,
  session,
  SESSION_TWO,
} from '../../../features/today/__tests__/fixtures';
import {
  SCHEDULE_WINDOW_DAYS,
  useCalendarWindow,
  useMyFixtures,
} from '../../../features/today/queries';
import { createTestApp, mePermissions, settleQueries, TEST_NOW } from '../../../testing/test-app';
import { openSheet } from '../../../testing/ui';
import { openSupportDetails, pullToRefresh } from '../../../testing/ui-surfaces';
import { ScheduleScreen } from '../ScheduleScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

/** Home's 28-day look-ahead (window 0) and the window before it, both cut at LA midnight. */
const WINDOW_0 = { from: '2026-10-24T07:00:00.000Z', to: '2026-11-21T08:00:00.000Z' };
const WINDOW_BEFORE = { from: '2026-09-26T07:00:00.000Z', to: '2026-10-24T07:00:00.000Z' };
const WINDOW_1 = { from: '2026-11-21T08:00:00.000Z', to: '2026-12-19T08:00:00.000Z' };

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
        req.query.from === WINDOW_0.from
          ? calendar([calendarItem(), BOOKING_ITEM])
          : req.query.from === WINDOW_1.from
            ? calendar([LATER])
            : calendar([]),
      ),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /facilities/{id}': ok(facility()),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([session()]),
    'GET /enrollments/{id}': ok(enrollment()),
    ...overrides,
  };
}

/** Presses "Next week" `times` times. */
function nextWeek(times = 1) {
  for (let i = 0; i < times; i += 1) {
    fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
  }
}

function calendarFroms(app: ReturnType<typeof createTestApp>) {
  return app.fake.requests.filter((r) => r.route === '/me/family-calendar').map((r) => r.query);
}

beforeEach(() => {
  mockPush.mockClear();
  mockParams = {};
});

describe('SCR-C-18 Calendar (ScheduleScreen)', () => {
  it('SPK-SCHED-008: lists activities by local day with the time zone, participant and status', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const day = await screen.findByTestId('day-2026-10-24');
    expect(screen.getByRole('header', { name: 'Sat, Oct 24' })).toBeOnTheScreen();
    // Participant names come from their own reads: wait for them (deterministic, no race). The
    // next activity (SCR-C-04) is marked on its row, on the facility clock too (SPK-SCHED-008).
    expect(
      await within(day).findByRole('button', {
        name: 'Junior Skills, 10:00 AM to 11:00 AM PDT. For: Sam, Confirmed, Next up',
      }),
    ).toBeOnTheScreen();
    expect(
      await within(day).findByRole('button', {
        name: 'Adult Pickup Night, 6:00 PM to 7:30 PM PDT. For: You. Pickup session, Booking pending',
      }),
    ).toBeOnTheScreen();
    // Every item states its facility's zone (ENR-02): no device-clock caveat anywhere.
    expect(screen.queryByTestId('zone-notice')).toBeNull();
    const request = app.fake.requests.find((r) => r.route === '/me/family-calendar');
    expect(request?.query).toEqual(WINDOW_0);
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

  it('PA-11: moves week by week; a week past the first 28 days reads the next window, and weeks already read stay cached', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    // This week (Monday 19 to Sunday 25 October) starts before today: it reads the window before
    // Home's look-ahead too, Home's window first.
    await waitFor(() => expect(calendarFroms(app)).toEqual([WINDOW_0, WINDOW_BEFORE]));
    nextWeek(5);
    expect(await screen.findByTestId('day-2026-11-28')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'November 2026' })).toBeOnTheScreen();
    expect(calendarFroms(app)).toEqual([WINDOW_0, WINDOW_BEFORE, WINDOW_1]);
    // Back to today: the week already read shows straight away from the cache.
    fireEvent.press(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
  });

  it('PA-11 SCR-C-19: offers the person chips only when the API shares family members, and opens activities', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const people = await screen.findByLabelText('Show activities for');
    expect(within(people).getByRole('button', { name: 'Everyone' })).toBeSelected();
    expect(within(people).getByRole('button', { name: 'You' })).toBeOnTheScreen();
    expect(await within(people).findByRole('button', { name: 'Sam' })).toBeOnTheScreen();
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
    expect(screen.queryByLabelText('Show activities for')).toBeNull();
    // Nothing about family for a person without one, unless the link asked for everyone.
    expect(screen.queryByTestId('family-only-self')).toBeNull();
    expect(screen.queryByTestId('schedule-collecting')).toBeNull();
  });

  it('shows the empty state with Explore', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })) }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'No activities this week' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Nothing is scheduled for you this week. Find leagues, classes and camps in Explore.',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Explore activities' }));
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
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();

    screen.unmount();
    const hidden = createTestApp({
      routes: routes({ 'GET /me/family-calendar': fail(404, 'NOT_FOUND') }),
    });
    render(<ScheduleScreen />, { wrapper: hidden.wrapper });
    expect(await screen.findByText('Your calendar is not available right now.')).toBeOnTheScreen();
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

  it("PA-11: the current week reuses Home's 28-day look-ahead: one cached read under the same key", async () => {
    /** Home's reads exactly as HomeScreen makes them (features/today/queries). */
    function HomeLookAhead() {
      useCalendarWindow(TEST_NOW, SCHEDULE_WINDOW_DAYS, LA);
      useMyFixtures(calendarWindowQuery(TEST_NOW, 0, SCHEDULE_WINDOW_DAYS, LA));
      return null;
    }
    const app = createTestApp({ routes: routes() });
    render(
      <>
        <HomeLookAhead />
        <ScheduleScreen />
      </>,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    await settleQueries(app.queryClient);
    const window0 = (route: string) =>
      app.fake.requests.filter((r) => r.route === route && r.query.from === WINDOW_0.from);
    expect(window0('/me/family-calendar')).toHaveLength(1);
    expect(window0('/me/fixtures')).toHaveLength(1);
    expect(
      app.queryClient.getQueryData(apiQueryKey('/me/family-calendar', { query: WINDOW_0 })),
    ).toBeDefined();
  });

  it('pull to refresh reads the shown week again', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    await settleQueries(app.queryClient);
    const reads = (route: string) => app.fake.requests.filter((r) => r.route === route).length;
    const before = { calendar: reads('/me/family-calendar'), games: reads('/me/fixtures') };
    await pullToRefresh(screen);
    await waitFor(() => expect(reads('/me/family-calendar')).toBe(before.calendar + 2));
    expect(reads('/me/fixtures')).toBe(before.games + 2);
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
  });

  it('the day strip selects a day, today first, and names the days with activities', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', { name: 'Saturday 24 October, today, has activities' }),
    ).toBeSelected();
    const sunday = screen.getByRole('button', { name: 'Sunday 25 October' });
    fireEvent.press(sunday);
    expect(sunday).toBeSelected();
    expect(
      screen.getByRole('button', { name: 'Saturday 24 October, today, has activities' }),
    ).not.toBeSelected();
  });
});

describe('SCR-C-18 Schedule: fixtures and facility clocks (CMP-02, SPK-SCHED-008)', () => {
  /** Lions vs Tigers on Sunday 10:00 in Denver (16:00Z), after the Saturday activities. */
  const AWAY_GAME = fixtureDetail({
    scheduledStart: '2026-10-25T16:00:00.000Z',
    scheduledEnd: '2026-10-25T17:30:00.000Z',
    venue: {
      facilityId: '0192f1a0-0000-7000-8000-00000000b802',
      facilityName: 'North Complex',
      timezone: DENVER,
      resources: [{ id: '0192f1a0-0000-7000-8000-00000000b709', name: 'Field 1' }],
    },
  });

  it("lists the fixtures of the family's teams by day, on the venue's clock, and opens them", async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/fixtures': (req) =>
          fakeResponse(200, req.query.from === WINDOW_0.from ? [AWAY_GAME] : []),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const sunday = await screen.findByTestId('day-2026-10-25');
    expect(screen.getByRole('header', { name: 'Sun, Oct 25' })).toBeOnTheScreen();
    const row = await within(sunday).findByRole('button', {
      name: 'Lions vs Tigers, 10:00 AM to 11:30 AM MDT. For: Sam (Lions). At: North Complex, Field 1, Scheduled',
    });
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/fixtures/[id]',
      params: { id: FIXTURE },
    });
    expect(screen.queryByTestId('zone-notice')).toBeNull();
    // The fixtures read follows the calendar's window.
    expect(app.fake.requests.find((r) => r.route === '/me/fixtures')?.query).toEqual(WINDOW_0);
  });

  it('later windows read fixtures for the same range as the calendar', async () => {
    const app = createTestApp({ routes: routes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    nextWeek(5);
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/me/fixtures').map((r) => r.query),
      ).toEqual([WINDOW_0, WINDOW_BEFORE, WINDOW_1]),
    );
    expect(calendarFroms(app)).toEqual([WINDOW_0, WINDOW_BEFORE, WINDOW_1]);
  });

  it('an activity the API gives no zone for is on the device clock, and the list says so', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([calendarItem({ timezone: null })])),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('zone-notice')).toHaveTextContent(
      "Times are in this device's time zone (PDT). The facility's time zone was not given for this.",
    );
  });

  it("SCR-C-04, SPK-CAP-003: a game's RSVP on Calendar opens in a sheet and is sent with the answer's revision", async () => {
    const answered = fixtureDetail({
      responses: [
        { personId: SELF, state: 'unavailable', revision: 2, respondedAt: '2026-10-23T12:00:00Z' },
      ],
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/fixtures': (req) =>
          fakeResponse(200, req.query.from === WINDOW_0.from ? [answered] : []),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
        'POST /fixtures/{id}/availability': ok({
          id: '0192f1a0-0000-7000-8000-00000000fa01',
          fixtureId: FIXTURE,
          teamEntryId: '0192f1a0-0000-7000-8000-00000000f201',
          personId: SELF,
          state: 'available',
          respondedAt: '2026-10-24T12:00:00.000Z',
          note: null,
          revision: 3,
        }),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Your availability for Lions vs Tigers: Unavailable',
      }),
    );
    const sheet = await waitFor(() => openSheet(screen));
    expect(within(sheet).getByRole('header', { name: 'Lions vs Tigers' })).toBeOnTheScreen();
    // A named radio group (a container, so the radios stay focusable).
    expect(within(sheet).getByLabelText('Your availability for this fixture')).toHaveProp(
      'accessibilityRole',
      'radiogroup',
    );
    expect(within(sheet).getByTestId('rsvp-current')).toHaveProp(
      'accessibilityLabel',
      'Unavailable',
    );
    const reads = app.fake.requests.filter((r) => r.route === '/me/fixtures').length;
    fireEvent.press(within(sheet).getByRole('radio', { name: 'Available' }));
    expect(await within(sheet).findByTestId('rsvp-recorded')).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.route === '/fixtures/{id}/availability');
    expect(post?.body).toEqual({ state: 'available', expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    // The list that carries the answer is read again.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/fixtures').length).toBeGreaterThan(
        reads,
      ),
    );
  });

  it('SCR-C-04: on Calendar, an RSVP refused with ACCESS_DENIED is "not available", not an error', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/fixtures': (req) =>
          fakeResponse(200, req.query.from === WINDOW_0.from ? [fixtureDetail()] : []),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
        'POST /fixtures/{id}/availability': fail(403, 'ACCESS_DENIED'),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', {
        name: 'Your availability for Lions vs Tigers: No response',
      }),
    );
    const sheet = await waitFor(() => openSheet(screen));
    fireEvent.press(within(sheet).getByRole('radio', { name: 'Available' }));
    expect(await within(sheet).findByText("You can't answer for this game.")).toBeOnTheScreen();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('a fixture read that fails shows its code and "Try again"; the calendar stays', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/fixtures': fail(503, 'INTEGRATION_UNAVAILABLE') }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const failure = await screen.findByTestId('schedule-fixtures-error');
    expect(within(failure).getByText('Your team games could not be loaded.')).toBeOnTheScreen();
    await openSupportDetails(within(failure));
    expect(within(failure).getByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(within(failure).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
  });
});

/** Sam's session overlaps a swim session of Sam's at the same time on Saturday. */
const SKILLS = calendarItem();
const SWIM = calendarItem({
  id: 'enrollment:swim',
  title: 'Swim club',
  enrollmentId: '0192f1a0-0000-7000-8000-00000000d009',
  start: '2026-10-24T17:30:00.000Z',
  end: '2026-10-24T18:30:00.000Z',
});
const OVERLAP = {
  itemIds: [SKILLS.id, SWIM.id],
  personIds: [CHILD],
  start: '2026-10-24T17:30:00.000Z',
  end: '2026-10-24T18:00:00.000Z',
};
const SKILLS_ROW =
  'Junior Skills, 10:00 AM to 11:00 AM PDT. For: Sam, Confirmed, Next up, Overlaps with Swim club (Sam)';
const PICKUP_ROW =
  'Adult Pickup Night, 6:00 PM to 7:30 PM PDT. For: You. Pickup session, Booking pending';

function familyRoutes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    // The person holds view over two children, but the API includes only one in the calendar.
    'GET /me': ok(
      me([
        { subjectPersonId: CHILD, permissions: ['view'] },
        { subjectPersonId: CHILD_TWO, permissions: ['view'] },
      ]),
    ),
    'GET /me/family-calendar': (req) =>
      fakeResponse(
        200,
        req.query.from === WINDOW_0.from
          ? calendar([SKILLS, SWIM, BOOKING_ITEM], { overlaps: [OVERLAP] })
          : calendar([]),
      ),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    ...overrides,
  };
}

describe('SCR-C-19 family calendar in Calendar (PA-11)', () => {
  beforeEach(() => {
    // The old /family-calendar link redirects to Calendar with this.
    mockParams = { people: 'everyone' };
  });

  it('SPK-YOUTH-007: shows everyone the API includes in one week, with overlaps highlighted in words', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const saturday = await screen.findByTestId('day-2026-10-24');
    expect(await within(saturday).findByRole('button', { name: /^Junior Skills/ })).toHaveProp(
      'accessibilityLabel',
      SKILLS_ROW,
    );
    expect(within(saturday).getByRole('button', { name: PICKUP_ROW })).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        '1 overlapping commitment this week. Overlaps are highlighted so you can plan around them.',
      ),
    ).toBeOnTheScreen();
    // Every day of the week is shown; empty days say so.
    expect(
      within(screen.getByTestId('day-2026-10-25')).getByText('Nothing scheduled.'),
    ).toBeOnTheScreen();
    // The week runs Monday 19 to Sunday 25 October, today selected.
    expect(screen.getByRole('header', { name: 'October 2026' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Monday 19 October' })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Saturday 24 October, today, has activities' }),
    ).toBeSelected();
  });

  it('SPK-IAM-003: offers a filter only for people the API includes, and filters to one person', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const people = await screen.findByLabelText('Show activities for');
    const sam = await within(people).findByRole('button', { name: 'Sam' });
    expect(within(people).getByRole('button', { name: 'Everyone' })).toBeSelected();
    expect(within(people).getByRole('button', { name: 'You' })).toBeOnTheScreen();
    // The second child holds a grant in /me but is not in the calendar: no filter, no hint.
    expect(within(people).getAllByRole('button')).toHaveLength(3);
    fireEvent.press(sam);
    expect(sam).toBeSelected();
    expect(screen.getByRole('button', { name: /^Swim club/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Adult Pickup Night/ })).toBeNull();
  });

  it('PA-11: reads the "Everyone" link and a person id to preselect the chip', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const people = await screen.findByLabelText('Show activities for');
    expect(within(people).getByRole('button', { name: 'Everyone' })).toBeSelected();

    for (const params of [{ person: CHILD }, { people: CHILD }] as Record<string, string>[]) {
      screen.unmount();
      mockParams = params;
      const one = createTestApp({ routes: familyRoutes() });
      render(<ScheduleScreen />, { wrapper: one.wrapper });
      const chips = await screen.findByLabelText('Show activities for');
      expect(await within(chips).findByRole('button', { name: 'Sam' })).toBeSelected();
      expect(screen.getByRole('button', { name: /^Swim club/ })).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /^Adult Pickup Night/ })).toBeNull();
    }

    // Someone the API does not include falls back to everyone.
    screen.unmount();
    mockParams = { person: CHILD_TWO };
    const other = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: other.wrapper });
    const chips = await screen.findByLabelText('Show activities for');
    expect(within(chips).getByRole('button', { name: 'Everyone' })).toBeSelected();
  });

  it('moves week by week from local midnight', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('day-2026-10-24')).toBeOnTheScreen();
    nextWeek();
    expect(
      await screen.findByRole('header', { name: 'No activities this week' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'October to November 2026' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Today' }));
    // The week already loaded shows straight away from the cache while it refreshes.
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
    // The windows start at local midnight; the next week is inside Home's window, so no new read.
    expect(calendarFroms(app).slice(0, 2)).toEqual([WINDOW_0, WINDOW_BEFORE]);
    expect(calendarFroms(app).every((q) => q.from !== '2026-10-26T07:00:00.000Z')).toBe(true);
  });

  it('says when no family member is shared, and shows pickup arrangements as pending (DEC-075, DEC-005)', async () => {
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me': ok(me()),
        'GET /me/family-calendar': ok(calendar([BOOKING_ITEM], { participants: [SELF] })),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('family-only-self')).toHaveTextContent(
      'No family members are shared with you yet. A child appears here when you hold permission to view their schedule.',
    );
    expect(
      screen.getByLabelText(
        'Choosing who collects a child from a supervised session. Tell the front desk who is collecting your child.',
      ),
    ).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText('Decisions: DEC-075, DEC-005')).toBeOnTheScreen();
    expect(screen.getByText(/does not by itself allow collecting them/)).toBeOnTheScreen();
  });

  it('shows the error code, and NOT_FOUND as not available', async () => {
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me/family-calendar': fail(400, 'VALIDATION_FAILED', 'to must be after from.'),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();

    screen.unmount();
    const hidden = createTestApp({
      routes: familyRoutes({ 'GET /me/family-calendar': fail(404, 'NOT_FOUND') }),
    });
    render(<ScheduleScreen />, { wrapper: hidden.wrapper });
    expect(await screen.findByText('Your calendar is not available right now.')).toBeOnTheScreen();
    // Week navigation stays usable.
    expect(screen.getByRole('button', { name: 'Next week' })).toBeOnTheScreen();
  });
});

describe('SCR-C-19 family calendar in Calendar: pickup sessions, team fixtures and facility clocks', () => {
  beforeEach(() => {
    mockParams = { people: 'everyone' };
  });

  it('SPK-PLACE-004 (DEC-082) / ENR-15: a booked pickup session is on the calendar, labelled from its booking kind', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: PICKUP_ROW })).toBeOnTheScreen();
    // The child's name arrives with its own read (`GET /person-names`), after the calendar: wait
    // for it rather than assume the two answers landed together.
    expect(await screen.findByRole('button', { name: SKILLS_ROW })).toBeOnTheScreen();
    // The label comes from the calendar item itself: no offering is read for it.
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}')).toBe(false);
  });

  it('DEC-016, DEC-082: with pickup sessions turned off, offers no way to find more and keeps booked ones listed', async () => {
    const app = createTestApp({ routes: familyRoutes() });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: /^Adult Pickup Night/ })).toBeOnTheScreen();
    await settleQueries(app.queryClient);
    expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true);
    // No entry point while the switch is off (PA-11 SPK-UX-011); the booked one is still there.
    expect(screen.queryByRole('button', { name: 'Find pickup sessions' })).toBeNull();
    expect(screen.queryByTestId('schedule-pickup-sessions')).toBeNull();
    expect(screen.queryByLabelText('Pickup sessions turned off')).toBeNull();
    expect(screen.getByRole('button', { name: PICKUP_ROW })).toBeOnTheScreen();
  });

  it('with pickup sessions turned on, offers finding more in Explore', async () => {
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Find pickup sessions' }));
    expect(mockPush).toHaveBeenLastCalledWith('/discover');
    expect(screen.queryByLabelText('Pickup sessions turned off')).toBeNull();
  });

  it("CMP-02, SPK-YOUTH-007: a child's team fixture is on the calendar and its overlap with another commitment is marked", async () => {
    // Saturday 10:30 to 12:00 in Los Angeles: overlaps Sam's 10:00 Junior Skills session.
    const game = fixtureDetail({
      scheduledStart: '2026-10-24T17:30:00.000Z',
      scheduledEnd: '2026-10-24T19:00:00.000Z',
    });
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me/fixtures': (req) =>
          fakeResponse(200, req.query.from === WINDOW_0.from ? [game] : []),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`schedule-fixture-${FIXTURE}`);
    await waitFor(() =>
      expect(row).toHaveProp(
        'accessibilityLabel',
        'Lions vs Tigers, 10:30 AM to 12:00 PM PDT. For: Sam (Lions). At: Main Park, Pitch 3, Scheduled, Overlaps with Junior Skills (Sam), Swim club (Sam)',
      ),
    );
    expect(
      screen.getByRole('button', {
        name: 'Junior Skills, 10:00 AM to 11:00 AM PDT. For: Sam, Confirmed, Next up, Overlaps with Swim club (Sam), Lions vs Tigers (Sam)',
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        '3 overlapping commitments this week. Overlaps are highlighted so you can plan around them.',
      ),
    ).toBeOnTheScreen();
    // A child's game: the parent is not offered an answer for the child (DEC-090).
    expect(screen.queryByRole('button', { name: /^Your availability for/ })).toBeNull();
    // The per-person filter keeps the child's fixture and drops the adult's booking.
    fireEvent.press(screen.getByRole('button', { name: 'Sam' }));
    expect(screen.getByTestId(`schedule-fixture-${FIXTURE}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Adult Pickup Night/ })).toBeNull();
    fireEvent.press(screen.getByTestId(`schedule-fixture-${FIXTURE}`));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/fixtures/[id]',
      params: { id: FIXTURE },
    });
    expect(app.fake.requests.find((r) => r.route === '/me/fixtures')?.query).toEqual(WINDOW_0);
  });

  it('SPK-SCHED-008: an activity without a facility zone is on the device clock, and the screen says so', async () => {
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me/family-calendar': ok(calendar([calendarItem({ timezone: null })])),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        "Times are in this device's time zone (PDT). The facility's time zone was not given for this.",
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-SCHED-008: the days are laid out on the facility clock when every activity shares one', async () => {
    // 00:30 on Sunday in Denver is still 23:30 on Saturday on the device (Los Angeles). Every
    // activity is on Denver's clock, so the days are too, and it is on Sunday.
    const late = calendarItem({
      id: 'enrollment:late',
      title: 'Night futsal',
      start: '2026-10-25T06:30:00.000Z',
      end: '2026-10-25T07:30:00.000Z',
      timezone: DENVER,
    });
    const app = createTestApp({
      routes: familyRoutes({
        'GET /me/family-calendar': ok(calendar([late])),
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const sunday = await screen.findByTestId('day-2026-10-25');
    expect(
      await within(sunday).findByRole('button', {
        name: 'Night futsal, 12:30 AM to 1:30 AM MDT. For: Sam, Confirmed, Next up',
      }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('zone-notice')).toBeNull();
  });

  it('§4.15: the age shown covers the fixtures and team reads too, not only the calendar', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    let teamReads = 0;
    const app = createTestApp({
      now: () => now,
      routes: familyRoutes({
        'GET /me/fixtures': ok([fixtureDetail()]),
        'GET /me/team-entries': () => {
          teamReads += 1;
          return fakeResponse(200, [myTeamEntry({ members: [CHILD] })]);
        },
      }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('schedule-content')).toBeOnTheScreen();
    await waitFor(() => expect(teamReads).toBe(1));
    // Forty minutes later the calendar alone is read again; the fixtures and teams are not.
    now = new Date('2026-10-24T12:40:00.000Z');
    await act(async () => {
      await app.queryClient.refetchQueries({ queryKey: ['api', '/me/family-calendar'] });
    });
    expect(await screen.findByText(/40 minutes ago/)).toBeOnTheScreen();
  });

  it('a team fixture read that fails shows its code; the calendar stays', async () => {
    const app = createTestApp({
      routes: familyRoutes({ 'GET /me/fixtures': fail(500, 'INTERNAL_ERROR') }),
    });
    render(<ScheduleScreen />, { wrapper: app.wrapper });
    const failure = await screen.findByTestId('schedule-fixtures-error');
    await openSupportDetails(within(failure));
    expect(within(failure).getByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByTestId('day-2026-10-24')).toBeOnTheScreen();
  });
});
