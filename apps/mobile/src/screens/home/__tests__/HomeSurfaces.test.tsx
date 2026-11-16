/**
 * SCR-C-03 Home in the visual system v2 (ADR-008; PA-11 SPK-UX-011 **Proposed** wording;
 * SPK-UX-003, SPK-UX-008, SPK-UX-009, SPK-SCHED-008): the greeting band on the facility's clock,
 * the "Up next" hero as one element, "Needs you" rows that open their item, quick actions, the
 * person blocks in `homeLayout()` order, results and renewals as a carousel, "Picked for", the
 * empty state and pull to refresh.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { illustrations } from '../../../artwork/manifest';
import {
  calendar,
  calendarItem,
  CHILD,
  DENVER,
  ENROLLMENT_PENDING,
  enrollment,
  enrollmentsPage,
  facility,
  fixtureDetail,
  GUARDIAN_OF_CHILD,
  HOME_ENTRY,
  inboxPage,
  me,
  myTeamEntry,
  names,
  notice,
  offering,
  OFFERING_TWO,
  ok,
  SELF,
  session,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { pullToRefresh } from '../../../testing/ui-surfaces';
import { Artwork } from '../../../ui/Artwork';
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
const TEAM_ENTRY = '0192f1a0-0000-7000-8000-00000000c0e1';

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(GUARDIAN_OF_CHILD)),
    'GET /me/inbox': inboxPage([]),
    'GET /me/family-calendar': ok(calendar([calendarItem()])),
    'GET /enrollments': enrollmentsPage([]),
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /facilities/{id}': ok(facility()),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    'GET /me/registration-checkouts': ok({ items: [], nextCursor: null }),
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([session()]),
    'GET /enrollments/{id}': ok(enrollment()),
    ...overrides,
  };
}

const payment = (overrides: Record<string, unknown> = {}) =>
  notice({
    kind: 'payment_attention',
    title: 'Amount due: Junior Skills',
    body: '40.00 is due on Saturday.',
    subject: { type: 'obligation', id: OBLIGATION },
    ...overrides,
  });

/** testIDs in document order. */
function order(ids: string[]): string[] {
  const seen: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const { props, children } = node as {
      props?: { testID?: unknown };
      children?: unknown[] | null;
    };
    const id = props?.testID;
    if (typeof id === 'string' && ids.includes(id) && !seen.includes(id)) seen.push(id);
    (children ?? []).forEach(walk);
  };
  walk(screen.toJSON());
  return seen;
}

beforeEach(() => mockPush.mockClear());

describe('SCR-C-03 Home look (ADR-008)', () => {
  it('SPK-SCHED-008: the greeting sits over the band of the facility hour, not the device hour', async () => {
    // 12:30 UTC is 5:30 AM in Los Angeles (the device) and 6:30 AM in Denver (the facility).
    const app = createTestApp({
      now: () => new Date('2026-10-24T12:30:00.000Z'),
      routes: routes({
        'GET /me/family-calendar': ok(calendar([calendarItem({ timezone: DENVER })])),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Hi, Alex' })).toBeOnTheScreen();
    // The band is decorative, so hidden from screen readers.
    const hidden = { includeHiddenElements: true };
    expect(await screen.findByTestId('home-band-day', hidden)).toBeOnTheScreen();

    screen.unmount();
    const night = createTestApp({
      now: () => new Date('2026-10-24T12:30:00.000Z'),
      routes: routes({ 'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })) }),
    });
    render(<HomeScreen />, { wrapper: night.wrapper });
    // No facility zone stated: the device's clock, where it is still night.
    expect(await screen.findByRole('header', { name: 'Hi, Alex' })).toBeOnTheScreen();
    expect(screen.getByTestId('home-band-night', hidden)).toBeOnTheScreen();
    expect(screen.queryByTestId('home-band-day', hidden)).toBeNull();
  });

  it('SPK-UX-009: "Up next" is one hero element with a combined name; the RSVP and the change are their own elements', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/fixtures': ok([fixtureDetail()]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const hero = await screen.findByRole('button', {
      name: 'Lions vs Tigers. For: You (Lions). Against: Tigers. When: Sun, Oct 25, 10:00 AM to 11:30 AM PDT. Where: Main Park, Pitch 3. Scheduled',
    });
    expect(hero).toHaveProp('accessibilityHint', 'Opens the game');
    // Nothing focusable inside the card's element: the answer is beside it.
    expect(within(hero).queryAllByRole('radio')).toHaveLength(0);
    const answer = screen.getByLabelText('Are you going to this game?');
    expect(within(answer).getByRole('radio', { name: 'Going' })).toBeOnTheScreen();
    expect(within(answer).getByRole('radio', { name: 'Not going' })).toBeOnTheScreen();
    fireEvent.press(hero);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/fixtures/[id]',
      params: { id: fixtureDetail().id },
    });
  });

  it('SPK-UX-003, PA-11: "Needs you" rows carry one verb and open their item', async () => {
    const pending = enrollment({
      id: ENROLLMENT_PENDING,
      status: 'pending',
      pendingReason: 'forms',
    });
    const invite = notice({
      kind: 'team_invitation',
      title: 'Join the Lions',
      body: 'The Lions invited you.',
      subject: { type: 'team_entry', id: TEAM_ENTRY },
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([payment(), invite]),
        'GET /enrollments': (req) =>
          fakeResponse(200, {
            items: req.query.participantPersonId === CHILD ? [pending] : [],
            nextCursor: null,
          }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('home-needs-you');
    expect(within(card).getByRole('header', { name: 'Needs you' })).toBeOnTheScreen();

    fireEvent.press(
      await within(card).findByRole('button', {
        name: 'Junior Skills, For: Sam, Sign form, Registration pending: a form to complete',
      }),
    );
    expect(mockPush).toHaveBeenLastCalledWith(`/enrollments/${ENROLLMENT_PENDING}`);

    fireEvent.press(
      within(card).getByRole('button', {
        name: 'Amount due: Junior Skills, 40.00 is due on Saturday., Pay, Unread',
      }),
    );
    expect(mockPush).toHaveBeenLastCalledWith(`/payments/${OBLIGATION}`);

    fireEvent.press(
      within(card).getByRole('button', {
        name: 'Join the Lions, The Lions invited you., Accept, Unread',
      }),
    );
    expect(mockPush).toHaveBeenLastCalledWith(`/team/${TEAM_ENTRY}`);
    // Actions come before invitations (SPK-UX-003).
    expect(order(['home-actions', 'home-invitations'])).toEqual([
      'home-actions',
      'home-invitations',
    ]);
  });

  it('SPK-UX-003: "Needs you" shows three rows and "See all" opens the inbox for the rest', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([
          payment({ title: 'Amount due: one' }),
          payment({ title: 'Amount due: two' }),
          payment({ title: 'Amount due: three' }),
          payment({ title: 'Amount due: four' }),
        ]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('home-needs-you');
    expect(await within(card).findByText('Amount due: three')).toBeOnTheScreen();
    expect(within(card).queryByText('Amount due: four')).toBeNull();
    expect(within(card).getByText('3 of 4')).toBeOnTheScreen();
    fireEvent.press(within(card).getByRole('button', { name: 'See all, Needs you' }));
    expect(mockPush).toHaveBeenLastCalledWith('/inbox');
  });

  it('SPK-UX-002: quick actions are Pass, Calendar and Explore, and Pay only while an amount is due', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    // Once the account has loaded, the actions sit after "Needs you".
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Show facility pass' }));
    expect(mockPush).toHaveBeenLastCalledWith('/pass');
    fireEvent.press(screen.getByRole('button', { name: 'Calendar' }));
    expect(mockPush).toHaveBeenLastCalledWith('/schedule');
    fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
    expect(mockPush).toHaveBeenLastCalledWith('/discover');
    expect(screen.queryByRole('button', { name: 'Pay' })).toBeNull();

    screen.unmount();
    const due = createTestApp({ routes: routes({ 'GET /me/inbox': inboxPage([payment()]) }) });
    render(<HomeScreen />, { wrapper: due.wrapper });
    // The "Needs you" row says "Pay" too; the quick action is the one among the actions.
    expect(await screen.findByTestId('home-needs-you')).toBeOnTheScreen();
    const pay = within(screen.getByTestId('home-quick-actions')).getByRole('button', {
      name: 'Pay',
    });
    expect(pay).toHaveProp('accessibilityHint', 'Opens the amount due');
    fireEvent.press(pay);
    expect(mockPush).toHaveBeenLastCalledWith(`/payments/${OBLIGATION}`);
  });

  it('homeLayout: a parent who also plays sees whichever comes sooner first, each card opening its place', async () => {
    const team = {
      ...myTeamEntry({ members: [SELF] }),
      // The game is before Sam's Saturday 10:00 session.
      nextFixture: {
        fixtureId: fixtureDetail().id,
        opponentTeamName: 'Tigers',
        readiness: {},
        scheduledStart: '2026-10-24T15:00:00.000Z',
        venue: null,
      },
    };
    const app = createTestApp({
      routes: routes({ 'GET /me/team-entries': ok([team]) }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const teamCard = await screen.findByRole('button', {
      name: 'Lions. Division 2. Next: vs Tigers · Sat, Oct 24, 8:00 AM PDT',
    });
    const family = await screen.findByRole('button', {
      name: 'Sam. Next: Sat, Oct 24, 10:00 AM PDT · Junior Skills',
    });
    expect(order(['home-team', 'home-family'])).toEqual(['home-team', 'home-family']);
    fireEvent.press(teamCard);
    expect(mockPush).toHaveBeenLastCalledWith(`/team/${HOME_ENTRY}`);
    expect(family).toHaveProp('accessibilityHint', 'Opens Calendar for Sam');
    fireEvent.press(family);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/schedule',
      params: { person: CHILD },
    });

    screen.unmount();
    const parent = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: parent.wrapper });
    expect(await screen.findByRole('header', { name: 'Family this week' })).toBeOnTheScreen();
    expect(screen.queryByTestId('home-team')).toBeNull();
  });

  it('SPK-UX-003: results and renewals are one carousel, results first, and a tile opens its notice', async () => {
    const renewal = notice({ kind: 'renewal_opportunity', title: 'Renew for spring' });
    const result = notice({
      kind: 'result_published',
      title: 'Result: Lions 2, Tigers 1',
      subjectPersonIds: [CHILD],
    });
    const app = createTestApp({
      routes: routes({ 'GET /me/inbox': inboxPage([renewal, result]) }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const row = await screen.findByLabelText('Results and renewals');
    const tile = await within(row).findByRole('button', {
      name: 'Result, Result: Lions 2, Tigers 1, For: Sam, Unread',
    });
    expect(
      within(row).getByRole('button', { name: 'Renewal, Renew for spring, Unread' }),
    ).toBeOnTheScreen();
    expect(
      order([`home-results-${result.attemptId}`, `home-renewals-${renewal.attemptId}`]),
    ).toEqual([`home-results-${result.attemptId}`, `home-renewals-${renewal.attemptId}`]);
    fireEvent.press(tile);
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/inbox',
      params: { open: result.attemptId },
    });
  });

  it('"Picked for Sam" comes last, and a suggestion opens the activity', async () => {
    const renewal = notice({ kind: 'renewal_opportunity', title: 'Renew for spring' });
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([renewal]),
        'GET /me/offering-suggestions': ok({
          basis: 'age',
          items: [
            {
              offering: offering(OFFERING_TWO, 'Mini Kickers', null),
              reason: { ageYears: 7, referenceDate: '2026-11-01' },
            },
          ],
        }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const strip = await screen.findByTestId('home-picked-for');
    expect(within(strip).getByRole('header', { name: 'Picked for Sam' })).toBeOnTheScreen();
    fireEvent.press(within(strip).getByRole('button', { name: 'Mini Kickers, Sam is 7' }));
    expect(mockPush).toHaveBeenLastCalledWith(`/registration/offering/${OFFERING_TWO}`);
    const query = app.fake.requests.find((r) => r.route === '/me/offering-suggestions')?.query;
    expect(query).toEqual({ participantPersonId: CHILD, limit: '3' });
    expect(order(['home-follow-up', 'home-picked-for'])).toEqual([
      'home-follow-up',
      'home-picked-for',
    ]);
  });

  it('SPK-UX-008: with nothing at all, "You\'re all caught up" shows the empty-home illustration', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })) }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const empty = await screen.findByTestId('home-empty');
    expect(within(empty).getByRole('header', { name: "You're all caught up" })).toBeOnTheScreen();
    const art = screen
      .UNSAFE_getAllByType(Artwork)
      .find((a) => a.props.source === illustrations['empty-home']);
    expect(art).toBeDefined();
    expect(screen.queryByTestId('home-next')).toBeNull();
  });

  it('pull to refresh reads the page again', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    const count = (route: string) => app.fake.requests.filter((r) => r.route === route).length;
    const inbox = count('/me/inbox');
    const calendarReads = count('/me/family-calendar');
    const checkouts = count('/me/registration-checkouts');
    await pullToRefresh(screen);
    await waitFor(() => expect(count('/me/inbox')).toBeGreaterThan(inbox));
    expect(count('/me/family-calendar')).toBeGreaterThan(calendarReads);
    expect(count('/me/registration-checkouts')).toBeGreaterThan(checkouts);
  });

  it('signed out, Home offers no pull to refresh and still has the pass', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Show facility pass' })).toBeOnTheScreen();
    expect(screen.UNSAFE_queryAllByType(RefreshControl)).toHaveLength(0);
    expect(app.fake.requests).toHaveLength(0);
  });
});
