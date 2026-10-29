/**
 * SCR-C-19 Family calendar (SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007, SPK-SCHED-008,
 * SPK-UX-008, SPK-UX-009, §4.10, §4.14).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  BOOKING_ITEM,
  calendar,
  calendarItem,
  CHILD,
  CHILD_TWO,
  fail,
  me,
  ok,
  names,
  offering,
  OFFERING_TWO,
  fixtureDetail,
  myTeamEntry,
  FIXTURE,
  SELF,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { FamilyCalendarScreen } from '../FamilyCalendarScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

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

const PICKUP_OFFERING = { ...offering(OFFERING_TWO, 'Adult Pickup Night', null), kind: 'pickup' };

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
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
        req.query.from === '2026-10-24T07:00:00.000Z'
          ? calendar([SKILLS, SWIM, BOOKING_ITEM], { overlaps: [OVERLAP] })
          : calendar([]),
      ),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    'GET /offerings/{id}': (req) =>
      fakeResponse(200, req.params.id === OFFERING_TWO ? PICKUP_OFFERING : offering()),
    ...overrides,
  };
}

beforeEach(() => mockPush.mockClear());

describe('SCR-C-19 FamilyCalendarScreen', () => {
  it('SPK-YOUTH-007: shows everyone the API includes in one week, with overlaps highlighted in words', async () => {
    const app = createTestApp({ routes: routes() });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    const saturday = await screen.findByTestId('family-day-2026-10-24');
    expect(await within(saturday).findByRole('button', { name: /^Sam: Junior Skills/ })).toHaveProp(
      'accessibilityLabel',
      'Sam: Junior Skills, 10:00 AM to 11:00 AM PDT. ▲ Overlaps with Swim club (Sam), Confirmed',
    );
    expect(
      within(saturday).getByRole('button', { name: /^You: Adult Pickup Night/ }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('1 overlapping commitment this week')).toBeOnTheScreen();
    // Every day of the week is shown; empty days say so.
    expect(
      within(screen.getByTestId('family-day-2026-10-25')).getByText('Nothing scheduled.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Week of Sat, Oct 24' })).toBeOnTheScreen();
  });

  it('SPK-IAM-003: offers a filter only for people the API includes, and filters to one person', async () => {
    const app = createTestApp({ routes: routes() });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByRole('radio', { name: 'Sam' });
    expect(screen.getByRole('radio', { name: 'Everyone' })).toHaveProp('accessibilityState', {
      checked: true,
    });
    expect(screen.getByRole('radio', { name: 'You' })).toBeOnTheScreen();
    // The second child holds a grant in /me but is not in the calendar: no filter, no hint.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    fireEvent.press(sam);
    expect(sam).toHaveProp('accessibilityState', { checked: true });
    expect(screen.getByRole('button', { name: /^Sam: Swim club/ })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^You: Adult Pickup Night/ })).toBeNull();
  });

  it('moves week by week from local midnight', async () => {
    const app = createTestApp({ routes: routes() });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Next week' }));
    expect(
      await screen.findByRole('header', { name: 'No activities this week' }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Week of Sat, Oct 31' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'This week' }));
    // The week already loaded shows straight away from the cache while it refreshes.
    expect(screen.getByTestId('family-day-2026-10-24')).toBeOnTheScreen();
    expect(
      app.fake.requests
        .filter((r) => r.route === '/me/family-calendar')
        .map((r) => r.query.from)
        .slice(0, 2),
    ).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-31T07:00:00.000Z']);
    expect(
      app.fake.requests.find((r) => r.query.from === '2026-10-31T07:00:00.000Z')?.query.to,
    ).toBe('2026-11-07T08:00:00.000Z');
  });

  it('says when no family member is shared, and shows pickup arrangements as pending (DEC-075, DEC-005)', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me': ok(me()),
        'GET /me/family-calendar': ok(calendar([BOOKING_ITEM], { participants: [SELF] })),
      }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('family-only-self')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Choosing who collects a child from a supervised session is not available yet: it depends on DEC-075, DEC-005/,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText(/does not by itself allow collecting them/)).toBeOnTheScreen();
  });

  it('shows the error code, and NOT_FOUND as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': fail(400, 'VALIDATION_FAILED', 'to must be after from.'),
      }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();

    screen.unmount();
    const hidden = createTestApp({
      routes: routes({ 'GET /me/family-calendar': fail(404, 'NOT_FOUND') }),
    });
    render(<FamilyCalendarScreen />, { wrapper: hidden.wrapper });
    expect(
      await screen.findByText('The family calendar is not available right now.'),
    ).toBeOnTheScreen();
    // Week navigation stays usable.
    expect(screen.getByRole('button', { name: 'Next week' })).toBeOnTheScreen();
  });
});

describe('SCR-C-19 family calendar: pickup sessions, team fixtures and facility clocks', () => {
  it('SPK-PLACE-004 (DEC-082): a booked pickup session is on the calendar, labelled from its offering', async () => {
    const app = createTestApp({ routes: routes() });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'You: Adult Pickup Night, 6:00 PM to 7:30 PM PDT. Pickup session, Booking pending',
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: /^Sam: Junior Skills, 10:00 AM to 11:00 AM PDT\. ▲/ }),
    ).toBeOnTheScreen();
  });

  it('DEC-016, DEC-082: with pickup sessions turned off, says so and keeps booked ones listed; nothing to find', async () => {
    const app = createTestApp({ routes: routes() });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('family-pickup-sessions');
    expect(await within(section).findByLabelText('Pickup sessions turned off')).toBeOnTheScreen();
    expect(
      within(section).getByText('Pickup sessions already booked stay on this calendar.'),
    ).toBeOnTheScreen();
    expect(within(section).getByText(/DEC-016, DEC-082/)).toBeOnTheScreen();
    expect(within(section).queryByRole('button', { name: 'Find pickup sessions' })).toBeNull();
    // The booked one is still there.
    expect(screen.getByRole('button', { name: /^You: Adult Pickup Night/ })).toBeOnTheScreen();
  });

  it('with pickup sessions turned on, offers finding more in Discover', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }) }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
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
      routes: routes({
        'GET /me/fixtures': (req) =>
          fakeResponse(200, req.query.from === '2026-10-24T07:00:00.000Z' ? [game] : []),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
      }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`family-fixture-${FIXTURE}`);
    expect(row).toHaveProp(
      'accessibilityLabel',
      'Sam (Lions): Lions vs Tigers, 10:30 AM to 12:00 PM PDT. Main Park, Pitch 3. ▲ Overlaps with Junior Skills (Sam), Swim club (Sam), Scheduled',
    );
    expect(
      screen.getByRole('button', {
        name: /^Sam: Junior Skills.*Overlaps with Swim club \(Sam\), Lions vs Tigers \(Sam\)/,
      }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('3 overlapping commitments this week')).toBeOnTheScreen();
    // The per-person filter keeps the child's fixture and drops the adult's booking.
    fireEvent.press(screen.getByRole('radio', { name: 'Sam' }));
    expect(screen.getByTestId(`family-fixture-${FIXTURE}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^You: Adult Pickup Night/ })).toBeNull();
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/fixtures/[id]',
      params: { id: FIXTURE },
    });
    expect(app.fake.requests.find((r) => r.route === '/me/fixtures')?.query).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-10-31T07:00:00.000Z',
    });
  });

  it('SPK-SCHED-008: an activity without a facility zone is on the device clock, and the screen says so', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([calendarItem({ timezone: null })])),
      }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        "Times are in this device's time zone (PDT). The facility's time zone was not given for this.",
      ),
    ).toBeOnTheScreen();
  });

  it('a team fixture read that fails shows its code; the calendar stays', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/fixtures': fail(500, 'INTERNAL_ERROR') }),
    });
    render(<FamilyCalendarScreen />, { wrapper: app.wrapper });
    const failure = await screen.findByTestId('family-fixtures-error');
    expect(within(failure).getByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByTestId('family-day-2026-10-24')).toBeOnTheScreen();
  });
});
