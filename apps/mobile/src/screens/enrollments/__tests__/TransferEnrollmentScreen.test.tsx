/**
 * SCR-C-33 transfer preview (SPK-REG-010, ENR-03, §4.8 `POST /v1/enrollments/{id}/transfer`,
 * §4.9, SPK-UX-008): the read-only `GET /v1/enrollments/{id}/transfer-preview` first (no command
 * to preview), the money consequence acknowledged and sent as `acceptedConsequence` with the
 * commit, a changed consequence never committed unseen (re-read at confirm, and the API's
 * CONSEQUENCE_CHANGED), approval-required transfers refused in the app, and one idempotency key
 * per intent.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  consequence,
  createRouterMock,
  enrollment,
  offering,
  page,
  transferPreview,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { TransferEnrollmentScreen, transferBlockers } from '../TransferEnrollmentScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const TARGET = offering({
  id: IDS.offeringB,
  name: 'Autumn U10 Sunday League',
  startsOn: '2026-09-06',
  endsOn: '2026-11-29',
});
const NEXT = enrollment({
  id: IDS.enrollmentB,
  offeringId: IDS.offeringB,
  transferredFromEnrollmentId: IDS.enrollment,
  revision: 2,
});
const PREVIOUS = enrollment({
  status: 'transferred',
  transferredToEnrollmentId: IDS.enrollmentB,
  revision: 4,
});

/** The read-only preview (ENR-03): answers whatever `preview()` returns at the time. */
function previewHandler(preview: () => unknown): FakeHandler {
  return () => fakeResponse(200, preview());
}

/** The commit: `committed()` decides the answer; the default commits the transfer. */
function commitHandler(committed?: () => Response): FakeHandler {
  return () =>
    committed
      ? committed()
      : fakeResponse(200, {
          ...transferPreview(),
          committed: true,
          newEnrollment: NEXT,
          previousEnrollment: PREVIOUS,
        });
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /enrollments/{id}': { status: 200, body: enrollment() },
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings': page([offering(), TARGET]),
    'GET /enrollments/{id}/transfer-preview': previewHandler(() => transferPreview()),
    'POST /enrollments/{id}/transfer': commitHandler(),
    ...overrides,
  };
}

function renderTransfer(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<TransferEnrollmentScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
  return app;
}

const transfers = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/enrollments/{id}/transfer');
const previews = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/enrollments/{id}/transfer-preview');

async function chooseAndPreview() {
  fireEvent.press(await screen.findByRole('radio', { name: /^Autumn U10 Sunday League/ }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Preview transfer' }));
  });
  await screen.findByTestId('transfer-preview');
}

describe('SCR-C-33 TransferEnrollmentScreen', () => {
  afterEach(settleApps);

  it('lists the other published activities of the same program, never the current one', async () => {
    const app = renderTransfer();
    expect(
      await screen.findByRole('radio', { name: /^Autumn U10 Sunday League/ }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: /^Autumn U10 League,/ })).toBeNull();
    const list = app.fake.requests.find((r) => r.route === '/offerings');
    expect(list?.query).toEqual({ programId: IDS.program, limit: '50' });
  });

  it('SPK-REG-010, ENR-03: previews with the read-only GET and shows both participations, dates, capacity, eligibility, money and approval', async () => {
    const app = renderTransfer();
    await chooseAndPreview();
    const [preview] = previews(app);
    expect(preview?.method).toBe('GET');
    expect(preview?.query).toEqual({ targetOfferingId: IDS.offeringB });
    // Previewing sends no command at all.
    expect(transfers(app)).toHaveLength(0);
    expect(screen.getByLabelText('Activity: Autumn U10 League')).toBeOnTheScreen();
    expect(screen.getByLabelText('Activity: Autumn U10 Sunday League')).toBeOnTheScreen();
    expect(screen.getByText('The two activities overlap in time.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Place: A place is available')).toBeOnTheScreen();
    expect(screen.getByLabelText('Eligibility: Eligible')).toBeOnTheScreen();
    expect(screen.getByLabelText('Approval: No approval needed')).toBeOnTheScreen();
    expect(screen.getByLabelText('Additional charge of $15.00')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeDisabled();
  });

  it('§4.9: commits only after the charge is accepted, with a new idempotency key, then shows the linked enrollments', async () => {
    // After the commit the refreshed record reads "transferred"; the success view must stay.
    let committed = false;
    const app = renderTransfer({
      'GET /enrollments/{id}': () => fakeResponse(200, committed ? PREVIOUS : enrollment()),
      'POST /enrollments/{id}/transfer': commitHandler(() => {
        committed = true;
        return fakeResponse(200, {
          ...transferPreview(),
          committed: true,
          newEnrollment: NEXT,
          previousEnrollment: PREVIOUS,
        });
      }),
    });
    await chooseAndPreview();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $15.00' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(await screen.findByTestId('transfer-success')).toHaveProp(
      'accessibilityLabel',
      'Transferred to Autumn U10 Sunday League',
    );
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.method === 'GET' && r.route === '/enrollments/{id}'),
      ).toHaveLength(2),
    );
    expect(screen.getByTestId('transfer-success')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Cannot be transferred')).toBeNull();
    // The old record now reads "Transferred to …"; the new one is confirmed (linked records).
    expect(
      screen.getByLabelText('Autumn U10 League, Transferred to Autumn U10 Sunday League'),
    ).toBeOnTheScreen();

    // Preview, re-read at confirm time (both GET), then one commit.
    expect(previews(app)).toHaveLength(2);
    const sent = transfers(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      targetOfferingId: IDS.offeringB,
      commit: true,
      // ENR-03: the consequence the customer accepted, exactly as previewed.
      acceptedConsequence: { kind: 'charge', amountMinor: 1500, currency: 'USD' },
      expectedRevision: 3,
    });
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^key-/);

    fireEvent.press(screen.getByRole('button', { name: /^Autumn U10 Sunday League, Confirmed/ }));
    expect(mockRouter.replace).toHaveBeenCalledWith(`/enrollments/${IDS.enrollmentB}`);
  });

  it('stale version: a consequence that changed since the preview is not committed and must be accepted again', async () => {
    let current = transferPreview();
    const app = renderTransfer({
      'GET /enrollments/{id}/transfer-preview': previewHandler(() => current),
    });
    await chooseAndPreview();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $15.00' }),
    );
    current = transferPreview({
      financialConsequence: consequence({
        kind: 'charge',
        amountMinor: 2500,
        explanation: 'Price changed.',
      }),
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(
      await screen.findByLabelText(
        'The money consequence changed since you reviewed it. Review it again.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Additional charge of $25.00')).toBeOnTheScreen();
    expect(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $25.00' }),
    ).not.toBeChecked();
    expect(transfers(app)).toHaveLength(0);
  });

  it('ENR-03: a consequence the API says changed between the re-read and the commit is not committed and must be accepted again', async () => {
    const app = renderTransfer({
      'POST /enrollments/{id}/transfer': commitHandler(() =>
        fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', {
            message:
              'The financial consequence changed since it was previewed; review and accept it again.',
            nextAction: 'resolve_conflict',
            details: {
              code: 'CONSEQUENCE_CHANGED',
              consequence: consequence({
                kind: 'charge',
                amountMinor: 2500,
                explanation: 'Price changed.',
              }),
            },
          }),
        ),
      ),
    });
    await chooseAndPreview();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $15.00' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(
      await screen.findByLabelText(
        'The money consequence changed since you reviewed it. Review it again.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Additional charge of $25.00')).toBeOnTheScreen();
    expect(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $25.00' }),
    ).not.toBeChecked();
    expect(screen.queryByTestId('transfer-success')).toBeNull();
    expect(transfers(app)).toHaveLength(1);
  });

  it('SPK-REG-010: "No money changes" that became a charge on the re-preview is never committed unseen', async () => {
    let current = transferPreview({
      financialConsequence: consequence({ kind: 'none', amountMinor: 0 }),
    });
    const app = renderTransfer({
      'GET /enrollments/{id}/transfer-preview': previewHandler(() => current),
    });
    await chooseAndPreview();
    current = transferPreview({
      financialConsequence: consequence({
        kind: 'charge',
        amountMinor: 2500,
        explanation: 'Price changed.',
      }),
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(
      await screen.findByLabelText(
        'The money consequence changed since you reviewed it. Review it again.',
      ),
    ).toBeOnTheScreen();
    expect(transfers(app)).toHaveLength(0);
  });

  it('SPK-UX-008: a preview that cannot be read shows the code and a retry; nothing is committed', async () => {
    const app = renderTransfer({
      'GET /enrollments/{id}/transfer-preview': () =>
        fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
    });
    fireEvent.press(await screen.findByRole('radio', { name: /^Autumn U10 Sunday League/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Preview transfer' }));
    });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByTestId('transfer-preview')).toBeNull();
    expect(transfers(app)).toHaveLength(0);
  });

  it('lists no targets when the current activity cannot be read (never every offering)', async () => {
    const app = renderTransfer({
      'GET /offerings/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(
      await screen.findByText('Transfers for this activity are handled by the front desk.'),
    ).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings')).toHaveLength(0);
  });

  it('permission restriction: a transfer that needs staff approval cannot be committed in the app', async () => {
    renderTransfer({
      'GET /enrollments/{id}/transfer-preview': previewHandler(() =>
        transferPreview({ requiredApproval: true }),
      ),
    });
    await chooseAndPreview();
    expect(screen.getByLabelText('This transfer cannot be made in the app')).toBeOnTheScreen();
    expect(screen.getByText(/Staff approval is needed\. Ask the front desk/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
  });

  it('validation failure: an ineligible target shows the API reasons and no commit', async () => {
    renderTransfer({
      'GET /enrollments/{id}/transfer-preview': previewHandler(() =>
        transferPreview({
          eligibility: {
            eligible: false,
            policyVersionId: null,
            referenceDate: null,
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            reasons: [
              {
                code: 'age_band',
                severity: 'blocking',
                message: 'The participant is older than this age band.',
                source: { type: 'policy', id: null },
                requiredAction: 'choose_other',
              },
            ],
            alternatives: [],
            overridden: false,
          },
        }),
      ),
    });
    await chooseAndPreview();
    expect(screen.getByLabelText('Eligibility: Not eligible')).toBeOnTheScreen();
    expect(screen.getByText('▲ The participant is older than this age band.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
  });

  it('waitlist first: when others are waiting, the transfer is not offered (DEC-006 is the API’s)', () => {
    const blockers = transferBlockers(
      transferPreview({
        capacity: { released: [], required: [], waitlistAhead: 2, sufficient: false },
      }) as never,
    );
    expect(blockers).toEqual(['2 people are waiting for this activity; places go to them first.']);
  });

  it('RESOURCE_CONFLICT APPROVAL_REQUIRED on commit reads "Staff approval needed", nothing changed', async () => {
    renderTransfer({
      'POST /enrollments/{id}/transfer': commitHandler(() =>
        fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', {
            message: 'The target offering requires staff approval; ask staff to transfer.',
            nextAction: 'resolve_conflict',
            details: { code: 'APPROVAL_REQUIRED' },
          }),
        ),
      ),
    });
    await chooseAndPreview();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $15.00' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(await screen.findByLabelText('Staff approval needed')).toBeOnTheScreen();
  });

  it('§4.9: a commit with no answer is checked again with the same idempotency key', async () => {
    let commits = 0;
    const app = renderTransfer({
      'POST /enrollments/{id}/transfer': commitHandler(() => {
        commits += 1;
        if (commits === 1) throw new TypeError('Network request failed');
        return fakeResponse(200, {
          ...transferPreview(),
          committed: true,
          newEnrollment: NEXT,
          previousEnrollment: PREVIOUS,
        });
      }),
    });
    await chooseAndPreview();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I accept: Additional charge of $15.00' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Transfer' }));
    });
    expect(await screen.findByLabelText('No answer yet')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByTestId('transfer-success')).toBeOnTheScreen();
    const commitKeys = transfers(app).map((r) => r.headers['idempotency-key']);
    expect(commitKeys).toHaveLength(2);
    expect(commitKeys[0]).toBe(commitKeys[1]);
  });

  it('a registration that is not confirmed cannot be transferred', async () => {
    renderTransfer({
      'GET /enrollments/{id}': { status: 200, body: enrollment({ status: 'pending' }) },
    });
    expect(await screen.findByLabelText('Cannot be transferred')).toBeOnTheScreen();
  });

  it('§4.10: an enrollment this account may not see reads "Not available"', async () => {
    renderTransfer({ 'GET /enrollments/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Preview transfer' })).toBeNull();
  });
});
