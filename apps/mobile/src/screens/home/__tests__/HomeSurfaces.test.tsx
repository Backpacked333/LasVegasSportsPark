/**
 * SCR-C-03 Home, redesigned "Today first" (redesign handoff M 1b, 3a, 2b, 3b, 2c, 3c, 3f, 3g;
 * INTERACTIONS 1b, 2b, 2c, Shell; BUILD_PLAN Phase 1 acceptance: answer Going (+ Undo), pay $120
 * (+ decline), sign Leo's waiver (+ also Maya), offline). Deterministic: fake API, fixed clock,
 * Jest's fake timers for the toast and the "✓ Paid" flash.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { illustrations } from '../../../artwork/manifest';
import {
  calendar,
  calendarItem,
  CHILD,
  CHILD_TWO,
  enrollment,
  enrollmentsPage,
  facility,
  FIXTURE,
  fixtureDetail,
  inboxPage,
  me,
  myTeamEntry,
  offering,
  OFFERING_TWO,
  ok,
  SELF,
  session,
} from '../../../features/today/__tests__/fixtures';
import { obligation, paymentAttempt, receipt } from '../../../features/money/testing/fixtures';
import { teamInvitationView } from '../../../features/teams/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { pullToRefresh } from '../../../testing/ui-surfaces';
import { Artwork } from '../../../ui/Artwork';
import { TOAST_ACTION_DURATION_MS } from '../../../ui/Toast';
import { HomeScreen } from '../HomeScreen';
import { DONE_FLASH_MS } from '../TodoList';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const FEE = '0192f1a0-0000-7000-8000-00000000b0b1';
const VERSION = '0192f1a0-0000-7000-8000-00000000e501';
const INVITE = '0192f1a0-0000-7000-8000-00000000e701';
const ALL = ['view', 'register', 'pay', 'complete_forms'];

const FAMILY = [
  { subjectPersonId: CHILD, permissions: ALL },
  { subjectPersonId: CHILD_TWO, permissions: ALL },
];

const fee = obligation({
  id: FEE,
  description: 'Spring Rec League',
  debtor: { kind: 'person', personId: CHILD, teamEntryId: null },
  dueAt: '2026-10-30T01:00:00.000Z',
  totals: {
    amountMinor: 12000,
    receivedMinor: 0,
    allocatedMinor: 0,
    remainingMinor: 12000,
    excessMinor: 0,
    currency: 'USD',
  },
  liveAttempt: null,
});

const version = {
  policyVersionId: VERSION,
  version: 4,
  title: 'Liability waiver',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
};
function waiver(overrides: Record<string, unknown> = {}) {
  return {
    policyKey: 'liability',
    title: 'Liability waiver',
    status: 'missing',
    reason: 'never_accepted',
    currentVersion: version,
    acceptance: null,
    validUntil: null,
    lapsedAt: null,
    rule: { reacceptOnNewVersion: false, renewEveryMonths: 12, enforcement: 'block' },
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    history: [],
    overrides: [],
    ...overrides,
  };
}

const POLICY = {
  id: VERSION,
  kind: 'form',
  key: 'liability',
  version: 4,
  title: 'Liability waiver',
  content: {
    summary: 'Sports carry a risk of injury. You allow staff to give first aid.',
    text: '1. Assumption of risk. I understand that participation involves risks.',
  },
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  approvalStatus: 'approved',
  approvedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
  retiredReason: null,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** `GET /v1/person-names` for several ids (the client repeats `ids`, so read every value). */
const familyNames: FakeHandler = (req) => {
  const known: Record<string, string> = { [CHILD]: 'Sam', [CHILD_TWO]: 'Leo' };
  const ids = req.queryAll?.ids ?? (req.query.ids ?? '').split(',');
  return fakeResponse(200, {
    items: ids.flatMap((id) =>
      known[id]
        ? [
            {
              personId: id,
              canonicalPersonId: id,
              givenName: known[id],
              familyName: 'Morgan',
              displayName: `${known[id]} Morgan`,
              kind: 'child',
            },
          ]
        : [],
    ),
  });
};

/** The design's household: Alex (the account), Sam (CHILD) and Leo (CHILD_TWO). */
function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': ok(me(FAMILY)),
    'GET /me/inbox': inboxPage([]),
    'GET /me/family-calendar': ok(
      calendar([calendarItem(), calendarItem({ id: 'item-leo', personId: CHILD_TWO })], {
        participants: [SELF, CHILD, CHILD_TWO],
      }),
    ),
    'GET /enrollments': enrollmentsPage([]),
    'GET /person-names': familyNames,
    'GET /facilities/{id}': ok(facility()),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    'GET /me/registration-checkouts': ok({ items: [], nextCursor: null }),
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([session()]),
    'GET /enrollments/{id}': ok(enrollment()),
    'GET /obligations': (req) =>
      fakeResponse(200, {
        items: req.query.debtorPersonId === CHILD ? [fee] : [],
        nextCursor: null,
      }),
    'GET /people/{id}/waivers': (req) =>
      fakeResponse(200, {
        personId: req.params.id,
        evaluated: true,
        waivers: [waiver()],
      }),
    'GET /me/team-invitations': ok({ items: [], nextCursor: null }),
    'GET /policy-versions/{id}': ok(POLICY),
    ...overrides,
  };
}

beforeEach(() => mockPush.mockClear());
afterEach(() => jest.useRealTimers());

describe('M 1b Home "Today first"', () => {
  it('greets on the facility clock and filters the whole page with the household chips, remembered on the device', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Hi, Alex' })).toBeOnTheScreen();
    expect(screen.getByText('Saturday, October 24')).toBeOnTheScreen();
    const chips = await screen.findByTestId('person-filter');
    expect(within(chips).getByRole('radio', { name: 'Everyone', checked: true })).toBeOnTheScreen();
    // Everyone: both forms to sign and Sam's fee.
    expect(await screen.findByText('3 left · about 2 min')).toBeOnTheScreen();
    fireEvent.press(await within(chips).findByRole('radio', { name: 'Leo' }));
    expect(within(chips).getByRole('radio', { name: 'Leo', checked: true })).toBeOnTheScreen();
    expect(await screen.findByText('1 left · about 1 min')).toBeOnTheScreen();
    expect(screen.queryByText('Spring Rec League')).toBeNull();
    expect(app.personFilterStore.read()).toBe(CHILD_TWO);
  });

  it('Shell row 5: with one person the chips are hidden', async () => {
    const app = createTestApp({ routes: routes({ 'GET /me': ok(me([])) }) });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Hi, Alex' })).toBeOnTheScreen();
    await screen.findByTestId('home-content');
    expect(screen.queryByTestId('person-filter')).toBeNull();
  });

  it('2b, 3a, SPK-PAY-007: Pay $120 opens the sheet, pays with an Idempotency-Key, then the row shows ✓ Paid for 3 s and leaves', async () => {
    let paid = false;
    const app = createTestApp({
      toasts: true,
      routes: routes({
        'GET /obligations': (req) =>
          fakeResponse(200, {
            items: req.query.debtorPersonId === CHILD && !paid ? [fee] : [],
            nextCursor: null,
          }),
        'POST /obligations/{id}/payments': () => {
          paid = true;
          return fakeResponse(201, {
            payment: paymentAttempt({ amountMinor: 12000, obligationId: FEE }),
            receipt: receipt({ amountMinor: 12000, allocatedMinor: 12000 }),
            obligation: { ...fee, status: 'paid' },
            overpaymentCreditId: null,
          });
        },
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Pay $120, Spring Rec League' }));
    const sheet = await screen.findByTestId('pay-sheet');
    expect(within(sheet).getByLabelText('Amount due $120.00')).toBeOnTheScreen();
    expect(within(sheet).getByText('Or pay at the front desk.')).toBeOnTheScreen();
    fireEvent.press(within(sheet).getByRole('button', { name: 'Pay $120.00' }));
    expect(await screen.findByTestId('todo-done-pay:' + FEE)).toHaveTextContent('✓ Paid');
    const post = app.fake.requests.find((r) => r.route === '/obligations/{id}/payments');
    expect(post?.body).toEqual({ paymentMethodToken: 'pm_fake_visa' });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    expect(screen.getByText('Paid $120. Your receipt is in Payments.')).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByTestId('todo-done-pay:' + FEE)).toBeNull(), {
      timeout: DONE_FLASH_MS + 2_000,
    });
  }, 20_000);

  it('3b: a declined card keeps the sheet open, says no money moved, and picks the next method', async () => {
    const app = createTestApp({
      routes: routes({
        'POST /obligations/{id}/payments': () =>
          fakeResponse(201, {
            payment: paymentAttempt({
              status: 'failed',
              failureReason: 'card_declined',
              amountMinor: 12000,
            }),
            receipt: null,
            obligation: fee,
            overpaymentCreditId: null,
          }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Pay $120, Spring Rec League' }));
    const sheet = await screen.findByTestId('pay-sheet');
    fireEvent.press(within(sheet).getByRole('button', { name: 'Change payment method' }));
    fireEvent.press(within(sheet).getByRole('radio', { name: 'Declined' }));
    fireEvent.press(within(sheet).getByRole('button', { name: 'Pay $120.00' }));
    expect(await within(sheet).findByText("You weren't charged.")).toBeOnTheScreen();
    expect(within(sheet).getByLabelText('Declined by your bank')).toBeOnTheScreen();
    expect(
      within(sheet).getByRole('button', { name: 'Pay $120.00 with Succeeds at once' }),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('pay-sheet')).toBeOnTheScreen();
  });

  it('2c: Sign opens the form with the summary first, the name prefilled, and signs Leo and Sam together', async () => {
    const app = createTestApp({
      toasts: true,
      routes: routes({ 'POST /waiver-acceptances': ok({ id: 'ack' }) }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const rows = await screen.findByTestId('home-todo-rows');
    await screen.findAllByText(/^Leo · /);
    const signButtons = await within(rows).findAllByRole('button', {
      name: 'Sign, Liability waiver',
    });
    fireEvent.press(signButtons[1] as never);
    const sheet = await screen.findByTestId('sign-sheet');
    expect(await within(sheet).findByText('In short')).toBeOnTheScreen();
    expect(within(sheet).getByDisplayValue('Alex Morgan')).toBeOnTheScreen();
    expect(within(sheet).getByRole('checkbox', { name: 'Also sign for Sam' })).toBeOnTheScreen();
    fireEvent.press(within(sheet).getByRole('button', { name: 'Sign for Leo and Sam' }));
    expect(await screen.findByText('Signed for Leo and Sam. Leo is cleared.')).toBeOnTheScreen();
    const posts = app.fake.requests.filter((r) => r.route === '/waiver-acceptances');
    expect(posts.map((p) => (p.body as { subjectPersonId: string }).subjectPersonId)).toEqual([
      CHILD_TWO,
      CHILD,
    ]);
    expect((posts[0]?.body as { policyVersionId: string }).policyVersionId).toBe(VERSION);
    expect((posts[0]?.body as { evidence: { typedName: string } }).evidence.typedName).toBe(
      'Alex Morgan',
    );
  });

  it('2c: fewer than 3 characters reads "Type your name to sign" and cannot be pressed', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const rows = await screen.findByTestId('home-todo-rows');
    fireEvent.press(
      (await within(rows).findAllByRole('button', { name: 'Sign, Liability waiver' }))[0] as never,
    );
    const sheet = await screen.findByTestId('sign-sheet');
    fireEvent.changeText(await within(sheet).findByDisplayValue('Alex Morgan'), 'Al');
    expect(within(sheet).getByRole('button', { name: 'Type your name to sign' })).toBeDisabled();
  });

  it('3c: Answer opens the join sheet; Join accepts from the list without a token and says so', async () => {
    const app = createTestApp({
      toasts: true,
      routes: routes({
        'GET /me/team-invitations': ok({
          items: [teamInvitationView({ id: INVITE, teamName: 'FC Neon' })],
          nextCursor: null,
        }),
        'POST /team-invitations/{id}/accept': ok({ invitation: {}, membership: {} }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Answer, FC Neon' }));
    const sheet = await screen.findByTestId('join-sheet');
    fireEvent.press(within(sheet).getByRole('button', { name: 'Join FC Neon' }));
    expect(await screen.findByText('You joined FC Neon. Added to Calendar.')).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.route === '/team-invitations/{id}/accept');
    expect(post?.body).toEqual({ expectedRevision: 1 });
  });

  it('3c: Not now hides the invitation from To do', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/team-invitations': ok({
          items: [
            teamInvitationView({ id: '0192f1a0-0000-7000-8000-00000000e702', teamName: 'FC Volt' }),
          ],
          nextCursor: null,
        }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Answer, FC Volt' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Answer, FC Volt' })).toBeNull(),
    );
  });

  it('3a: Going shows at once with Undo for 5 s; Undo sends the previous answer back', async () => {
    let posts = 0;
    const app = createTestApp({
      toasts: true,
      routes: routes({
        'GET /me/family-calendar': ok(calendar([], { participants: [SELF, CHILD, CHILD_TWO] })),
        'GET /me/fixtures': ok([fixtureDetail()]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
        'POST /fixtures/{id}/availability': (req) => {
          posts += 1;
          return fakeResponse(200, {
            id: 'resp',
            fixtureId: FIXTURE,
            teamEntryId: 'e',
            personId: CHILD,
            state: (req.body as { state: string }).state,
            respondedAt: null,
            note: null,
            revision: posts,
          });
        },
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(await within(card).findByText('Is Sam going?')).toBeOnTheScreen();
    fireEvent.press(await within(card).findByRole('radio', { name: 'Going' }));
    expect(within(card).getByRole('radio', { name: 'Going', checked: true })).toBeOnTheScreen();
    expect(await screen.findByTestId('toast')).toHaveTextContent(
      /Saved: Sam is going\. The coach can see it\.Undo$/,
    );
    await waitFor(() => expect(posts).toBe(1));
    fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(posts).toBe(2));
    const bodies = app.fake.requests
      .filter((r) => r.route === '/fixtures/{id}/availability')
      .map((r) => r.body);
    expect(bodies).toEqual([
      { personId: CHILD, state: 'available' },
      { personId: CHILD, state: 'no_response', expectedRevision: 1 },
    ]);
    expect(within(card).queryByRole('radio', { checked: true })).toBeNull();
    expect(TOAST_ACTION_DURATION_MS).toBe(5_000);
  });

  it('3a: an answer that does not save reverts and says so, with Try again', async () => {
    const app = createTestApp({
      toasts: true,
      routes: routes({
        'GET /me/family-calendar': ok(calendar([], { participants: [SELF, CHILD, CHILD_TWO] })),
        'GET /me/fixtures': ok([fixtureDetail()]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
        'POST /fixtures/{id}/availability': () =>
          fakeResponse(409, {
            code: 'INVALID_TRANSITION',
            message: 'Answers are closed.',
            details: null,
            correlationId: 'c',
            nextAction: 'reload_current_state',
          }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(await within(card).findByText('Is Sam going?')).toBeOnTheScreen();
    fireEvent.press(await within(card).findByRole('radio', { name: 'Not going' }));
    expect(await screen.findByText("Sam's answer didn't save.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(within(card).queryByRole('radio', { checked: true })).toBeNull();
  });

  it('3f: offline, writes are disabled with their reason while the pass stays', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', { name: 'Pay $120, Spring Rec League' }),
    ).toBeEnabled();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Pay $120, Spring Rec League' })).toBeDisabled();
    expect(screen.getByText('Paying, signing and answering need a connection.')).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: /pass/ }).length).toBeGreaterThan(0);
  });

  it('3g: a game of today that was cancelled shows first as the red card until "See what\'s next"', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/fixtures': ok([
          fixtureDetail({
            status: 'canceled',
            scheduledStart: '2026-10-24T16:00:00.000Z',
            scheduledEnd: '2026-10-24T17:00:00.000Z',
          }),
        ]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const cancelled = await screen.findByTestId('home-cancelled');
    expect(within(cancelled).getByLabelText(/^Cancelled: /)).toBeOnTheScreen();
    fireEvent.press(within(cancelled).getByRole('button', { name: "See what's next" }));
    expect(screen.queryByTestId('home-cancelled')).toBeNull();
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
  });

  it('"This week" shows the day strip with dots named for screen readers, and Calendar opens the tab', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const strip = await screen.findByTestId('home-week-strip');
    expect(await within(strip).findByLabelText('Saturday 24, today: Sam, Leo')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('link', { name: 'Calendar' }));
    expect(mockPush).toHaveBeenLastCalledWith('/schedule');
  });

  it('"Picked for Sam" is one compact card that opens the activity', async () => {
    const app = createTestApp({
      routes: routes({
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
    const card = await screen.findByTestId('home-picked-for');
    fireEvent.press(within(card).getByTestId(`home-suggestion-${OFFERING_TWO}`));
    expect(mockPush).toHaveBeenLastCalledWith(`/registration/offering/${OFFERING_TWO}`);
  });

  it('Shell row 6: pull to refresh reads the page again and says "Updated just now"', async () => {
    const app = createTestApp({ routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    const count = (route: string) => app.fake.requests.filter((r) => r.route === route).length;
    const inbox = count('/me/inbox');
    await pullToRefresh(screen);
    await waitFor(() => expect(count('/me/inbox')).toBeGreaterThan(inbox));
    expect(await screen.findByText('Updated just now')).toBeOnTheScreen();
  });

  it('SPK-UX-008: with nothing at all, the Explore prompt shows the empty-home illustration', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me': ok(me([{ subjectPersonId: CHILD, permissions: ['view', 'register'] }])),
        'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })),
        'GET /people/{id}/waivers': ok({ personId: CHILD, evaluated: true, waivers: [] }),
        'GET /obligations': ok({ items: [], nextCursor: null }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const empty = await screen.findByTestId('home-empty');
    expect(within(empty).getByRole('header', { name: 'Find something for Sam' })).toBeOnTheScreen();
    const art = screen
      .UNSAFE_getAllByType(Artwork)
      .find((a) => a.props.source === illustrations['empty-home']);
    expect(art).toBeDefined();
  });

  it('signed out, Home offers no pull to refresh and still has the pass', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Facility pass' })).toBeOnTheScreen();
    expect(screen.UNSAFE_queryAllByType(RefreshControl)).toHaveLength(0);
    expect(app.fake.requests).toHaveLength(0);
  });
});
