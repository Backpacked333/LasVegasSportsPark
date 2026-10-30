/**
 * My memberships and my family's (Package G; SPK-COND-001, ENR-12, DEC-016, DEC-072, §4.9,
 * §4.14, SPK-SCHED-008, SPK-UX-008): what each membership includes exactly as its entitlement
 * states, sessions used per period, suspensions, the term in the facility's zone, whose it is;
 * renewal only at checkout and only while the switch is on (no target preselected, nothing charged
 * here); "active" only inside the term (its end the last local day it includes); booking a session
 * with the included sessions (ENR-12, one key per intent); cancellation through the enrollment,
 * never gated; readable while off; errors with their code; not available.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createRouterMock } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import {
  basket,
  G,
  membership,
  membershipSessionBooking,
  offering,
  ok,
  page,
  peopleRoutes,
  seasonSessions,
  suspension,
  switchesOn,
} from '../../../features/package-g/__tests__/fixtures';
import { MyMembershipsScreen } from '../MyMembershipsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const CHILD_MEMBERSHIP = membership({
  enrollmentId: G.membershipChild,
  participantPersonId: G.child,
  offeringName: 'Junior membership 2026',
  attendance: {
    mode: 'unlimited',
    limit: null,
    appliesTo: { offeringIds: [], programIds: [] },
  },
  usage: [],
  suspensions: [suspension()],
});

const NEXT_YEAR = offering({
  id: G.membershipNext,
  kind: 'membership',
  name: 'Adult membership 2027',
  startsOn: '2027-01-01',
  endsOn: '2027-12-31',
});
const SEASON = offering({
  id: G.season,
  kind: 'season',
  name: 'Open play season',
  startsOn: '2026-09-01',
  endsOn: '2027-06-30',
});
const CLOSED = offering({
  id: G.membershipOffering,
  kind: 'membership',
  name: 'Adult membership 2026',
  publicationState: 'closed',
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...peopleRoutes(),
    ...switchesOn('memberships'),
    'GET /me/memberships': ok(page([membership(), CHILD_MEMBERSHIP])),
    'GET /offerings/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === G.season
          ? SEASON
          : offering({ id: G.membershipOffering, kind: 'membership' }),
      ),
    'GET /offerings/{id}/sessions': ok(seasonSessions()),
    'POST /session-bookings': { status: 201, body: membershipSessionBooking() },
    'GET /offerings': ok(page([NEXT_YEAR, CLOSED])),
    'POST /enrollments/{id}/renew': ok(basket({ id: G.basketNew, status: 'open' })),
    ...overrides,
  };
}

function renderScreen(r: Record<string, FakeHandler> = routes()) {
  const app = createTestApp({ routes: r });
  render(<MyMembershipsScreen />, { wrapper: app.wrapper });
  return app;
}

const renewals = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/enrollments/{id}/renew');
const bookings = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/session-bookings');

/** Opens the booking form on my membership and chooses the season's next session in the term. */
async function chooseIncludedSession() {
  const mine = await screen.findByTestId(`membership-${G.membership}`);
  fireEvent.press(
    within(mine).getByRole('button', { name: 'Book a session with this membership' }),
  );
  fireEvent.press(
    await screen.findByRole('radio', { name: 'Open play season, Sep 1, 2026 to Jun 30, 2027' }),
  );
  fireEvent.press(
    await screen.findByRole('radio', { name: 'Open play, Tue, Oct 27, 6:00 PM to 7:00 PM PDT' }),
  );
}

async function bookWithMembership() {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Book with this membership' }));
  });
}

describe('Package G MyMembershipsScreen (SPK-COND-001)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  it('SPK-COND-001: each membership says exactly what it includes, with usage, term, suspensions and whose it is', async () => {
    renderScreen();
    const mine = await screen.findByTestId(`membership-${G.membership}`);
    expect(within(mine).getByRole('header', { name: 'Adult membership 2026' })).toBeOnTheScreen();
    expect(within(mine).getByLabelText('Membership active')).toBeOnTheScreen();
    expect(await within(mine).findByLabelText('For: You')).toBeOnTheScreen();
    expect(within(mine).getByLabelText('Includes: 8 sessions each month')).toBeOnTheScreen();
    expect(within(mine).getByText('3 of 8 sessions used in October 2026')).toBeOnTheScreen();
    expect(
      within(mine).getByText('For 1 activity or program named by the membership'),
    ).toBeOnTheScreen();
    expect(
      await within(mine).findByLabelText('Term: Jan 1, 2026 to Dec 31, 2026'),
    ).toBeOnTheScreen();

    const child = screen.getByTestId(`membership-${G.membershipChild}`);
    expect(await within(child).findByLabelText('For: Sam')).toBeOnTheScreen();
    // Unlimited only because the entitlement says so.
    expect(within(child).getByLabelText('Includes: Unlimited sessions')).toBeOnTheScreen();
    expect(within(child).getByLabelText('Membership suspended')).toBeOnTheScreen();
    expect(
      within(child).getByLabelText('Suspended from Oct 20, 2026 until Nov 3, 2026'),
    ).toBeOnTheScreen();
    expect(within(child).getByText('Reason: Injury')).toBeOnTheScreen();
    expect(
      within(child).getByText('Suspending a membership is arranged by the front desk.'),
    ).toBeOnTheScreen();
  });

  it('a membership whose definition the API cannot read assumes nothing', async () => {
    renderScreen(routes({ 'GET /me/memberships': ok(page([membership({ attendance: null })])) }));
    expect(
      await screen.findByLabelText(
        'Includes: What this membership includes cannot be shown right now. Ask the front desk.',
      ),
    ).toBeOnTheScreen();
  });

  it('ENR-12: renewal adds the chosen open membership to a basket at checkout, with one key and no preselection', async () => {
    const app = renderScreen();
    const mine = await screen.findByTestId(`membership-${G.membership}`);
    fireEvent.press(within(mine).getByRole('button', { name: 'Renew' }));
    const option = await screen.findByRole('radio', {
      name: 'Adult membership 2027, Jan 1, 2027 to Dec 31, 2027, North Fields',
    });
    // Only memberships open for registration are offered, and none is chosen for the customer.
    expect(screen.queryByRole('radio', { name: /Adult membership 2026/ })).toBeNull();
    expect(option).not.toBeChecked();
    expect(
      screen.getByText(/Nothing is charged until you check out, where the price is shown\./),
    ).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add the renewal to a basket' }));
    });
    expect(screen.getByText('▲ Choose the membership to renew into.')).toBeOnTheScreen();
    expect(renewals(app)).toHaveLength(0);

    fireEvent.press(option);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add the renewal to a basket' }));
    });
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${G.basketNew}`),
    );
    const [sent] = renewals(app);
    expect(sent?.params.id).toBe(G.membership);
    expect(sent?.body).toEqual({ targetOfferingId: G.membershipNext });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(app.fake.requests.find((r) => r.route === '/offerings')?.query).toEqual({
      kind: 'membership',
      limit: '20',
    });
  });

  it('PARTICIPANT_AUTHORITY_REQUIRED is "not available to your account"; CAPABILITY_DISABLED is turned off', async () => {
    renderScreen(
      routes({
        'POST /enrollments/{id}/renew': {
          status: 403,
          body: apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED'),
        },
      }),
    );
    const child = await screen.findByTestId(`membership-${G.membershipChild}`);
    fireEvent.press(within(child).getByRole('button', { name: 'Renew' }));
    fireEvent.press(await screen.findByRole('radio', { name: /Adult membership 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add the renewal to a basket' }));
    });
    expect(await screen.findByText(/This is not available to your account\./)).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderScreen(
      routes({
        'POST /enrollments/{id}/renew': {
          status: 403,
          body: capabilityDisabledBody('memberships', ['DEC-016', 'DEC-072']),
        },
      }),
    );
    const mine = await screen.findByTestId(`membership-${G.membership}`);
    fireEvent.press(within(mine).getByRole('button', { name: 'Renew' }));
    fireEvent.press(await screen.findByRole('radio', { name: /Adult membership 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add the renewal to a basket' }));
    });
    expect(await screen.findByLabelText('Memberships turned off')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/)).toBeOnTheScreen();
  });

  it('DEC-016: turned off by default naming DEC-072; memberships stay readable and renewal is not offered', async () => {
    renderScreen(routes(switchesOn()));
    const off = await screen.findByTestId('state-turned-off');
    expect(within(off).getByLabelText('Memberships turned off')).toBeOnTheScreen();
    expect(within(off).getByText(/DEC-072/)).toBeOnTheScreen();
    expect(
      within(off).getByText('Memberships you already hold stay available here.'),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`membership-${G.membership}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
  });

  it('"Membership active" only inside the term; a membership without a term never reads active', async () => {
    renderScreen(
      routes({
        'GET /me/memberships': ok(
          page([
            membership({ termStartsAt: null, termEndsAt: null }),
            membership({
              enrollmentId: G.membershipChild,
              participantPersonId: G.child,
              termStartsAt: '2027-01-01T08:00:00.000Z',
              termEndsAt: '2028-01-01T08:00:00.000Z',
            }),
          ]),
        ),
      }),
    );
    const mine = await screen.findByTestId(`membership-${G.membership}`);
    expect(within(mine).getByLabelText('Term not available: ask the front desk')).toBeOnTheScreen();
    expect(within(mine).getByLabelText('Term: Not available')).toBeOnTheScreen();
    expect(within(mine).queryByLabelText('Membership active')).toBeNull();
    // Without a term it books nothing (POL-038), so booking is not offered.
    expect(
      within(mine).queryByRole('button', { name: 'Book a session with this membership' }),
    ).toBeNull();
    const child = screen.getByTestId(`membership-${G.membershipChild}`);
    expect(await within(child).findByLabelText('Starts Jan 1, 2027')).toBeOnTheScreen();
    expect(
      await within(child).findByLabelText('Term: Jan 1, 2027 to Dec 31, 2027'),
    ).toBeOnTheScreen();
  });

  it('cancellation goes to the enrollment with its opaque id, and stays offered while the switch is off (DEC-016)', async () => {
    renderScreen(routes(switchesOn()));
    const mine = await screen.findByTestId(`membership-${G.membership}`);
    fireEvent.press(within(mine).getByRole('button', { name: 'Cancel this membership' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${G.membership}/cancel`);
    expect(
      within(mine).queryByRole('button', { name: 'Book a session with this membership' }),
    ).toBeNull();
  });

  it('ENR-12: books a session inside the term with the included sessions, one key, in the facility zone', async () => {
    const app = renderScreen();
    await chooseIncludedSession();
    // A past session and one after the term ends are not offered.
    expect(screen.getAllByRole('radio', { name: /^Open play,/ })).toHaveLength(1);
    expect(
      screen.getByText('Only the activities this membership names are listed.'),
    ).toBeOnTheScreen();
    await bookWithMembership();
    expect(await screen.findByTestId(`membership-booked-${G.membership}`)).toBeOnTheScreen();
    expect(screen.getByLabelText('Booked')).toBeOnTheScreen();
    expect(screen.getByLabelText('Session: Tue, Oct 27, 6:00 PM to 7:00 PM PDT')).toBeOnTheScreen();
    expect(
      screen.getByText('It counts toward the sessions this membership includes for that period.'),
    ).toBeOnTheScreen();
    const [sent] = bookings(app);
    expect(sent?.body).toEqual({
      offeringId: G.season,
      sessionId: G.sessionNext,
      participantPersonId: G.self,
      membershipEnrollmentId: G.membership,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    // The usage is read again after the booking.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/memberships')).toHaveLength(2),
    );
  });

  it('every included session of the period used is "not available" with its code, and nothing else is claimed', async () => {
    renderScreen(
      routes({
        'POST /session-bookings': {
          status: 409,
          body: apiErrorBody('RESOURCE_CONFLICT', {
            details: { code: 'MEMBERSHIP_SESSIONS_USED', periodKey: 'month:2026-10', limit: 8 },
          }),
        },
      }),
    );
    await chooseIncludedSession();
    await bookWithMembership();
    const refused = await screen.findByTestId('membership-booking-refused');
    expect(
      within(refused).getByLabelText(
        'Not available: every session this membership includes for that period is used',
      ),
    ).toBeOnTheScreen();
    expect(
      within(refused).getByText('Error code: RESOURCE_CONFLICT (MEMBERSHIP_SESSIONS_USED)'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Book with this membership' })).toBeDisabled();
    expect(screen.queryByLabelText('Booked')).toBeNull();
  });

  it('§4.9: with no answer, "Check again" repeats the same booking with the same idempotency key', async () => {
    let attempts = 0;
    const app = renderScreen(
      routes({
        'POST /session-bookings': () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('Network request failed');
          return fakeResponse(201, membershipSessionBooking());
        },
      }),
    );
    await chooseIncludedSession();
    await bookWithMembership();
    expect(await screen.findByLabelText('No answer yet')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByTestId(`membership-booked-${G.membership}`)).toBeOnTheScreen();
    const [first, second] = bookings(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toEqual(first?.body);
  });

  it('CAPABILITY_DISABLED on a membership booking is turned off with its code', async () => {
    renderScreen(
      routes({
        'POST /session-bookings': {
          status: 403,
          body: capabilityDisabledBody('memberships', ['DEC-016', 'DEC-072']),
        },
      }),
    );
    await chooseIncludedSession();
    await bookWithMembership();
    expect(await screen.findByLabelText('Memberships turned off')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/)).toBeOnTheScreen();
  });

  it('shows the API error code with "Try again"; a refused read is "not available"; none is the empty state', async () => {
    let calls = 0;
    renderScreen(
      routes({
        'GET /me/memberships': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'c-m' }))
            : fakeResponse(200, page([membership()]));
        },
      }),
    );
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: c-m/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId(`membership-${G.membership}`)).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderScreen(
      routes({ 'GET /me/memberships': { status: 403, body: apiErrorBody('ACCESS_DENIED') } }),
    );
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderScreen(routes({ 'GET /me/memberships': ok(page([])) }));
    expect(await screen.findByRole('header', { name: 'No memberships' })).toBeOnTheScreen();
  });
});
