/**
 * SCR-C-30 "Forms" (SPK-UX-002 "Account: ... forms ..."; SCR-C-13 wording versions; SPK-REG-009
 * the signer is recorded; SPK-IAM-003, §4.10, §4.14): `GET /v1/acknowledgments?subjectPersonId=`
 * per person, titles from `GET /v1/policy-versions/{id}`, and withdrawing a form one signed.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { FormsScreen } from '../FormsScreen';
import {
  apiError,
  CHILD,
  CHILD_TWO,
  me,
  namesRoute,
  ok,
  OTHER_ADULT,
  person,
  SELF,
} from './fixtures';

const SAM = person(CHILD, 'Sam', 'Morgan', 'child');
const JORDAN = person(OTHER_ADULT, 'Jordan', 'Lee');
const WAIVER = '0192f1a0-0000-7000-8000-00000000e301';
const PHOTO = '0192f1a0-0000-7000-8000-00000000e302';
const ACK_SELF = '0192f1a0-0000-7000-8000-00000000e401';
const ACK_SAM = '0192f1a0-0000-7000-8000-00000000e402';
const ACK_SAM_DESK = '0192f1a0-0000-7000-8000-00000000e403';

function acknowledgment(
  id: string,
  subjectPersonId: string,
  policyVersionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    subjectPersonId,
    policyVersionId,
    signedByPersonId: SELF,
    basis: subjectPersonId === SELF ? 'self' : 'guardian',
    recordedByPersonId: null,
    recordedByKind: 'customer',
    signedAt: '2026-10-01T15:00:00.000Z',
    evidence: {},
    status: 'active',
    withdrawnAt: null,
    withdrawnReason: null,
    revision: 1,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...overrides,
  };
}

function policy(id: string, title: string, text: string) {
  return {
    id,
    kind: 'participation_waiver',
    key: title.toLowerCase().replace(/\s+/g, '-'),
    version: 3,
    title,
    content: { text },
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
}

const POLICIES: Record<string, ReturnType<typeof policy>> = {
  [WAIVER]: policy(WAIVER, 'Participation waiver', 'I accept the risks of the activity.'),
  [PHOTO]: policy(PHOTO, 'Photo consent', 'Photos may be taken during sessions.'),
};

const FAMILY = me({
  authorities: [
    { subjectPersonId: CHILD, permissions: ['view', 'complete_forms'] },
    // Collect only: this account may not read Rio's forms, so none are asked for.
    { subjectPersonId: CHILD_TWO, permissions: ['collect'] },
  ],
});

const MAY_WITHDRAW = mePermissions({
  conditionalActions: [{ id: 'catalog.withdraw_acknowledgment', self: true }],
});

type Lists = Record<string, unknown[] | (() => Response)>;

function formsApp(lists: Lists, routes: Record<string, unknown> = {}, reachable = true) {
  return createTestApp({
    reachable,
    routes: {
      'GET /me': ok(FAMILY),
      'GET /person-names': namesRoute([SAM, JORDAN]),
      'GET /acknowledgments': (request: { query: Record<string, string> }) => {
        const list = lists[request.query.subjectPersonId ?? ''];
        if (typeof list === 'function') return list();
        return fakeResponse(200, list ?? []);
      },
      'GET /policy-versions/{id}': (request: { params: Record<string, string> }) => {
        const found = POLICIES[request.params.id ?? ''];
        return found
          ? fakeResponse(200, found)
          : apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' });
      },
      ...(routes as Record<string, never>),
    },
  });
}

const DEFAULT_LISTS: Lists = {
  [SELF]: [acknowledgment(ACK_SELF, SELF, WAIVER)],
  [CHILD]: [
    acknowledgment(ACK_SAM, CHILD, PHOTO),
    acknowledgment(ACK_SAM_DESK, CHILD, WAIVER, {
      signedByPersonId: OTHER_ADULT,
      recordedByKind: 'staff',
      recordedByPersonId: '0192f1a0-0000-7000-8000-00000000a009',
    }),
  ],
};

describe('SCR-C-30 FormsScreen', () => {
  it('SPK-REG-009: lists the forms signed for this person and each person held with view, with title, version, signer and date', async () => {
    const app = formsApp(DEFAULT_LISTS);
    render(<FormsScreen />, { wrapper: app.wrapper });
    const mine = await screen.findByLabelText('Forms for You, Alex Morgan');
    expect(
      await within(mine).findByLabelText(
        /^Participation waiver, version 3, Signed .* by you, Signed$/,
      ),
    ).toBeOnTheScreen();
    const sams = await screen.findByLabelText('Forms for Sam Morgan');
    expect(
      await within(sams).findByLabelText(/^Photo consent, version 3, Signed .* by you, Signed$/),
    ).toBeOnTheScreen();
    expect(
      await within(sams).findByLabelText(
        /^Participation waiver, version 3, Signed .* by Jordan Lee, recorded at the front desk, Signed$/,
      ),
    ).toBeOnTheScreen();
    const reads = app.fake.requests.filter((r) => r.route === '/acknowledgments');
    expect(reads.map((r) => r.query.subjectPersonId).sort()).toEqual([SELF, CHILD].sort());
    // Ids stay in requests, never on screen.
    expect(screen.queryByText(new RegExp(CHILD))).toBeNull();
  });

  it('SCR-C-13: shows the wording that was signed on request', async () => {
    const app = formsApp(DEFAULT_LISTS);
    render(<FormsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`form-${ACK_SELF}`);
    const show = await within(row).findByRole('button', { name: 'Show wording' });
    expect(show).toHaveProp('accessibilityHint', 'The wording that was signed');
    fireEvent.press(show);
    expect(within(row).getByText('I accept the risks of the activity.')).toBeOnTheScreen();
    fireEvent.press(within(row).getByRole('button', { name: 'Hide wording' }));
    expect(within(row).queryByText('I accept the risks of the activity.')).toBeNull();
  });

  it('withdraw is not offered unless GET /me/permissions lists catalog.withdraw_acknowledgment', async () => {
    const app = formsApp(DEFAULT_LISTS);
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId(`form-${ACK_SELF}`)).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Withdraw this form' })).toBeNull();
  });

  it('withdraws a form this person signed, with a reason and its revision; the list then shows it gone', async () => {
    let withdrawn = false;
    const app = formsApp(
      {
        ...DEFAULT_LISTS,
        [SELF]: () => fakeResponse(200, withdrawn ? [] : [acknowledgment(ACK_SELF, SELF, WAIVER)]),
      },
      {
        'GET /me/permissions': MAY_WITHDRAW,
        'POST /acknowledgments/{id}/withdraw': () => {
          withdrawn = true;
          return fakeResponse(
            200,
            acknowledgment(ACK_SELF, SELF, WAIVER, { status: 'withdrawn', revision: 2 }),
          );
        },
      },
    );
    render(<FormsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`form-${ACK_SELF}`);
    fireEvent.press(await within(row).findByRole('button', { name: 'Withdraw this form' }));
    // Only the signer may withdraw: the form the front desk recorded for Jordan has no action.
    expect(
      within(screen.getByTestId(`form-${ACK_SAM_DESK}`)).queryByRole('button', {
        name: 'Withdraw this form',
      }),
    ).toBeNull();
    const form = within(row).getByTestId(`form-withdraw-${ACK_SELF}`);
    expect(within(form).getByText(/It cannot be undone/)).toBeOnTheScreen();
    fireEvent.press(within(form).getByRole('button', { name: 'Withdraw form' }));
    expect(within(form).getByText(/Say why you are withdrawing it/)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    fireEvent.changeText(within(form).getByLabelText('Reason for withdrawing'), 'Signed in error');
    fireEvent.press(within(form).getByRole('button', { name: 'Withdraw form' }));
    expect(await screen.findByRole('header', { name: 'No forms signed' })).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.route).toBe('/acknowledgments/{id}/withdraw');
    expect(post?.params.id).toBe(ACK_SELF);
    expect(post?.body).toEqual({ reason: 'Signed in error', expectedRevision: 1 });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('stale version: STALE_REVISION on withdraw says it changed and Reload reads the list again', async () => {
    const app = formsApp(DEFAULT_LISTS, {
      'GET /me/permissions': MAY_WITHDRAW,
      'POST /acknowledgments/{id}/withdraw': () =>
        apiError(409, 'STALE_REVISION', { nextAction: 'reload_and_retry' }),
    });
    render(<FormsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`form-${ACK_SELF}`);
    fireEvent.press(await within(row).findByRole('button', { name: 'Withdraw this form' }));
    fireEvent.changeText(within(row).getByLabelText('Reason for withdrawing'), 'Mistake');
    fireEvent.press(within(row).getByRole('button', { name: 'Withdraw form' }));
    expect(await within(row).findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    expect(within(row).getByText(/This form changed since it was shown/)).toBeOnTheScreen();
    const before = app.fake.requests.filter((r) => r.route === '/acknowledgments').length;
    fireEvent.press(within(row).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/acknowledgments').length,
      ).toBeGreaterThan(before),
    );
    expect(screen.queryByTestId(`form-withdraw-${ACK_SELF}`)).toBeNull();
  });

  it('partial completion: one person’s list can fail with its code and "Try again" while the other shows', async () => {
    const app = formsApp({
      ...DEFAULT_LISTS,
      [CHILD]: () => apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
    });
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId(`form-${ACK_SELF}`)).toBeOnTheScreen();
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.10: a person whose forms the API does not show (NOT_FOUND) is "not available", with no hint of what exists', async () => {
    const app = formsApp({
      ...DEFAULT_LISTS,
      [CHILD]: () => apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId(`form-${ACK_SELF}`)).toBeOnTheScreen();
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(screen.queryByTestId(`form-${ACK_SAM}`)).toBeNull();
  });

  it('offline: keeps the cached forms with their age and withdrawing is disabled', async () => {
    const app = formsApp(DEFAULT_LISTS, { 'GET /me/permissions': MAY_WITHDRAW });
    render(<FormsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`form-${ACK_SELF}`);
    fireEvent.press(await within(row).findByRole('button', { name: 'Withdraw this form' }));
    act(() => app.sources.setReachable(false));
    expect(screen.getAllByLabelText('You are offline').length).toBeGreaterThan(0);
    expect(within(row).getByRole('button', { name: 'Withdraw form' })).toBeDisabled();
    expect(screen.getByTestId(`form-${ACK_SAM}`)).toBeOnTheScreen();
  });

  it('asks to finish setup when the account is not linked to a person, and reads no forms', async () => {
    const app = formsApp(DEFAULT_LISTS, { 'GET /me': ok(me({ person: null })) });
    render(<FormsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/acknowledgments')).toBe(false);
  });
});
