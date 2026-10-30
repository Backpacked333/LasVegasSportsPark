/**
 * SCR-C-32 for a membership (§3.16, SPK-COND-001; ENR-12; capability `memberships`, DEC-016,
 * DEC-072): term, included attendance, usage and suspensions from `GET /me/memberships`; the
 * renewal (`POST /enrollments/{id}/renew`) only while the switch is on, into the open basket the
 * API lists, with one idempotency key; CAPABILITY_DISABLED as "turned off"; suspension is the
 * front desk's (no customer command); plus the enrollment's own offering and a recovery that the
 * checkout list reports.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  enrollment,
  offering,
  page,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { mePermissions } from '../../../testing/test-app';
import { EnrollmentDetailScreen } from '../EnrollmentDetailScreen';
import { PIDS, enrollmentOffering, membership } from './participation-fixtures';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const MEMBERSHIP = enrollment({
  intent: 'membership',
  offeringId: PIDS.membershipOffering,
  offering: enrollmentOffering({
    id: PIDS.membershipOffering,
    name: 'Family membership',
    kind: 'membership',
    startsOn: '2026-09-01',
    endsOn: '2027-08-31',
  }),
  pendingReason: null,
});
const NEXT_TERM = offering({
  id: IDS.offeringB,
  name: 'Family membership 2027',
  kind: 'membership',
  startsOn: '2027-09-01',
  endsOn: '2028-08-31',
});
const OPEN_BASKET = { id: PIDS.basket, status: 'open', lines: [], revision: 2 };

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /enrollments/{id}': { status: 200, body: MEMBERSHIP },
    'GET /me/memberships': page([membership()]),
    'GET /offerings': page([NEXT_TERM]),
    'GET /me/baskets': page([OPEN_BASKET]),
    ...overrides,
  };
}

function renderMembership(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
  return app;
}

const renewals = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/enrollments/{id}/renew');

describe('SCR-C-32 membership (Package G memberships)', () => {
  afterEach(settleApps);

  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-COND-001: shows the term, included sessions, usage and suspensions; suspending is the front desk’s', async () => {
    renderMembership();
    const section = await screen.findByTestId('membership');
    expect(
      await within(section).findByLabelText('Includes: 4 sessions each month'),
    ).toBeOnTheScreen();
    // Term instants in the facility zone of the membership's offering (America/Los_Angeles).
    expect(
      within(section).getByLabelText(
        /^Term: Tue, Sep 1, 12:00 AM PDT to Wed, Sep 1, 12:00 AM PDT$/,
      ),
    ).toBeOnTheScreen();
    expect(within(section).getByLabelText('Used (2026-10): 2 of 4')).toBeOnTheScreen();
    expect(
      within(section).getByLabelText(/^Suspended from .+ until the front desk ends it$/),
    ).toBeOnTheScreen();
    expect(
      within(section).getByText(/Suspending a membership is arranged by the front desk/),
    ).toBeOnTheScreen();
    // No suspension command is ever offered to the customer.
    expect(screen.queryByRole('button', { name: /Suspend/ })).toBeNull();
  });

  it('DEC-016: while memberships are turned off the renewal reads turned off and nothing is sent', async () => {
    const app = renderMembership();
    expect(await screen.findByLabelText('Membership renewal turned off')).toBeOnTheScreen();
    expect(screen.getByText(/DEC-016, DEC-072/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Add the renewal to your basket' })).toBeNull();
    expect(renewals(app)).toHaveLength(0);
  });

  it('ENR-12: renews into the chosen membership offering, adding it to the open basket the API lists', async () => {
    const app = renderMembership({
      'GET /me/permissions': mePermissions({ enabled: ['memberships'] }),
      'POST /enrollments/{id}/renew': { status: 201, body: { ...OPEN_BASKET, revision: 3 } },
    });
    const add = await screen.findByRole('button', { name: 'Add the renewal to your basket' });
    expect(add).toBeDisabled();
    fireEvent.press(await screen.findByRole('radio', { name: /^Family membership 2027/ }));
    await waitFor(() => expect(add).not.toBeDisabled());
    await act(async () => {
      fireEvent.press(add);
    });
    // The push follows the renewal's invalidations (timer-batched): wait for it, then read.
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${PIDS.basket}`),
    );
    const [sent] = renewals(app);
    expect(sent?.params.id).toBe(IDS.enrollment);
    expect(sent?.body).toEqual({ targetOfferingId: IDS.offeringB, basketId: PIDS.basket });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(renewals(app)).toHaveLength(1);
    expect(app.fake.requests.find((r) => r.route === '/offerings')?.query).toEqual({
      kind: 'membership',
      limit: '20',
    });
  });

  it('DEC-016: a renewal refused with CAPABILITY_DISABLED shows the turned-off state, not a failure', async () => {
    renderMembership({
      'GET /me/permissions': mePermissions({ enabled: ['memberships'] }),
      // The body the kernel sends (ACCESS_DENIED, contact_support_or_request_access).
      'POST /enrollments/{id}/renew': () =>
        fakeResponse(403, capabilityDisabledBody('memberships', ['DEC-016', 'DEC-072'])),
    });
    fireEvent.press(await screen.findByRole('radio', { name: /^Family membership 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add the renewal to your basket' }));
    });
    expect(await screen.findByLabelText('Memberships turned off')).toBeOnTheScreen();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('SPK-UX-008: open baskets that cannot be read show their code and a retry; the renewal waits for them', async () => {
    let failing = true;
    const app = renderMembership({
      'GET /me/permissions': mePermissions({ enabled: ['memberships'] }),
      'GET /me/baskets': () =>
        failing
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
            )
          : fakeResponse(200, { items: [OPEN_BASKET], nextCursor: null }),
      'POST /enrollments/{id}/renew': { status: 201, body: { ...OPEN_BASKET, revision: 3 } },
    });
    fireEvent.press(await screen.findByRole('radio', { name: /^Family membership 2027/ }));
    const failed = await screen.findByTestId('renewal-baskets-error');
    expect(within(failed).getByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Add the renewal to your basket' })).toBeDisabled();
    expect(renewals(app)).toHaveLength(0);

    failing = false;
    await act(async () => {
      fireEvent.press(within(failed).getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.queryByTestId('renewal-baskets-error')).toBeNull());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add the renewal to your basket' }),
      ).not.toBeDisabled(),
    );
  });

  it('SPK-UX-008: a membership read that fails shows its code and retry; one not in the first page points to Memberships', async () => {
    const failing = createTestApp({
      routes: routes({
        'GET /me/memberships': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    const first = render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, {
      wrapper: failing.wrapper,
    });
    const section = await screen.findByTestId('membership');
    expect(
      await within(section).findByText(/Error code: INTEGRATION_UNAVAILABLE/),
    ).toBeOnTheScreen();
    expect(within(section).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    first.unmount();

    renderMembership({ 'GET /me/memberships': page([]) });
    fireEvent.press(await screen.findByRole('button', { name: 'Open memberships' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/memberships');
  });
});

describe('SCR-C-32 one enrollment (stage-3 reads)', () => {
  afterEach(settleApps);

  it('ENR-02: shows the offering the enrollment carries, also a closed one, and what a pending one waits for', async () => {
    const app = createTestApp({
      routes: {
        ...accountRoutes(),
        'GET /enrollments/{id}': {
          status: 200,
          body: enrollment({
            status: 'pending',
            confirmedAt: null,
            offeringId: IDS.offeringClosed,
            offering: enrollmentOffering(),
            pendingReason: 'forms',
          }),
        },
      },
    });
    render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Spring U10 League 2026' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Dates: Mar 7, 2026 to May 30, 2026')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Registration pending: a required form is not signed'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/A required form is not signed yet/)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}')).toBe(false);
  });

  it('§4.11: a pending enrollment whose checkout the API lists as recovery_required says so', async () => {
    const app = createTestApp({
      routes: {
        ...accountRoutes(),
        'GET /enrollments/{id}': {
          status: 200,
          body: enrollment({
            status: 'pending',
            confirmedAt: null,
            basketId: PIDS.basket,
            offering: enrollmentOffering(),
            pendingReason: 'payment',
          }),
        },
        'GET /me/registration-checkouts': page([
          {
            id: PIDS.checkout,
            basketId: PIDS.basket,
            quoteId: PIDS.checkout,
            status: 'recovery_required',
          },
        ]),
      },
    });
    render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/do not pay again/)).toBeOnTheScreen();
  });
});
