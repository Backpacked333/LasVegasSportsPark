/**
 * My memberships and my family's (Package G; SPK-COND-001, ENR-12, DEC-016, DEC-072, §4.9,
 * §4.14, SPK-SCHED-008, SPK-UX-008): what each membership includes exactly as its entitlement
 * states, sessions used per period, suspensions, the term in the facility's zone, whose it is;
 * renewal only at checkout and only while the switch is on (no target preselected, nothing charged
 * here); readable while off; errors with their code; not available.
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
  offering,
  ok,
  page,
  peopleRoutes,
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
    'GET /offerings/{id}': ok(offering({ id: G.membershipOffering, kind: 'membership' })),
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
