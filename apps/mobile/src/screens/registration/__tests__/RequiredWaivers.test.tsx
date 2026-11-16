/**
 * SCR-C-13 Required forms: a required liability waiver (SPK-REG-011, proposed amendment PA-01;
 * capability `liability_waivers`, DEC-095 pending). The offering's required waiver families are
 * shown per participant with the API's judgement and accepted here; with the switch off nothing
 * about waivers is shown or asked for.
 */
import { fakeResponse, type FakeHandler, type FakeRequest } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  line,
  policyVersion,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { mePermissions } from '../../../testing/test-app';
import { RequiredFormsScreen } from '../RequiredFormsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const WAIVER_VERSION = '0192f1a0-0000-7000-8000-0000000000e1';
const T = '2026-10-20T10:00:00.000Z';

const versionRef = {
  policyVersionId: WAIVER_VERSION,
  version: 4,
  title: 'Liability waiver',
  effectiveFrom: T,
};

function personWaiver(overrides: Record<string, unknown> = {}) {
  return {
    policyKey: 'liability',
    title: 'Liability waiver',
    status: 'missing',
    reason: 'never_accepted',
    currentVersion: versionRef,
    acceptance: null,
    validUntil: null,
    lapsedAt: null,
    rule: { reacceptOnNewVersion: false, renewEveryMonths: null, enforcement: 'warn' },
    evaluatedAt: T,
    history: [],
    overrides: [],
    ...overrides,
  };
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['liability_waivers'] }),
    // one line, for Ada, with no ordinary form: the waiver is the only thing required
    'GET /baskets/{id}': {
      status: 200,
      body: basket({
        lines: [
          line({
            policies: { ...line().policies, requiredFormPolicyVersionIds: [] },
          }),
        ],
      }),
    },
    'GET /policy-versions/{id}': {
      status: 200,
      body: policyVersion(WAIVER_VERSION, 'Liability waiver'),
    },
    'GET /acknowledgments': { status: 200, body: [] },
    'GET /offerings/{id}/required-waivers': {
      status: 200,
      body: {
        offeringId: IDS.offering,
        waivers: [{ policyKey: 'liability', enforcement: 'warn', currentVersion: versionRef }],
      },
    },
    'GET /people/{id}/waivers': (req: FakeRequest) =>
      fakeResponse(200, { personId: req.params.id, evaluated: true, waivers: [personWaiver()] }),
    ...overrides,
  };
}

describe('SCR-C-13 RequiredFormsScreen: required waiver', () => {
  it('SPK-REG-011: a required waiver is shown for the participant as not accepted yet, and the guardian accepts it as themselves', async () => {
    let accepted = false;
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /people/{id}/waivers': (req: FakeRequest) =>
          fakeResponse(200, {
            personId: req.params.id,
            evaluated: true,
            waivers: [
              accepted
                ? personWaiver({
                    status: 'current',
                    reason: null,
                    acceptance: {
                      acknowledgmentId: IDS.ack,
                      policyVersionId: WAIVER_VERSION,
                      version: 4,
                      subjectPersonId: IDS.childA,
                      signedByPersonId: IDS.parent,
                      basis: 'guardian',
                      method: 'digital',
                      signedAt: T,
                      paperDatedOn: null,
                      recordedByKind: 'customer',
                      recordedByPersonId: null,
                      acceptedAt: T,
                      status: 'active',
                      withdrawnAt: null,
                      withdrawnReason: null,
                    },
                  })
                : personWaiver(),
            ],
          }),
        'POST /waiver-acceptances': () => {
          accepted = true;
          return fakeResponse(201, { id: IDS.ack });
        },
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Waivers for Ada' })).toBeOnTheScreen();
    const card = await screen.findByTestId(`waiver-liability-${IDS.childA}`);
    expect(within(card).getByText('Liability waiver (version 4)')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Waiver not accepted yet')).toBeOnTheScreen();
    expect(await within(card).findByText('Liability waiver wording.')).toBeOnTheScreen();
    const accept = within(card).getByRole('button', { name: 'Accept "Liability waiver" for Ada' });
    expect(accept).toBeDisabled();
    fireEvent.press(
      within(card).getByRole('checkbox', {
        name: 'I have read "Liability waiver" and accept it for Ada',
      }),
    );
    fireEvent.press(accept);
    expect(await screen.findByLabelText('Waiver accepted')).toBeOnTheScreen();
    expect(screen.getByText('Accepted on 20 Oct 2026 by you')).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/waiver-acceptances')?.body).toEqual({
      subjectPersonId: IDS.childA,
      policyKey: 'liability',
      policyVersionId: WAIVER_VERSION,
      method: 'digital',
      evidence: { channel: 'customer_app', appVersion: expect.any(String) },
    });
  });

  it('an offering that requires no waiver still reads "No forms required"', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/required-waivers': {
          status: 200,
          body: { offeringId: IDS.offering, waivers: [] },
        },
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByText('No forms required')).toBeOnTheScreen();
    expect(screen.queryByRole('header', { name: /Waivers for/ })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/waivers')).toBe(false);
  });

  it('SPK-REG-011 with liability waivers turned off: the screen is as before and nothing about waivers is asked', async () => {
    const app = createRegistrationTestApp({
      routes: routes({ 'GET /me/permissions': mePermissions() }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByText('No forms required')).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByRole('header', { name: /Waivers for/ })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/required-waivers')).toBe(
      false,
    );
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/waivers')).toBe(false);
  });
});
