/**
 * SCR-C-13 Required forms and acknowledgments (SPK-IAM-003, SPK-REG-009, POL-037): forms per
 * participant with their wording version, the signer rules (the customer signs as themselves, a
 * guardian with complete_forms signs for a child, nobody else), per-participant partial
 * completion, and the SPK-UX-008 states.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  acknowledgment,
  basket,
  familyRoutes,
  line,
  me,
  offering,
  policyVersion,
  waitlistEntry,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { RequiredFormsScreen } from '../RequiredFormsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const AGREE_ADA = 'I have read "Medical consent" and agree for Ada';
const SIGN_ADA = 'Sign "Medical consent" for Ada';

/** Acknowledgments the fake API holds, per participant. */
function acknowledgmentsStore() {
  const signed = new Set<string>();
  return {
    signed,
    handler: (req: FakeRequest) =>
      fakeResponse(
        200,
        signed.has(req.query.subjectPersonId as string)
          ? [acknowledgment(req.query.subjectPersonId as string, IDS.formPolicy)]
          : [],
      ),
  };
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /baskets/{id}': { status: 200, body: basket() },
    'GET /policy-versions/{id}': {
      status: 200,
      body: policyVersion(IDS.formPolicy, 'Medical consent'),
    },
    'GET /acknowledgments': { status: 200, body: [] },
    ...overrides,
  };
}

describe('SCR-C-13 RequiredFormsScreen', () => {
  it("POL-037: lists each participant's forms with the wording version and who must sign", async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Forms for Ada' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Forms for Ben' })).toBeOnTheScreen();
    expect(screen.getAllByText('Medical consent (version 2)')).toHaveLength(2);
    expect(screen.getAllByText('Medical consent wording.')).toHaveLength(2);
    expect(await screen.findByLabelText('0 of 2 forms signed')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'You sign as yourself. A guardian signs for a child; staff never sign for you.',
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-REG-009: a guardian signs for one child as themselves; the other child stays outstanding', async () => {
    const acks = acknowledgmentsStore();
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /acknowledgments': acks.handler,
        'POST /acknowledgments': (req) => {
          acks.signed.add((req.body as { subjectPersonId: string }).subjectPersonId);
          return fakeResponse(201, acknowledgment(IDS.childA, IDS.formPolicy));
        },
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    const sign = await screen.findByRole('button', { name: SIGN_ADA });
    expect(sign).toBeDisabled();
    fireEvent.press(screen.getByRole('checkbox', { name: AGREE_ADA }));
    expect(screen.getByRole('checkbox', { name: AGREE_ADA })).toBeChecked();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: SIGN_ADA }));
    });

    const sent = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/acknowledgments',
    );
    expect(sent?.body).toEqual({
      subjectPersonId: IDS.childA,
      policyVersionId: IDS.formPolicy,
      evidence: { channel: 'customer_app', appVersion: '0.1.0' },
    });
    // The app never names a signer: the API records the signed-in customer.
    expect(sent?.body).not.toHaveProperty('signedByPersonId');
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(await screen.findByLabelText(/^Signed on /)).toBeOnTheScreen();
    expect(await screen.findByLabelText('1 of 2 forms signed')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Sign "Medical consent" for Ben' }),
    ).toBeOnTheScreen();
  });

  it('SPK-IAM-003: a child the account may not complete forms for needs another guardian', async () => {
    const withoutForms = me({
      authorities: [{ subjectPersonId: IDS.childA, permissions: ['view', 'register', 'pay'] }],
    });
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me': { status: 200, body: withoutForms },
        'GET /baskets/{id}': { status: 200, body: basket({ lines: [line()] }) },
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Needs a guardian who can complete forms'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: SIGN_ADA })).toBeNull();
  });

  it('shows the API refusal of a signer as not available', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /acknowledgments': () =>
          fakeResponse(
            403,
            apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
              nextAction: 'request_participant_authority',
            }),
          ),
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: AGREE_ADA }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: SIGN_ADA }));
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('stale wording: a version that is no longer approved shows the error code and keeps the answer', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /acknowledgments': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'Only an approved policy version can be acknowledged.',
              nextAction: 'correct_input',
            }),
          ),
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: AGREE_ADA }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: SIGN_ADA }));
    });
    expect(
      await screen.findByText('Only an approved policy version can be acknowledged.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: AGREE_ADA })).toBeChecked();
  });

  it('reads the forms of a waitlist offer from its offering', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /waitlist-entries/{id}': { status: 200, body: waitlistEntry() },
        'GET /offerings/{id}': { status: 200, body: offering() },
      }),
    });
    render(<RequiredFormsScreen waitlistEntryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Forms for Ada' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Back to the waitlist offer' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/waitlist/${IDS.entry}`);
  });

  it('empty: says when no forms are required', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /baskets/{id}': {
          status: 200,
          body: basket({
            lines: [
              line({
                policies: {
                  eligibilityPolicyVersionId: null,
                  cancellationPolicyVersionId: null,
                  requiredFormPolicyVersionIds: [],
                  approvalPolicyVersionId: null,
                },
              }),
            ],
          }),
        },
      }),
    });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No forms required' })).toBeOnTheScreen();
  });

  it('offline: the answer is kept and signing is disabled', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RequiredFormsScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: AGREE_ADA }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: SIGN_ADA })).toBeDisabled();
    expect(
      screen.getAllByText('Signing needs a connection. Your answer is kept.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('checkbox', { name: AGREE_ADA })).toBeChecked();
  });
});
