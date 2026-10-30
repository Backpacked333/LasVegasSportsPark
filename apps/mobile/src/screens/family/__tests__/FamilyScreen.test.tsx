/**
 * SCR-C-31 Family and permissions (SPK-IAM-001 "household membership alone must not grant
 * authority", SPK-IAM-003 "One permission must not silently imply another", SPK-IAM-004,
 * SPK-IAM-005 "Under review", SPK-IAM-006, SPK-ENTRY-007, DEC-004, DEC-005, DEC-075, DEC-089,
 * POL-023).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import type { AppConfig } from '../../../config/app-config';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  CHILD_TWO,
  me,
  namesRoute,
  ok,
  OTHER_ADULT,
  page,
  person,
  SELF,
  TOKEN,
} from '../../account/__tests__/fixtures';
import { FamilyScreen } from '../FamilyScreen';
import { SHARE_MESSAGE } from '../InviteAdultForm';

const SAM = person(CHILD, 'Sam', 'Morgan', 'child');
const INVITATION = '0192f1a0-0000-7000-8000-00000000c001';

function issued(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION,
    invitedByPersonId: SELF,
    recipientPersonId: null,
    recipientContact: { kind: 'email', value: 'jo@example.test' },
    scope: { type: 'person', personId: CHILD },
    relationshipKind: 'delegate',
    requestedPermissions: ['collect'],
    grantedPermissions: [],
    status: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    revokedAt: null,
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
    token: TOKEN,
    ...overrides,
  };
}

const SINCE = '2026-09-01T10:00:00.000Z';

/** `GET /me/access-grants` item (GrantView). */
function grantView(permission: string, overrides: Record<string, unknown> = {}) {
  return {
    grantId: `grant-${permission}-${String(overrides.subjectPersonId ?? CHILD)}`,
    relationshipId: '0192f1a0-0000-7000-8000-00000000d100',
    relationshipKind: 'guardian',
    actorPersonId: SELF,
    actorDisplayName: 'Alex Morgan',
    subjectPersonId: CHILD,
    subjectDisplayName: 'Sam Morgan',
    permission,
    source: 'claim',
    effectiveFrom: SINCE,
    effectiveTo: null,
    revokedAt: null,
    status: 'effective',
    underReview: false,
    revision: 2,
    ...overrides,
  };
}

/** `GET /me/access-grants` answering `held` and `over_me` separately. */
function grantsRoute(held: unknown[], overMe: unknown[] = []) {
  return (request: { query: Record<string, string> }) =>
    fakeResponse(200, {
      items: request.query.direction === 'over_me' ? overMe : held,
      nextCursor: null,
    });
}

/** `GET /me/invitations?direction=sent` item (InvitationView). */
function sentView(overrides: Record<string, unknown> = {}) {
  const { token: _token, ...invitation } = issued();
  return {
    ...invitation,
    inviter: { personId: SELF, displayName: 'Alex Morgan' },
    subjects: [{ personId: CHILD, displayName: 'Sam Morgan' }],
    effectiveStatus: 'pending',
    declinedAt: null,
    ...overrides,
  };
}

const HELD = [grantView('view'), grantView('register'), grantView('collect')];

const FAMILY = me({
  authorities: [
    { subjectPersonId: CHILD, permissions: ['view', 'register', 'collect'] },
    { subjectPersonId: CHILD_TWO, permissions: ['collect'] },
  ],
});

function familyApp(
  routes: Record<string, unknown> = {},
  reachable = true,
  config: Partial<AppConfig> = {},
) {
  return createTestApp({
    reachable,
    config,
    routes: {
      'GET /me': ok(FAMILY),
      'GET /person-names': namesRoute([SAM]),
      'GET /me/access-grants': grantsRoute(HELD),
      'GET /me/households': ok({ items: [] }),
      'GET /me/invitations': page([]),
      ...(routes as Record<string, never>),
    },
  });
}

/** The family app with an empty family (no authorities, no grants). */
function emptyFamilyApp(routes: Record<string, unknown> = {}) {
  return familyApp({ 'GET /me': ok(me({})), 'GET /me/access-grants': grantsRoute([]), ...routes });
}

async function openInvite() {
  fireEvent.press(
    await screen.findByRole('button', { name: 'Invite another adult for Sam Morgan' }),
  );
  return screen.getByTestId('invite-form');
}

describe('SCR-C-31 FamilyScreen', () => {
  it('SPK-IAM-003: lists each permission separately as allowed or not, in words and glyphs', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByTestId('person-access-0');
    expect(await within(sam).findByRole('header', { name: 'Sam Morgan' })).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^View: allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^Register: allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^Pay: not allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^Receive messages: not allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^Complete forms: not allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^Collect: allowed\./)).toBeOnTheScreen();
    expect(within(sam).getByText('Pay: Not allowed')).toBeOnTheScreen();
  });

  it('§4.14: names come from GET /person-names only (no date of birth or contacts are read), and a person the API omits is not named', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const second = await screen.findByTestId('person-access-1');
    expect(
      await within(second).findByRole('header', { name: 'Name not available to you' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    const routes = new Set(app.fake.requests.map((r) => r.route));
    expect(routes.has('/people/{id}')).toBe(false);
    expect([...routes].every((r) => r !== null)).toBe(true);
    expect(routes).toEqual(
      new Set([
        '/me',
        '/person-names',
        '/me/access-grants',
        '/me/households',
        '/me/invitations',
        '/me/permissions',
      ]),
    );
  });

  it('empty: says that no family members are recorded yet', async () => {
    const app = emptyFamilyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No family members yet' })).toBeOnTheScreen();
  });

  it('asks to finish setup when the account is not linked to a participant record', async () => {
    const app = familyApp({ 'GET /me': ok(me({ person: null })) });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/me/access-grants')).toBe(false);
  });

  it("shows adding a child (DEC-004), pickup (DEC-075, DEC-005), other adults' permissions (DEC-004) and ending them (DEC-089) as pending", async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        /Adding a child from the app is not available yet: it depends on DEC-004/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Supervised pickup arrangements is not available yet: it depends on DEC-075, DEC-005/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Seeing the permissions other adults hold over the people you manage is not available yet: it depends on DEC-004/,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(/Ending another adult's permissions .* it depends on DEC-089, DEC-004/),
    ).toBeOnTheScreen();
  });

  it('permission restriction: a permission the parent does not hold cannot be passed on', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    expect(within(form).getByRole('checkbox', { name: 'Collect' })).not.toBeDisabled();
    expect(within(form).getByRole('checkbox', { name: 'Pay' })).toBeDisabled();
    expect(within(form).getByRole('checkbox', { name: 'Pay' })).toHaveProp(
      'accessibilityHint',
      'Pay for registrations and balances. You do not hold this, so you cannot pass it on.',
    );
  });

  it('validation failure: needs a valid contact and at least one permission before sending; input is kept', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo-example');
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));
    expect(within(form).getByText(/in the form name@example.com/)).toBeOnTheScreen();
    // SPK-UX-009: the refusal is announced, like a field error.
    expect(
      within(form).getByRole('alert', { name: /Choose at least one permission to pass on/ }),
    ).toBeOnTheScreen();
    expect(within(form).getByLabelText('Their email address')).toHaveProp('value', 'jo-example');
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('SPK-IAM-004: invites a pickup delegate with only the chosen permission, shows the API expiry and shares the link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const app = familyApp({ 'POST /invitations': { status: 201, body: issued() } }, true, {
      supervisedPickup: true,
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.press(within(form).getByRole('radio', { name: /^Pickup delegate/ }));
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo@example.test');
    fireEvent.press(within(form).getByRole('checkbox', { name: 'Collect' }));
    expect(within(form).getByRole('checkbox', { name: 'Collect' })).toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'View' })).not.toBeChecked();
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));

    const result = await screen.findByTestId('invitation-issued');
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({
      scope: { type: 'person', personId: CHILD },
      relationshipKind: 'delegate',
      requestedPermissions: ['collect'],
      recipientContact: { kind: 'email', value: 'jo@example.test' },
    });
    // The expiry is POL-044 (pending): never sent, shown as the API states it.
    expect(post?.body).not.toHaveProperty('expiresInHours');
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
    expect(within(result).getByLabelText(/^Open until /)).toBeOnTheScreen();

    fireEvent.press(within(result).getByRole('button', { name: 'Share invitation link' }));
    expect(share).toHaveBeenCalledTimes(1);
    const message = share.mock.calls[0]?.[0] as { message: string };
    expect(message.message).toBe(
      `${SHARE_MESSAGE} sportspark://link?to=invitation&id=${INVITATION}&token=${TOKEN}`,
    );
    expect(message.message).not.toContain('Sam'); // no names leave the app in the link (§4.14)
    share.mockRestore();
  });

  it('pending DEC-075 and POL-044: pickup and the invitation expiry are shown as waiting on a decision, not as decided', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    expect(within(form).queryByRole('radio', { name: /^Pickup delegate/ })).toBeNull();
    expect(within(form).getByRole('radio', { name: /^Delegate/ })).toBeOnTheScreen();
    expect(within(form).queryByText(/supervised sessions \(pickup\)/)).toBeNull();
    expect(
      within(form).getByText(
        /Supervised pickup is not available yet: it depends on DEC-075, DEC-005/,
      ),
    ).toBeOnTheScreen();
    expect(
      within(form).getByText(
        /Choosing how long an invitation stays open is not available yet: it depends on POL-044/,
      ),
    ).toBeOnTheScreen();
    expect(within(form).queryByText(/invitation policy sets how long/)).toBeNull();
  });

  it('pickup decided as not used (DEC-075): neither a pickup delegate nor Collect is offered', async () => {
    const app = familyApp({}, true, { supervisedPickup: false });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    expect(within(form).queryByRole('radio', { name: /Delegate/ })).toBeNull();
    expect(within(form).queryByRole('checkbox', { name: 'Collect' })).toBeNull();
  });

  it('withdraws an issued invitation with a reason and the expected revision', async () => {
    const app = familyApp({
      'POST /invitations': { status: 201, body: issued() },
      'POST /invitations/{id}/revoke': ok({ ...issued({ status: 'revoked', revision: 2 }) }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo@example.test');
    fireEvent.press(within(form).getByRole('checkbox', { name: 'View' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));
    const result = await screen.findByTestId('invitation-issued');

    fireEvent.press(within(result).getByRole('button', { name: 'Withdraw invitation' }));
    expect(within(result).getByText(/Say why you are withdrawing it/)).toBeOnTheScreen();
    fireEvent.changeText(
      within(result).getByLabelText('Reason for withdrawing'),
      'Sent to the wrong address',
    );
    fireEvent.press(within(result).getByRole('button', { name: 'Withdraw invitation' }));
    expect(await screen.findByLabelText('Revoked')).toBeOnTheScreen();
    const revoke = app.fake.requests.find((r) => r.route === '/invitations/{id}/revoke');
    expect(revoke?.body).toEqual({ reason: 'Sent to the wrong address', expectedRevision: 1 });
    expect(revoke?.headers['idempotency-key']).toBe('key-00000002');
  });

  it('stale version: STALE_REVISION on withdrawing says the invitation is no longer open and offers no Withdraw', async () => {
    const app = familyApp({
      'POST /invitations': { status: 201, body: issued() },
      'POST /invitations/{id}/revoke': () =>
        apiError(409, 'STALE_REVISION', { nextAction: 'reload_and_retry' }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo@example.test');
    fireEvent.press(within(form).getByRole('checkbox', { name: 'View' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));
    const result = await screen.findByTestId('invitation-issued');
    fireEvent.changeText(within(result).getByLabelText('Reason for withdrawing'), 'Mistake');
    fireEvent.press(within(result).getByRole('button', { name: 'Withdraw invitation' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    expect(within(result).getByLabelText('No longer open')).toBeOnTheScreen();
    expect(within(result).queryByText(/Open until/)).toBeNull();
    expect(within(result).getByText(/it may have been accepted/)).toBeOnTheScreen();
    expect(within(result).queryByRole('button', { name: 'Withdraw invitation' })).toBeNull();
  });

  it('INVALID_TRANSITION on withdrawing names the state the invitation is in', async () => {
    const app = familyApp({
      'POST /invitations': { status: 201, body: issued() },
      'POST /invitations/{id}/revoke': () =>
        apiError(409, 'INVALID_TRANSITION', {
          nextAction: 'reload_current_state',
          details: { machine: 'invitation', from: 'accepted', event: 'revoke' },
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo@example.test');
    fireEvent.press(within(form).getByRole('checkbox', { name: 'View' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));
    const result = await screen.findByTestId('invitation-issued');
    fireEvent.changeText(within(result).getByLabelText('Reason for withdrawing'), 'Mistake');
    fireEvent.press(within(result).getByRole('button', { name: 'Withdraw invitation' }));
    expect(await within(result).findByLabelText('Accepted')).toBeOnTheScreen();
    expect(within(result).queryByRole('button', { name: 'Withdraw invitation' })).toBeNull();
  });

  it('shows PARTICIPANT_AUTHORITY_REQUIRED with the API reason and keeps every choice', async () => {
    const app = familyApp({
      'POST /invitations': () =>
        apiError(403, 'PARTICIPANT_AUTHORITY_REQUIRED', {
          message: "You do not hold 'view' over this person and cannot delegate it.",
          nextAction: 'request_participant_authority',
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    fireEvent.changeText(within(form).getByLabelText('Their email address'), 'jo@example.test');
    fireEvent.press(within(form).getByRole('checkbox', { name: 'View' }));
    fireEvent.press(within(form).getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/cannot delegate it/)).toBeOnTheScreen();
    // SPK-UX-008: a permission restriction is shown as not available, never as a failure.
    expect(screen.getByLabelText('Not available to you')).toBeOnTheScreen();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(within(form).getByRole('checkbox', { name: 'View' })).toBeChecked();
  });

  it('offline: changes are disabled and cached family data stays with its age', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const form = await openInvite();
    act(() => app.sources.setReachable(false));
    expect(within(form).getByRole('button', { name: 'Create invitation' })).toBeDisabled();
    expect(
      screen.getByText('Inviting needs a connection. Your choices are kept.'),
    ).toBeOnTheScreen();
    expect(screen.getAllByLabelText('You are offline').length).toBeGreaterThan(0);
    expect(screen.getByTestId('person-access-0')).toBeOnTheScreen();
  });

  it('claims a child record entered at the desk (SPK-IAM-002) and lists the granted permissions', async () => {
    let claimed = false;
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          fakeResponse(
            200,
            me({
              authorities: claimed
                ? [{ subjectPersonId: CHILD, permissions: ['view', 'pay'] }]
                : [],
            }),
          ),
        'GET /person-names': namesRoute([SAM]),
        'GET /me/access-grants': grantsRoute([]),
        'GET /me/households': ok({ items: [] }),
        'GET /me/invitations': page([]),
        'POST /claims/{token}/accept': () => {
          claimed = true;
          return fakeResponse(200, {
            claim: {
              id: '0192f1a0-0000-7000-8000-00000000e001',
              subjectPersonId: CHILD,
              kind: 'guardian',
              requestedPermissions: ['view', 'pay'],
              status: 'accepted',
              expiresAt: '2026-10-30T10:00:00.000Z',
              acceptedAt: '2026-10-24T12:00:00.000Z',
              acceptedByPersonId: SELF,
              revokedAt: null,
              revision: 2,
              createdAt: '2026-10-20T10:00:00.000Z',
            },
            accountId: '0192f1a0-0000-7000-8000-0000000000aa',
            personId: SELF,
            relationship: null,
            grants: [
              { permission: 'view', effective: true },
              { permission: 'pay', effective: true },
            ],
          });
        },
      },
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.changeText(await screen.findByLabelText('Claim code'), TOKEN);
    fireEvent.press(screen.getByRole('button', { name: 'Claim record' }));
    expect(await screen.findByLabelText('Claimed')).toBeOnTheScreen();
    expect(
      await screen.findByText(/guardian of Sam Morgan with these permissions: View and Pay/),
    ).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByTestId('person-access-0')).toBeOnTheScreen());
  });
});

describe('SCR-C-31 permissions as the grants state them (GET /me/access-grants)', () => {
  it('SPK-IAM-003: an allowed permission names its start date and where it came from', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByTestId('person-access-0');
    expect(
      await within(sam).findByLabelText(/^View: allowed\. .*Since .*, from a claim code$/),
    ).toBeOnTheScreen();
    const read = app.fake.requests.find(
      (r) => r.route === '/me/access-grants' && r.query.direction === 'held',
    );
    expect(read?.query.limit).toBe('100');
  });

  it('SPK-IAM-005: a permission paused by a disputed-access review reads "Under review", never "Allowed"', async () => {
    const app = familyApp({
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
      'GET /me/access-grants': grantsRoute([
        grantView('view'),
        grantView('pay', { status: 'suspended', underReview: true }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByTestId('person-access-0');
    expect(await within(sam).findByLabelText(/^Pay: under review\./)).toBeOnTheScreen();
    expect(within(sam).getByText('Pay: Under review')).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^View: allowed\./)).toBeOnTheScreen();
  });

  it('SPK-IAM-005: a person over whom every grant is paused is still listed, as under review', async () => {
    const app = familyApp({
      'GET /me': ok(me({ authorities: [] })),
      'GET /me/access-grants': grantsRoute([
        grantView('view', { status: 'suspended', underReview: true }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByTestId('person-access-0');
    expect(await within(sam).findByRole('header', { name: 'Sam Morgan' })).toBeOnTheScreen();
    expect(within(sam).getByLabelText(/^View: under review\./)).toBeOnTheScreen();
    // Nothing can be passed on from a paused permission.
    expect(screen.queryByRole('button', { name: /^Invite another adult/ })).toBeNull();
  });

  it('a permission that starts later says when', async () => {
    const app = familyApp({
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
      'GET /me/access-grants': grantsRoute([
        grantView('view'),
        grantView('pay', { status: 'scheduled', effectiveFrom: '2026-11-01T10:00:00.000Z' }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const sam = await screen.findByTestId('person-access-0');
    expect(await within(sam).findByLabelText(/^Pay: starts .*2026/)).toBeOnTheScreen();
  });

  it('partial completion: a failed grants read shows its code and Try again; what the API says is allowed stays', async () => {
    const app = familyApp({
      'GET /me/access-grants': () =>
        apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const failure = await screen.findByTestId('grants-error');
    expect(within(failure).getByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(failure).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('person-access-0')).getByLabelText(/^View: allowed\./),
    ).toBeOnTheScreen();
  });
});

describe('SCR-C-31 giving up a permission (SPK-IAM-006)', () => {
  const MAY_REVOKE = mePermissions({
    conditionalActions: [{ id: 'identity.revoke_access', self: true }],
  });

  it('is not offered when GET /me/permissions does not list identity.revoke_access', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', { name: 'Invite another adult for Sam Morgan' }),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: /^Give up a permission/ })).toBeNull();
  });

  it('gives up one chosen permission with a reason and the grant revision', async () => {
    const app = familyApp({
      'GET /me/permissions': MAY_REVOKE,
      'POST /access-grants/{id}/revoke': ok({
        id: 'grant-register-' + CHILD,
        relationshipId: '0192f1a0-0000-7000-8000-00000000d100',
        actorPersonId: SELF,
        subjectPersonId: CHILD,
        permission: 'register',
        source: 'claim',
        effectiveFrom: SINCE,
        effectiveTo: null,
        revokedAt: '2026-10-24T12:00:00.000Z',
        revocationReason: 'No longer needed',
        suspendedAt: null,
        suspendedByReviewId: null,
        effective: false,
        revision: 3,
        createdAt: SINCE,
      }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Give up a permission for Sam Morgan' }),
    );
    const form = screen.getByTestId('give-up-form');
    fireEvent.press(within(form).getByRole('radio', { name: 'Register' }));
    expect(within(form).getByRole('radio', { name: 'Register' })).toBeChecked();
    fireEvent.press(within(form).getByRole('button', { name: 'Give up permission' }));
    expect(within(form).getByText(/Say why you are giving it up/)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    fireEvent.changeText(within(form).getByLabelText('Reason'), 'No longer needed');
    fireEvent.press(within(form).getByRole('button', { name: 'Give up permission' }));

    expect(await screen.findByLabelText('Permission given up')).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.route).toBe('/access-grants/{id}/revoke');
    expect(post?.params.id).toBe(`grant-register-${CHILD}`);
    expect(post?.body).toEqual({ reason: 'No longer needed', expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('SPK-IAM-005, SPK-IAM-006: a grant starting later or paused by a review can be given up too, labelled with its state', async () => {
    const app = familyApp({
      'GET /me/permissions': MAY_REVOKE,
      'GET /me/access-grants': grantsRoute([
        grantView('view'),
        grantView('pay', { status: 'scheduled', effectiveFrom: '2026-11-15T10:00:00.000Z' }),
        grantView('complete_forms', { status: 'suspended', underReview: true }),
        grantView('collect', { status: 'revoked', revokedAt: SINCE }),
      ]),
      'POST /access-grants/{id}/revoke': () =>
        apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Give up a permission for Sam Morgan' }),
    );
    const form = screen.getByTestId('give-up-form');
    expect(within(form).getByRole('radio', { name: 'View' })).toBeOnTheScreen();
    expect(within(form).getByRole('radio', { name: /^Pay, Starts / })).toBeOnTheScreen();
    expect(
      within(form).getByRole('radio', { name: 'Complete forms, Under review' }),
    ).toBeOnTheScreen();
    // A withdrawn grant is not offered: there is nothing left to give up.
    expect(within(form).queryByRole('radio', { name: /^Collect/ })).toBeNull();
    fireEvent.press(within(form).getByRole('radio', { name: /^Pay, Starts / }));
    fireEvent.changeText(within(form).getByLabelText('Reason'), 'Not needed');
    fireEvent.press(within(form).getByRole('button', { name: 'Give up permission' }));
    expect(await within(form).findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params.id).toBe(`grant-pay-${CHILD}`);
    expect(post?.body).toEqual({ reason: 'Not needed', expectedRevision: 2 });
  });

  it('processing: the form cannot be cancelled while giving up is in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const app = familyApp({
      'GET /me/permissions': MAY_REVOKE,
      'POST /access-grants/{id}/revoke': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Give up a permission for Sam Morgan' }),
    );
    const form = screen.getByTestId('give-up-form');
    fireEvent.changeText(within(form).getByLabelText('Reason'), 'Mistake');
    expect(within(form).getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    fireEvent.press(within(form).getByRole('button', { name: 'Give up permission' }));
    await waitFor(() =>
      expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled(),
    );
    await act(async () => {
      answer(apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }));
    });
    await waitFor(() =>
      expect(within(form).getByRole('button', { name: 'Cancel' })).not.toBeDisabled(),
    );
  });

  it('stale version: STALE_REVISION reloads the permissions as they are now', async () => {
    const app = familyApp({
      'GET /me/permissions': MAY_REVOKE,
      'POST /access-grants/{id}/revoke': () =>
        apiError(409, 'STALE_REVISION', { nextAction: 'reload_and_retry' }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Give up a permission for Sam Morgan' }),
    );
    const form = screen.getByTestId('give-up-form');
    fireEvent.changeText(within(form).getByLabelText('Reason'), 'Mistake');
    fireEvent.press(within(form).getByRole('button', { name: 'Give up permission' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    const heldReads = () =>
      app.fake.requests.filter(
        (r) => r.route === '/me/access-grants' && r.query.direction === 'held',
      ).length;
    const before = heldReads();
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(heldReads()).toBe(before + 1));
    expect(screen.queryByTestId('give-up-form')).toBeNull();
  });
});

describe('SCR-C-31 households (SPK-IAM-001)', () => {
  it('names the members the API shows, counts the others, and says membership grants nothing', async () => {
    const app = familyApp({
      'GET /me/households': ok({
        items: [
          {
            id: '0192f1a0-0000-7000-8000-00000000f201',
            name: 'Morgan household',
            members: [
              {
                personId: SELF,
                displayName: 'Alex Morgan',
                kind: 'adult',
                label: null,
                isSelf: true,
              },
              {
                personId: CHILD,
                displayName: 'Sam Morgan',
                kind: 'child',
                label: 'Son',
                isSelf: false,
              },
            ],
            otherMemberCount: 1,
            revision: 1,
            createdAt: SINCE,
          },
        ],
      }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const household = await screen.findByTestId('household-0192f1a0-0000-7000-8000-00000000f201');
    expect(within(household).getByRole('header', { name: 'Morgan household' })).toBeOnTheScreen();
    expect(within(household).getByLabelText('Alex Morgan, You')).toBeOnTheScreen();
    expect(within(household).getByLabelText('Sam Morgan, Child, Son')).toBeOnTheScreen();
    expect(
      within(household).getByText(
        '1 other member is not shown, because you do not have permission to view them.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Being in a household gives nobody any permission/)).toBeOnTheScreen();
  });

  it('empty: no household yet; without the create action, only the front desk can make one', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No household yet' })).toBeOnTheScreen();
    expect(
      await screen.findByText('The front desk can group your family into a household.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Create a household' })).toBeNull();
  });

  const MAY_GROUP = mePermissions({
    conditionalActions: [
      { id: 'identity.create_household', self: true },
      { id: 'identity.add_household_member', self: true, subjectPermission: 'view' },
    ],
  });

  function household(members: { personId: string; displayName: string; isSelf: boolean }[]) {
    return {
      id: '0192f1a0-0000-7000-8000-00000000f201',
      name: 'Morgan household',
      members: members.map((m) => ({
        ...m,
        kind: m.isSelf ? 'adult' : 'child',
        label: null,
      })),
      otherMemberCount: 0,
      revision: 1,
      createdAt: SINCE,
    };
  }

  it('SPK-IAM-001: creates a household when the API lists identity.create_household; the list is read again', async () => {
    let created = false;
    const app = familyApp({
      'GET /me/permissions': MAY_GROUP,
      'GET /me/households': () =>
        fakeResponse(200, {
          items: created
            ? [household([{ personId: SELF, displayName: 'Alex Morgan', isSelf: true }])]
            : [],
        }),
      'POST /households': () => {
        created = true;
        return fakeResponse(201, {
          id: '0192f1a0-0000-7000-8000-00000000f201',
          name: 'Morgan household',
          members: [{ personId: SELF, label: null }],
          revision: 1,
          createdAt: SINCE,
        });
      },
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('You can create one below.')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Create a household' }));
    const form = screen.getByTestId('household-create');
    expect(
      within(form).getByText(/Being in a household gives nobody any permission/),
    ).toBeOnTheScreen();
    fireEvent.press(within(form).getByRole('button', { name: 'Create household' }));
    expect(within(form).getByText(/Give the household a name/)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
    fireEvent.changeText(within(form).getByLabelText('Household name'), ' Morgan household ');
    fireEvent.press(within(form).getByRole('button', { name: 'Create household' }));
    expect(
      await screen.findByTestId('household-0192f1a0-0000-7000-8000-00000000f201'),
    ).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.route === '/households');
    expect(post?.body).toEqual({ name: 'Morgan household' });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('SPK-IAM-001: adds a person held with view to a household, and only such a person', async () => {
    let added = false;
    const app = familyApp({
      'GET /me/permissions': MAY_GROUP,
      'GET /person-names': namesRoute([SAM, person(CHILD_TWO, 'Rio', 'Morgan', 'child')]),
      'GET /me/households': () =>
        fakeResponse(200, {
          items: [
            household([
              { personId: SELF, displayName: 'Alex Morgan', isSelf: true },
              ...(added ? [{ personId: CHILD, displayName: 'Sam Morgan', isSelf: false }] : []),
            ]),
          ],
        }),
      'POST /households/{id}/members': () => {
        added = true;
        return fakeResponse(200, {
          id: '0192f1a0-0000-7000-8000-00000000f201',
          name: 'Morgan household',
          members: [
            { personId: SELF, label: null },
            { personId: CHILD, label: 'Son' },
          ],
          revision: 1,
          createdAt: SINCE,
        });
      },
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('household-0192f1a0-0000-7000-8000-00000000f201');
    fireEvent.press(
      await within(card).findByRole('button', { name: 'Add someone to Morgan household' }),
    );
    const form = within(card).getByTestId('household-add-0192f1a0-0000-7000-8000-00000000f201');
    expect(within(form).getByText(/does not change anyone's permissions/)).toBeOnTheScreen();
    // Sam is held with view; Rio only with collect (FAMILY), so Rio is not offered.
    expect(within(form).getByRole('radio', { name: 'Sam Morgan' })).toBeChecked();
    expect(within(form).queryByRole('radio', { name: 'Rio Morgan' })).toBeNull();
    fireEvent.changeText(within(form).getByLabelText('How they are related (optional)'), 'Son');
    fireEvent.press(within(form).getByRole('button', { name: 'Add Sam Morgan' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('household-0192f1a0-0000-7000-8000-00000000f201')).getByLabelText(
          'Sam Morgan, Child',
        ),
      ).toBeOnTheScreen(),
    );
    const post = app.fake.requests.find((r) => r.route === '/households/{id}/members');
    expect(post?.params.id).toBe('0192f1a0-0000-7000-8000-00000000f201');
    expect(post?.body).toEqual({ personId: CHILD, label: 'Son' });
    // Once everyone held with view is a member, there is nobody left to add.
    expect(screen.queryByRole('button', { name: 'Add someone to Morgan household' })).toBeNull();
  });

  it('a refused add (ACCESS_DENIED) is shown as not available with the API reason', async () => {
    const app = familyApp({
      'GET /me/permissions': MAY_GROUP,
      'GET /me/households': ok({
        items: [household([{ personId: SELF, displayName: 'Alex Morgan', isSelf: true }])],
      }),
      'POST /households/{id}/members': () =>
        apiError(403, 'ACCESS_DENIED', {
          message: 'You do not hold view permission over this person.',
          nextAction: 'contact_support_or_request_access',
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Add someone to Morgan household' }));
    fireEvent.press(screen.getByRole('button', { name: 'Add Sam Morgan' }));
    expect(await screen.findByLabelText('You cannot add this person')).toBeOnTheScreen();
    expect(screen.getByText('You do not hold view permission over this person.')).toBeOnTheScreen();
  });
});

describe('SCR-C-31 invitations sent (SPK-IAM-004)', () => {
  it('lists sent invitations with their state; only an open one can be withdrawn', async () => {
    const accepted = '0192f1a0-0000-7000-8000-00000000c009';
    const app = familyApp({
      'GET /me/invitations': page([
        sentView(),
        sentView({ id: accepted, status: 'accepted', effectiveStatus: 'accepted' }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const open = await screen.findByTestId(`sent-invitation-${INVITATION}`);
    expect(
      within(open).getByLabelText(
        /^Delegate for Sam Morgan, To jo@example.test\. Requested: Collect, Open until /,
      ),
    ).toBeOnTheScreen();
    expect(
      within(open).getByRole('button', { name: 'Withdraw invitation for Sam Morgan' }),
    ).toBeOnTheScreen();
    const done = screen.getByTestId(`sent-invitation-${accepted}`);
    expect(within(done).getByLabelText('Accepted')).toBeOnTheScreen();
    expect(within(done).queryByRole('button', { name: /^Withdraw/ })).toBeNull();
    const read = app.fake.requests.find((r) => r.route === '/me/invitations');
    expect(read?.query.direction).toBe('sent');
  });

  it('SPK-IAM-004: an accepted invitation shows what was granted and names what was requested but not granted', async () => {
    const accepted = '0192f1a0-0000-7000-8000-00000000c009';
    const app = familyApp({
      'GET /me/invitations': page([
        sentView({
          id: accepted,
          status: 'accepted',
          effectiveStatus: 'accepted',
          requestedPermissions: ['view', 'pay', 'collect'],
          grantedPermissions: ['view', 'collect'],
        }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`sent-invitation-${accepted}`);
    expect(
      within(row).getByLabelText(
        'Delegate for Sam Morgan, To jo@example.test. Granted: View and Collect. Not granted, because you no longer held them: Pay, Accepted',
      ),
    ).toBeOnTheScreen();
  });

  it('processing: "Keep it open" cannot be pressed while a withdrawal is in flight', async () => {
    let answer: (response: Response) => void = () => undefined;
    const app = familyApp({
      'GET /me/invitations': page([sentView()]),
      'POST /invitations/{id}/revoke': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`sent-invitation-${INVITATION}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Withdraw invitation for Sam Morgan' }),
    );
    fireEvent.changeText(within(row).getByLabelText('Reason for withdrawing'), 'Wrong address');
    fireEvent.press(within(row).getByRole('button', { name: 'Withdraw invitation' }));
    await waitFor(() =>
      expect(within(row).getByRole('button', { name: 'Keep it open' })).toBeDisabled(),
    );
    await act(async () => {
      answer(fakeResponse(200, { ...issued({ status: 'revoked', revision: 2 }) }));
    });
    await waitFor(() =>
      expect(within(row).queryByRole('button', { name: 'Keep it open' })).toBeNull(),
    );
  });

  it('withdraws an open invitation with a reason and its revision; the list then shows it revoked', async () => {
    let revoked = false;
    const app = familyApp({
      'GET /me/invitations': () =>
        fakeResponse(200, {
          items: [
            revoked
              ? sentView({ status: 'revoked', effectiveStatus: 'revoked', revision: 2 })
              : sentView(),
          ],
          nextCursor: null,
        }),
      'POST /invitations/{id}/revoke': () => {
        revoked = true;
        return fakeResponse(200, { ...issued({ status: 'revoked', revision: 2 }) });
      },
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`sent-invitation-${INVITATION}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Withdraw invitation for Sam Morgan' }),
    );
    fireEvent.press(within(row).getByRole('button', { name: 'Withdraw invitation' }));
    expect(within(row).getByText(/Say why you are withdrawing it/)).toBeOnTheScreen();
    fireEvent.changeText(within(row).getByLabelText('Reason for withdrawing'), 'Wrong address');
    fireEvent.press(within(row).getByRole('button', { name: 'Withdraw invitation' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`sent-invitation-${INVITATION}`)).getByLabelText('Revoked'),
      ).toBeOnTheScreen(),
    );
    const revoke = app.fake.requests.find((r) => r.route === '/invitations/{id}/revoke');
    expect(revoke?.body).toEqual({ reason: 'Wrong address', expectedRevision: 1 });
    expect(revoke?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('stale version: a withdraw refused with INVALID_TRANSITION says it changed and reloads the list', async () => {
    const app = familyApp({
      'GET /me/invitations': page([sentView()]),
      'POST /invitations/{id}/revoke': () =>
        apiError(409, 'INVALID_TRANSITION', {
          nextAction: 'reload_current_state',
          details: { machine: 'Invitation', from: 'accepted', event: 'revoke' },
        }),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`sent-invitation-${INVITATION}`);
    fireEvent.press(
      within(row).getByRole('button', { name: 'Withdraw invitation for Sam Morgan' }),
    );
    fireEvent.changeText(within(row).getByLabelText('Reason for withdrawing'), 'Mistake');
    fireEvent.press(within(row).getByRole('button', { name: 'Withdraw invitation' }));
    expect(
      await within(row).findByText(/This invitation changed since it was shown/),
    ).toBeOnTheScreen();
    const before = app.fake.requests.filter((r) => r.route === '/me/invitations').length;
    fireEvent.press(within(row).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/invitations').length).toBe(
        before + 1,
      ),
    );
  });
});

describe('SCR-C-31 who can act for you (GET /me/access-grants?direction=over_me)', () => {
  it('lists each permission another adult holds over this person with its state; ending it is pending DEC-089', async () => {
    const app = familyApp({
      'GET /me/access-grants': grantsRoute(HELD, [
        grantView('view', {
          grantId: 'over-view',
          actorPersonId: OTHER_ADULT,
          actorDisplayName: 'Jordan Lee',
          subjectPersonId: SELF,
          subjectDisplayName: 'Alex Morgan',
          relationshipKind: 'caregiver',
          source: 'invitation',
        }),
        grantView('pay', {
          grantId: 'over-pay',
          actorPersonId: OTHER_ADULT,
          actorDisplayName: 'Jordan Lee',
          subjectPersonId: SELF,
          status: 'suspended',
          underReview: true,
        }),
        grantView('collect', {
          grantId: 'over-collect',
          actorPersonId: OTHER_ADULT,
          actorDisplayName: 'Jordan Lee',
          subjectPersonId: SELF,
          status: 'revoked',
        }),
      ]),
    });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const list = await screen.findByLabelText('What Jordan Lee may do for you');
    expect(
      within(list).getByLabelText(/^View, Since .*, from an invitation, Allowed$/),
    ).toBeOnTheScreen();
    expect(within(list).getByLabelText(/^Pay, .*, Under review$/)).toBeOnTheScreen();
    // A withdrawn grant is history, not current access.
    expect(within(list).queryByLabelText(/^Collect,/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Jordan Lee/ })).toBeNull();
  });

  it('empty: nobody else holds permissions over this person', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'Nobody else holds permissions over you' }),
    ).toBeOnTheScreen();
  });
});
