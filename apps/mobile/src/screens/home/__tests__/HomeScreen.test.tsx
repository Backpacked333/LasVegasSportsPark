/**
 * SCR-C-03 Home and the SCR-C-04 next-activity card on it (SPK-UX-002, SPK-UX-003, SPK-UX-004,
 * SPK-COMMS-005, SPK-UX-008, SPK-UX-009, §4.10, §4.15).
 */
import { fakeResponse, apiErrorBody, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
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
  names,
  facility,
  PLACEMENT,
  scheduleChange,
  SELF,
  session,
  BASKET,
  checkoutBasket,
  checkoutOrder,
  DENVER,
  FIXTURE,
  fixtureDetail,
  HOME_ENTRY,
  LA,
  myTeamEntry,
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
    'GET /person-names': names({ [CHILD]: 'Sam' }),
    'GET /facilities/{id}': ok(facility()),
    'GET /me/fixtures': ok([]),
    'GET /me/team-entries': ok([]),
    'GET /me/registration-checkouts': ok({ items: [], nextCursor: null }),
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
        'For: Sam. When: Sat, Oct 24, 11:00 AM to 12:00 PM PDT. Where: Main Park, Pitch 2',
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
    // The calendar item states the facility's zone (ENR-02): no device-clock caveat.
    expect(screen.queryByText(/device's time zone/)).toBeNull();
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

describe('SCR-C-03 / SCR-C-04 Home: fixtures, facility clock, reasons and participants (stage 3 reads)', () => {
  /** Lions vs Tigers on Saturday 9:00 to 10:30 in Denver, before the 10:00 Los Angeles session. */
  const EARLY_FIXTURE = fixtureDetail({
    scheduledStart: '2026-10-24T15:00:00.000Z',
    scheduledEnd: '2026-10-24T16:30:00.000Z',
    venue: {
      facilityId: '0192f1a0-0000-7000-8000-00000000b802',
      facilityName: 'North Complex',
      timezone: DENVER,
      resources: [{ id: '0192f1a0-0000-7000-8000-00000000b709', name: 'Field 1' }],
    },
    rosterStatus: null,
  });

  it("CMP-02, SPK-UX-004: the next activity is the earlier fixture of a child's team, with opponent, venue and the venue's clock", async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/fixtures': ok([EARLY_FIXTURE]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [CHILD] })]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(within(card).getByRole('header', { name: 'Lions vs Tigers' })).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText(
        'For: Sam (Lions). Against: Tigers. When: Sat, Oct 24, 9:00 AM to 10:30 AM MDT. Where: North Complex, Field 1',
      ),
    ).toBeOnTheScreen();
    expect(within(card).getByLabelText('Scheduled')).toBeOnTheScreen();
    // The venue states its zone: no device-clock caveat, although the device is in Los Angeles.
    expect(screen.queryByText(/device's time zone/)).toBeNull();
    // A guardian not on the roster is not offered the RSVP choices (DEC-090 for a child).
    expect(within(card).getByTestId('rsvp-not-on-roster')).toBeOnTheScreen();
    expect(within(card).queryByRole('radio', { name: 'Available' })).toBeNull();
    fireEvent.press(within(card).getByRole('button', { name: 'View fixture' }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/fixtures/[id]',
      params: { id: FIXTURE },
    });
    const read = app.fake.requests.find((r) => r.route === '/me/fixtures');
    expect(read?.query).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-11-21T08:00:00.000Z',
    });
  });

  it('SPK-CAP-003, §4.9: an RSVP from the Home card changes the answer from the revision shown and reloads the list', async () => {
    const answered = fixtureDetail({
      responses: [
        {
          personId: SELF,
          state: 'unavailable',
          revision: 2,
          respondedAt: '2026-10-23T12:00:00.000Z',
        },
      ],
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/fixtures': ok([answered]),
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
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(
      await within(card).findByLabelText(
        'For: You (Lions). Against: Tigers. When: Sun, Oct 25, 10:00 AM to 11:30 AM PDT. Where: Main Park, Pitch 3',
      ),
    ).toBeOnTheScreen();
    expect(within(card).getByTestId('rsvp-current')).toHaveProp(
      'accessibilityLabel',
      'Unavailable',
    );
    const reads = app.fake.requests.filter((r) => r.route === '/me/fixtures').length;
    fireEvent.press(within(card).getByRole('radio', { name: 'Available' }));
    expect(await within(card).findByTestId('rsvp-recorded')).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.route === '/fixtures/{id}/availability');
    expect(post?.body).toEqual({ state: 'available', expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/fixtures').length).toBeGreaterThan(
        reads,
      ),
    );
  });

  it('SPK-SCHED-008: without a zone on the calendar item, the card uses GET /v1/facilities/{id}', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([calendarItem({ timezone: null })])),
        'GET /offerings/{id}': ok({ ...offering(), facility: undefined }),
        'GET /facilities/{id}': ok(facility({ timezone: DENVER })),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(
      await within(card).findByLabelText(
        'For: Sam. When: Sat, Oct 24, 11:00 AM to 12:00 PM MDT. Where: Main Park, North field',
      ),
    ).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/facilities/{id}')?.params.id).toBe(
      calendarItem().facilityId,
    );
  });

  it('SPK-SCHED-008: when the API gives no zone at all, the card uses the device clock and says so', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(
          calendar([calendarItem({ timezone: null, facilityId: null })]),
        ),
        'GET /offerings/{id}': ok({ ...offering(), facility: undefined, facilityId: null }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        "Times are in this device's time zone (PDT). The facility's time zone was not given for this.",
      ),
    ).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/facilities/{id}')).toBe(false);
  });

  it('a fixture read that fails shows its code and "Try again" in the next-activity section; one not available is left out', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/fixtures': fail(500, 'INTERNAL_ERROR', 'Fixtures failed.') }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('home-fixtures-error');
    expect(
      within(section).getByText(/Error code: INTERNAL_ERROR\. Reference: corr-1/),
    ).toBeOnTheScreen();
    expect(within(section).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    // The session card still shows.
    expect(screen.getByTestId('next-activity-card')).toBeOnTheScreen();

    screen.unmount();
    const hidden = createTestApp({
      routes: routes({ 'GET /me/fixtures': fail(404, 'NOT_FOUND') }),
    });
    render(<HomeScreen />, { wrapper: hidden.wrapper });
    expect(await screen.findByTestId('next-activity-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-fixtures-error')).toBeNull();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('SPK-UX-004 (ENR-02): a pending registration names what is outstanding', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments': (req) =>
          fakeResponse(200, {
            items:
              req.query.participantPersonId === CHILD
                ? [
                    enrollment({
                      id: ENROLLMENT_PENDING,
                      status: 'pending',
                      pendingReason: 'forms',
                    }),
                  ]
                : [],
            nextCursor: null,
          }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const actions = await screen.findByTestId('home-actions');
    expect(
      await within(actions).findByLabelText('Registration pending: a form to complete'),
    ).toBeOnTheScreen();
    // The offering's name comes with the enrollment (ENR-02): no separate offering read for it.
    expect(within(actions).getByText('Junior Skills')).toBeOnTheScreen();
  });

  it('SPK-UX-003: a notice names the participant it concerns', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/inbox': inboxPage([
          notice({
            kind: 'payment_attention',
            title: 'Installment due',
            body: 'Pay before Friday.',
            subjectPersonIds: [CHILD],
          }),
        ]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'Installment due, For: Sam. Pay before Friday., Unread',
      }),
    ).toBeOnTheScreen();
    // Names come from the names-only read, never from the full person record (§4.14).
    expect(app.fake.requests.some((r) => r.route === '/people/{id}')).toBe(false);
    expect(app.fake.requests.find((r) => r.route === '/person-names')?.query.ids).toBe(CHILD);
  });

  it('§4.11, SCR-C-40: a checkout in recovery found on refresh is pinned first and opens its outcome (SCR-C-15)', async () => {
    const CHECKOUT = '0192f1a0-0000-7000-8000-00000000e501';
    const app = createTestApp({
      routes: routes({
        'GET /me/registration-checkouts': ok({
          items: [
            {
              id: CHECKOUT,
              status: 'recovery_required',
              enrollmentIds: [ENROLLMENT_PENDING],
              payerPersonId: SELF,
            },
            { id: '0192f1a0-0000-7000-8000-00000000e502', status: 'completed', enrollmentIds: [] },
          ],
          nextCursor: null,
        }),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const pinned = await screen.findByTestId('home-recovery');
    const row = await within(pinned).findByTestId(`home-recovery-checkout-${CHECKOUT}`);
    expect(row).toHaveProp(
      'accessibilityLabel',
      'Registration checkout, 1 registration being completed, Payment received. We are completing your registration.',
    );
    expect(within(pinned).getByText(/Do not pay again/)).toBeOnTheScreen();
    fireEvent.press(row);
    expect(mockPush).toHaveBeenLastCalledWith(`/registration/outcome/${CHECKOUT}`);
    expect(order(['home-recovery', 'home-next'])).toEqual(['home-recovery', 'home-next']);
    // FIN-01 `status` filter: only checkouts in recovery, however many others the payer has.
    expect(app.fake.requests.find((r) => r.route === '/me/registration-checkouts')?.query).toEqual({
      status: 'recovery_required',
      limit: '20',
    });
  });

  it('§4.11: more checkouts in recovery than one page are offered with "Load more", never cut off', async () => {
    const page = (n: number) =>
      Array.from({ length: 20 }, (_, i) => ({
        id: `0192f1a0-0000-7000-8000-0000000e${String(n * 100 + i).padStart(4, '0')}`,
        status: 'recovery_required',
        enrollmentIds: [`0192f1a0-0000-7000-8000-0000000d${String(n * 100 + i).padStart(4, '0')}`],
        payerPersonId: SELF,
      }));
    const app = createTestApp({
      routes: routes({
        'GET /me/registration-checkouts': (req) =>
          fakeResponse(
            200,
            req.query.cursor === 'c2'
              ? { items: page(1).slice(0, 1), nextCursor: null }
              : { items: page(0), nextCursor: 'c2' },
          ),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const pinned = await screen.findByTestId('home-recovery');
    fireEvent.press(
      await within(pinned).findByRole('button', {
        name: 'Load more registrations being completed',
      }),
    );
    const last = page(1)[0]?.id as string;
    expect(await within(pinned).findByTestId(`home-recovery-checkout-${last}`)).toBeOnTheScreen();
    expect(
      app.fake.requests.filter((r) => r.route === '/me/registration-checkouts').at(-1)?.query,
    ).toEqual({ status: 'recovery_required', limit: '20', cursor: 'c2' });
  });

  it('§4.11: a failed read of checkouts in recovery shows its code and "Try again", and Home is not called empty', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })),
        'GET /me/registration-checkouts': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                500,
                apiErrorBody('INTERNAL_ERROR', {
                  message: 'Checkouts failed.',
                  correlationId: 'corr-co',
                  nextAction: 'retry_or_contact_support',
                }),
              )
            : fakeResponse(200, { items: [], nextCursor: null });
        },
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const failed = await screen.findByTestId('home-recovery-error');
    expect(
      within(failed).getByText(/Error code: INTERNAL_ERROR\. Reference: corr-co/),
    ).toBeOnTheScreen();
    // Nothing is called empty while it is not known whether a payment is being completed.
    expect(screen.queryByRole('header', { name: 'Nothing scheduled yet' })).toBeNull();
    fireEvent.press(within(failed).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('header', { name: 'Nothing scheduled yet' })).toBeOnTheScreen();
    expect(screen.queryByTestId('home-recovery-error')).toBeNull();
  });

  it('§4.11: Home is not called empty before the checkouts in recovery have answered', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([], { participants: [SELF] })),
        // Never answers.
        'GET /me/registration-checkouts': () => new Promise<Response>(() => undefined),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('home-next')).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/registration-checkouts')).toBe(true),
    );
    expect(screen.queryByRole('header', { name: 'Nothing scheduled yet' })).toBeNull();
  });

  it('SPK-PAY-007: a payment reason whose basket cannot be read, or is still being read, never says "payment outstanding"', async () => {
    const waiting = enrollment({
      id: ENROLLMENT_PENDING,
      status: 'pending',
      basketId: BASKET,
      pendingReason: 'payment',
    });
    const withBasket = (basket: FakeHandler) =>
      createTestApp({
        routes: routes({
          'GET /enrollments': (req) =>
            fakeResponse(200, {
              items: req.query.participantPersonId === CHILD ? [waiting] : [],
              nextCursor: null,
            }),
          'GET /baskets/{id}': basket,
        }),
      });
    const failed = withBasket(fail(503, 'INTEGRATION_UNAVAILABLE'));
    render(<HomeScreen />, { wrapper: failed.wrapper });
    const section = await screen.findByTestId('home-in-progress');
    expect(
      await within(section).findByLabelText(
        'Registration pending: payment status could not be checked',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/payment outstanding/)).toBeNull();
    expect(screen.queryByTestId('home-actions')).toBeNull();

    screen.unmount();
    const pending = withBasket(() => new Promise<Response>(() => undefined));
    render(<HomeScreen />, { wrapper: pending.wrapper });
    const checking = await screen.findByTestId('home-in-progress');
    expect(
      await within(checking).findByLabelText('Registration pending: checking payment status'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/payment outstanding/)).toBeNull();
    expect(screen.queryByTestId('home-actions')).toBeNull();

    screen.unmount();
    // Read, held and not checking out: now it is outstanding, and an action.
    const held = withBasket(ok(checkoutBasket('held', null)));
    render(<HomeScreen />, { wrapper: held.wrapper });
    const actions = await screen.findByTestId('home-actions');
    expect(
      await within(actions).findByLabelText('Registration pending: payment outstanding'),
    ).toBeOnTheScreen();
  });

  it('CMP-04: when the next activity becomes another fixture, its card shows its own answer, not the last one', async () => {
    const OTHER = '0192f1a0-0000-7000-8000-00000000f109';
    const first = fixtureDetail({
      responses: [
        { personId: SELF, state: 'unavailable', revision: 2, respondedAt: '2026-10-23T12:00:00Z' },
      ],
    });
    const second = fixtureDetail({
      id: OTHER,
      scheduledStart: '2026-10-26T17:00:00.000Z',
      scheduledEnd: '2026-10-26T18:30:00.000Z',
      away: { ...fixtureDetail().away, teamName: 'Bears' },
      responses: [],
    });
    let answered = false;
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        // After the answer the first fixture is postponed, so the next one is the second.
        'GET /me/fixtures': () =>
          fakeResponse(
            200,
            answered ? [{ ...first, status: 'postponed' }, second] : [first, second],
          ),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
        'POST /fixtures/{id}/availability': (req) => {
          answered = true;
          return fakeResponse(200, {
            id: '0192f1a0-0000-7000-8000-00000000fa01',
            fixtureId: req.params.id,
            teamEntryId: HOME_ENTRY,
            personId: SELF,
            state: 'available',
            respondedAt: '2026-10-24T12:00:00.000Z',
            note: null,
            revision: 3,
          });
        },
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('next-activity-card');
    expect(await within(card).findByRole('header', { name: 'Lions vs Tigers' })).toBeOnTheScreen();
    fireEvent.press(within(card).getByRole('radio', { name: 'Available' }));
    // The answer reloads the list; the first fixture is postponed, so the second is next.
    expect(await screen.findByRole('header', { name: 'Lions vs Bears' })).toBeOnTheScreen();
    const next = screen.getByTestId('next-activity-card');
    expect(within(next).getByTestId('rsvp-current')).toHaveProp(
      'accessibilityLabel',
      'No response',
    );
    expect(within(next).queryByTestId('rsvp-recorded')).toBeNull();
    fireEvent.press(within(next).getByRole('radio', { name: 'Available' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/fixtures/{id}/availability'),
      ).toHaveLength(2),
    );
    const posts = app.fake.requests.filter((r) => r.route === '/fixtures/{id}/availability');
    expect(posts[1]?.params.id).toBe(OTHER);
    // The second fixture has no answer yet: no revision of the first is sent with it.
    expect(posts[1]?.body).toEqual({ state: 'available' });
  });

  it('COM-06, SPK-UX-003: an availability request is an action required, and the card says so, until answered', async () => {
    const request = notice({
      kind: 'availability_request',
      title: 'Lions: are you available?',
      body: 'Lions plays Sun, Oct 25, 10:00 AM PDT at Main Park. Please answer the availability request in the app.',
      subject: { type: 'fixture', id: FIXTURE },
      detailsAfter: {
        fixtureId: FIXTURE,
        scheduledStart: '2026-10-25T17:00:00.000Z',
        timezone: LA,
      },
      subjectPersonIds: [SELF],
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/inbox': inboxPage([request]),
        'GET /me/fixtures': ok([fixtureDetail()]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
      }),
    });
    render(<HomeScreen />, { wrapper: app.wrapper });
    const actions = await screen.findByTestId('home-actions');
    expect(
      await within(actions).findByRole('button', {
        name: /^Lions: are you available\?, For: You\./,
      }),
    ).toBeOnTheScreen();
    const card = await screen.findByTestId('next-activity-card');
    expect(
      within(card).getByLabelText(
        'Action needed: Answer the availability request for this fixture.',
      ),
    ).toBeOnTheScreen();

    screen.unmount();
    // Answered: no longer an action, and the card asks for nothing.
    const done = createTestApp({
      routes: routes({
        'GET /me/family-calendar': ok(calendar([])),
        'GET /me/inbox': inboxPage([request]),
        'GET /me/fixtures': ok([
          fixtureDetail({
            responses: [{ personId: SELF, state: 'available', revision: 1, respondedAt: null }],
          }),
        ]),
        'GET /me/team-entries': ok([myTeamEntry({ members: [SELF] })]),
      }),
    });
    render(<HomeScreen />, { wrapper: done.wrapper });
    const answeredCard = await screen.findByTestId('next-activity-card');
    expect(within(answeredCard).getByTestId('rsvp-current')).toHaveProp(
      'accessibilityLabel',
      'Available',
    );
    expect(screen.queryByTestId('home-actions')).toBeNull();
    expect(within(answeredCard).queryByLabelText(/^Action needed/)).toBeNull();
  });
});
