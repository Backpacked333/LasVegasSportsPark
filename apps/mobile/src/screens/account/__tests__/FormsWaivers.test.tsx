/**
 * SCR-C-30 "Forms": liability waivers (SPK-REG-011, proposed amendment PA-01; SPK-REG-009;
 * capability `liability_waivers`, DEC-095 pending). `GET /v1/people/{id}/waivers` per person the
 * account may complete forms for, accepting with `POST /v1/waiver-acceptances`, and a paper
 * record that never reads as a signature.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { pullToRefresh } from '../../../testing/ui-surfaces';
import { FormsScreen } from '../FormsScreen';
import { CHILD, CHILD_TWO, me, namesRoute, ok, OTHER_ADULT, person, SELF } from './fixtures';

const SAM = person(CHILD, 'Sam', 'Morgan', 'child');
const JORDAN = person(OTHER_ADULT, 'Jordan', 'Lee');
const VERSION = '0192f1a0-0000-7000-8000-00000000e501';
const STAFF = '0192f1a0-0000-7000-8000-00000000a009';

const FAMILY = me({
  authorities: [
    { subjectPersonId: CHILD, permissions: ['view', 'complete_forms'] },
    // View only: this account may read Rio's forms but not their waivers.
    { subjectPersonId: CHILD_TWO, permissions: ['view'] },
  ],
});

const version = {
  policyVersionId: VERSION,
  version: 4,
  title: 'Liability waiver',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
};
const rule = { reacceptOnNewVersion: false, renewEveryMonths: null, enforcement: 'warn' };

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
    rule,
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    history: [],
    overrides: [],
    ...overrides,
  };
}

function acceptance(overrides: Record<string, unknown> = {}) {
  return {
    acknowledgmentId: '0192f1a0-0000-7000-8000-00000000e601',
    policyVersionId: VERSION,
    version: 4,
    subjectPersonId: CHILD,
    signedByPersonId: SELF,
    basis: 'guardian',
    method: 'digital',
    signedAt: '2026-10-01T15:00:00.000Z',
    paperDatedOn: null,
    recordedByKind: 'customer',
    recordedByPersonId: null,
    acceptedAt: '2026-10-01T15:00:00.000Z',
    status: 'active',
    withdrawnAt: null,
    withdrawnReason: null,
    ...overrides,
  };
}

const POLICY = {
  id: VERSION,
  kind: 'waiver',
  key: 'liability',
  version: 4,
  title: 'Liability waiver',
  content: {
    text: 'I accept the risks of taking part.',
    renewal: { reacceptOnNewVersion: false, renewEveryMonths: null },
    enforcement: 'warn',
    overrideRoles: [],
  },
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  approvalStatus: 'approved',
  approvedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
  retiredReason: null,
  revision: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function waiversApp(
  byPerson: Record<string, unknown[]>,
  routes: Record<string, unknown> = {},
  enabled = true,
) {
  return createTestApp({
    routes: {
      'GET /me': ok(FAMILY),
      'GET /me/permissions': mePermissions({ enabled: enabled ? ['liability_waivers'] : [] }),
      'GET /person-names': namesRoute([SAM, JORDAN]),
      'GET /acknowledgments': ok([]),
      'GET /policy-versions/{id}': ok(POLICY),
      'GET /people/{id}/waivers': (request: { params: Record<string, string> }) =>
        fakeResponse(200, {
          personId: request.params.id,
          evaluated: true,
          waivers: byPerson[request.params.id ?? ''] ?? [],
        }),
      ...(routes as Record<string, never>),
    },
  });
}

describe('SCR-C-30 FormsScreen: liability waivers', () => {
  it("SPK-REG-011: shows each waiver's status for the person and for a child they may complete forms for, and lets the guardian accept", async () => {
    const stored: Record<string, unknown[]> = {
      [SELF]: [
        waiver({
          status: 'current',
          reason: null,
          acceptance: acceptance({ subjectPersonId: SELF, basis: 'self' }),
        }),
      ],
      [CHILD]: [waiver()],
    };
    const app = waiversApp(stored, {
      'POST /waiver-acceptances': () => {
        stored[CHILD] = [waiver({ status: 'current', reason: null, acceptance: acceptance() })];
        return fakeResponse(201, { id: '0192f1a0-0000-7000-8000-00000000e601' });
      },
    });
    render(<FormsScreen />, { wrapper: app.wrapper });
    const mine = await screen.findByLabelText('Waivers for You, Alex Morgan');
    expect(await within(mine).findByLabelText('Waiver accepted')).toBeOnTheScreen();
    expect(within(mine).getByText('Accepted on 1 Oct 2026 by you')).toBeOnTheScreen();
    // Sam's waiver waits under "To sign"; Alex's, in force, is under "Signed"
    const sams = await screen.findByLabelText('To sign for Sam Morgan');
    expect(await within(sams).findByLabelText('Waiver not accepted yet')).toBeOnTheScreen();
    expect(within(sams).getByText('It has not been accepted yet.')).toBeOnTheScreen();
    // the wording of the version in force is shown before accepting
    expect(await within(sams).findByText('I accept the risks of taking part.')).toBeOnTheScreen();
    const accept = within(sams).getByRole('button', {
      name: 'Accept "Liability waiver" for Sam Morgan',
    });
    expect(accept).toBeDisabled();
    fireEvent.press(
      within(sams).getByRole('checkbox', {
        name: 'I have read "Liability waiver" and accept it for Sam Morgan',
      }),
    );
    fireEvent.press(accept);
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/waiver-acceptances')).toBe(true),
    );
    const sent = app.fake.requests.find((r) => r.route === '/waiver-acceptances');
    // the customer accepts as themselves, digitally: no signer, no paper date is ever sent
    expect(sent?.body).toEqual({
      subjectPersonId: CHILD,
      policyKey: 'liability',
      policyVersionId: VERSION,
      method: 'digital',
      evidence: { channel: 'customer_app', appVersion: expect.any(String) },
    });
    expect(
      await within(await screen.findByLabelText('Waivers for Sam Morgan')).findByLabelText(
        'Waiver accepted',
      ),
    ).toBeOnTheScreen();
    // a person held with view only: their waivers are not asked for
    expect(
      app.fake.requests.some(
        (r) => r.route === '/people/{id}/waivers' && r.params.id === CHILD_TWO,
      ),
    ).toBe(false);
  });

  it('SPK-REG-009: a waiver the front desk recorded from paper reads as recorded from paper, never as signed by the customer', async () => {
    const paper = acceptance({
      method: 'paper',
      paperDatedOn: '2026-09-20',
      recordedByKind: 'staff',
      recordedByPersonId: STAFF,
      signedAt: '2026-09-22T17:00:00.000Z',
      acceptedAt: '2026-09-20T00:00:00.000Z',
    });
    const app = waiversApp(
      { [CHILD]: [waiver({ status: 'current', reason: null, acceptance: paper })] },
      {
        // the same record also appears among the acknowledgments of the child
        'GET /acknowledgments': (request: { query: Record<string, string> }) =>
          fakeResponse(
            200,
            request.query.subjectPersonId === CHILD
              ? [
                  {
                    id: paper.acknowledgmentId,
                    subjectPersonId: CHILD,
                    policyVersionId: VERSION,
                    signedByPersonId: SELF,
                    basis: 'guardian',
                    recordedByPersonId: STAFF,
                    recordedByKind: 'staff',
                    signedAt: paper.signedAt,
                    evidence: {},
                    method: 'paper',
                    paperDatedOn: '2026-09-20',
                    status: 'active',
                    withdrawnAt: null,
                    withdrawnReason: null,
                    revision: 1,
                    createdAt: paper.signedAt,
                  },
                ]
              : [],
          ),
      },
    );
    render(<FormsScreen />, { wrapper: app.wrapper });
    const sams = await screen.findByLabelText('Waivers for Sam Morgan');
    expect(
      await within(sams).findByText(
        'Recorded from paper by the front desk (paper dated 20 Sep 2026); the paper names you as the signer',
      ),
    ).toBeOnTheScreen();
    const forms = await screen.findByLabelText('Forms for Sam Morgan');
    expect(
      await within(forms).findByLabelText(
        'Liability waiver, version 4, Recorded from paper by the front desk (paper dated 20 Sep 2026); the paper names you as the signer, Recorded from paper',
      ),
    ).toBeOnTheScreen();
    // nowhere on the screen does the paper record read as a signature
    expect(screen.queryByText(/^Signed /)).toBeNull();
    expect(screen.queryByLabelText(/, Signed$/)).toBeNull();
    expect(screen.queryByText(/Accepted on/)).toBeNull();
  });

  it('a lapsed waiver says why and is accepted again; a child cannot be accepted for without complete_forms', async () => {
    const app = waiversApp({
      [SELF]: [
        waiver({
          status: 'lapsed',
          reason: 'renewal_due',
          lapsedAt: '2026-10-01T15:00:00.000Z',
          acceptance: acceptance({
            subjectPersonId: SELF,
            basis: 'self',
            signedAt: '2025-10-01T15:00:00.000Z',
          }),
        }),
      ],
    });
    render(<FormsScreen />, { wrapper: app.wrapper });
    const mine = await screen.findByLabelText('To sign for You, Alex Morgan');
    expect(await within(mine).findByLabelText('Waiver needs accepting again')).toBeOnTheScreen();
    expect(within(mine).getByText('It was due for renewal on 1 Oct 2026.')).toBeOnTheScreen();
    expect(
      await within(mine).findByRole('button', { name: 'Accept "Liability waiver"' }),
    ).toBeOnTheScreen();
  });

  it('PA-11 SCR-C-30: "To sign" comes before "Signed", each person under their name, and pull to refresh reads again', async () => {
    const stored: Record<string, unknown[]> = {
      [SELF]: [
        waiver({
          status: 'current',
          reason: null,
          acceptance: acceptance({ subjectPersonId: SELF, basis: 'self' }),
        }),
      ],
      [CHILD]: [waiver()],
    };
    const app = waiversApp(stored);
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('To sign for Sam Morgan')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Waivers for You, Alex Morgan')).toBeOnTheScreen();
    const headers = screen.getAllByRole('header').map((h) => h.props.children as unknown);
    const toSign = headers.indexOf('To sign');
    const signed = headers.indexOf('Signed');
    expect(toSign).toBeGreaterThanOrEqual(0);
    expect(signed).toBeGreaterThan(toSign);
    // the person headings: Sam under "To sign", then everyone under "Signed"
    expect(headers.slice(toSign, signed)).toContain('Sam Morgan');
    expect(headers.slice(signed)).toEqual(
      expect.arrayContaining(['You, Alex Morgan', 'Sam Morgan']),
    );
    expect(screen.queryByText('Nothing to sign right now.')).toBeNull();
    // one read of each person's waivers serves both sections
    const reads = () =>
      app.fake.requests.filter((r) => r.route === '/people/{id}/waivers' && r.params.id === CHILD)
        .length;
    expect(reads()).toBe(1);
    await pullToRefresh(screen);
    await waitFor(() => expect(reads()).toBe(2));
  });

  it('SPK-REG-011 with liability waivers turned off: no waiver is shown and the API is not asked', async () => {
    const app = waiversApp({ [SELF]: [waiver()] }, {}, false);
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('You, Alex Morgan')).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/acknowledgments')).toBe(true),
    );
    expect(screen.queryByLabelText(/^Waivers for/)).toBeNull();
    expect(screen.queryByLabelText(/^To sign for/)).toBeNull();
    expect(screen.getByText('Nothing to sign right now.')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/waivers')).toBe(false);
    expect(app.fake.requests.some((r) => r.route === '/waiver-acceptances')).toBe(false);
  });
});
