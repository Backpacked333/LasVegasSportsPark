/**
 * SCR-C-08 Offering detail (SPK-CAT-001, SPK-REG-002, SPK-SCHED-008, POL-007): every offering
 * fact the public view carries, times in the facility's zone, the read-only eligibility of each
 * person the account may register (registration options, ENR-05), the registration entry point
 * only while registration is open, and the SPK-UX-008 states (not available, error with code,
 * offline with registration disabled, signed out).
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  familyRoutes,
  ineligible,
  offering,
  optionsHandler,
  policyVersion,
  registrationOptions,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { OfferingDetailScreen } from '../OfferingDetailScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const SESSION = {
  id: '0192f1a0-0000-7000-8000-0000000000e1',
  offeringId: IDS.offering,
  sequence: 1,
  title: 'Week 1',
  scheduledStart: '2026-11-02T23:00:00.000Z',
  scheduledEnd: '2026-11-03T00:00:00.000Z',
  schedulingEventId: null,
  capacityOverride: null,
  status: 'scheduled',
  canceledAt: null,
  cancelReason: null,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function routes(overrides = {}) {
  return {
    ...familyRoutes(),
    'GET /offerings/{id}/registration-options': optionsHandler(),
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings/{id}/sessions': { status: 200, body: [SESSION] },
    'GET /policy-versions/{id}': (req: FakeRequest) =>
      fakeResponse(
        200,
        req.params.id === IDS.formPolicy
          ? policyVersion(IDS.formPolicy, 'Medical consent')
          : policyVersion(IDS.cancellationPolicy, 'Program cancellation', 'cancellation'),
      ),
    ...overrides,
  };
}

describe('SCR-C-08 OfferingDetailScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-CAT-001: shows the offering facts, price basis, forms and cancellation policy', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Autumn Youth Program' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration open')).toBeOnTheScreen();
    expect(screen.getByLabelText('Format: 7v7')).toBeOnTheScreen();
    expect(screen.getByLabelText('Location: Field 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Dates: Nov 2, 2026 to Dec 14, 2026')).toBeOnTheScreen();
    expect(screen.getByLabelText('Age: Ages 8 to 10')).toBeOnTheScreen();
    expect(screen.getByText('20 places')).toBeOnTheScreen();
    expect(screen.getByLabelText('Base price: $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Facility fee: $5.00, added to the price')).toBeOnTheScreen();
    expect(await screen.findByText('• Medical consent')).toBeOnTheScreen();
    expect(screen.getByText('Program cancellation')).toBeOnTheScreen();
    expect(await screen.findByLabelText(/^Week 1: /)).toBeOnTheScreen();
  });

  it('SPK-SCHED-008: session and registration times are in the facility time zone, with the facility named', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Facility: Test complex')).toBeOnTheScreen();
    // 23:00 UTC on Nov 2 is 3:00 PM in Los Angeles (PST).
    expect(await screen.findByLabelText('Week 1: Mon, Nov 2, 3:00 PM PST')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Registration closes: Fri, Oct 30, 8:00 AM PDT'),
    ).toBeOnTheScreen();
  });

  it('SPK-REG-002: shows read-only eligibility per person the account may register, and a view-only child as not available', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({
            availableIntents: ['youth'],
            participants: [
              {
                personId: IDS.childA,
                intents: [
                  {
                    intent: 'youth',
                    eligibility: registrationOptions().participants[0]!.intents[0]!.eligibility,
                  },
                ],
              },
              {
                personId: IDS.childB,
                intents: [
                  { intent: 'youth', eligibility: ineligible('Ben is older than this age band.') },
                ],
              },
            ],
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Ada, Youth enrollment: Eligible')).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        'Ben, Youth enrollment: Not eligible. Ben is older than this age band.. Choose an activity for this age.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Cy: Not available to register from your account'),
    ).toBeOnTheScreen();
    // Nothing is held or written by the preview: a read only.
    expect(app.fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('SPK-UX-008: an eligibility read that fails shows its code; the rest of the detail stays', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { message: 'Options failed.' })),
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Autumn Youth Program' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Register' })).toBeOnTheScreen();
  });

  it('opens the registration chooser (SCR-C-09) from Register', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Register' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/start/${IDS.offering}`);
  });

  it('SPK-CAT-004: a paused registration keeps existing participation and offers no registration', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ publicationState: 'registration_paused' }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(
      await screen.findByText('Registration is paused. Existing registrations are kept.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();
  });

  it('signed out: asks to sign in to register and reads no policy (they need an account)', async () => {
    const app = createRegistrationTestApp({ session: null, routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in to register' })).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/policy-versions/{id}')).toBe(false);
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/registration-options')).toBe(
      false,
    );
    expect(
      screen.getByText('This activity has a cancellation policy. Sign in to read it.'),
    ).toBeOnTheScreen();
  });

  it('§4.10: a withdrawn or unknown offering reads not available', async () => {
    const app = createRegistrationTestApp({ routes: {} });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('shows the API error code with a recovery action', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { message: 'Something failed.' })),
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.15: offline keeps the detail with its age and disables registration', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Register' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
    expect(screen.getByText('Registration needs a connection.')).toBeOnTheScreen();
    expect(screen.getByText('Showing information from just now.')).toBeOnTheScreen();
  });
});
