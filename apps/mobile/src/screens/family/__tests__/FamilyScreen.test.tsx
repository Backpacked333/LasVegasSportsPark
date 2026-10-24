/**
 * SCR-C-31 Family and permissions (SPK-IAM-001, SPK-IAM-003 "One permission must not silently
 * imply another", SPK-IAM-004, SPK-IAM-006, SPK-ENTRY-007, DEC-004, DEC-005, DEC-075, POL-023).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  CHILD_TWO,
  me,
  ok,
  peopleRoute,
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

const FAMILY = me({
  authorities: [
    { subjectPersonId: CHILD, permissions: ['view', 'register', 'collect'] },
    { subjectPersonId: CHILD_TWO, permissions: ['collect'] },
  ],
});

function familyApp(routes: Record<string, unknown> = {}, reachable = true) {
  return createTestApp({
    reachable,
    routes: {
      'GET /me': ok(FAMILY),
      'GET /people/{id}': peopleRoute([SAM]),
      ...(routes as Record<string, never>),
    },
  });
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

  it('never reads another household: only the people the API lists are looked up, and an unreadable one is not named', async () => {
    const app = familyApp();
    render(<FamilyScreen />, { wrapper: app.wrapper });
    const second = await screen.findByTestId('person-access-1');
    expect(
      await within(second).findByRole('header', { name: 'Name not available to you' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    const looked = new Set(
      app.fake.requests.filter((r) => r.route === '/people/{id}').map((r) => r.params.id),
    );
    expect(looked).toEqual(new Set([CHILD, CHILD_TWO]));
    expect(app.fake.requests.every((r) => r.route === '/me' || r.route === '/people/{id}')).toBe(
      true,
    );
  });

  it('empty: says that no family members are recorded yet', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({})) } });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No family members yet' })).toBeOnTheScreen();
  });

  it('asks to finish setup when the account is not linked to a participant record', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<FamilyScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
  });

  it('shows adding a child as pending DEC-004 and pickup as pending DEC-075 and DEC-005', async () => {
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
    expect(screen.getByLabelText('Not shown in the app yet')).toBeOnTheScreen();
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
    expect(within(form).getByText(/Choose at least one permission to pass on/)).toBeOnTheScreen();
    expect(within(form).getByLabelText('Their email address')).toHaveProp('value', 'jo-example');
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('SPK-IAM-004: invites a pickup delegate with only the chosen permission, shows the API expiry and shares the link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const app = familyApp({ 'POST /invitations': { status: 201, body: issued() } });
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

  it('stale version: STALE_REVISION on withdrawing shows the code and "Reload"', async () => {
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
    expect(screen.getByText('Reload')).toBeOnTheScreen();
    expect(within(result).getByLabelText('Reason for withdrawing')).toHaveProp('value', 'Mistake');
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
    expect(screen.getByText(/Error code: PARTICIPANT_AUTHORITY_REQUIRED/)).toBeOnTheScreen();
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
        'GET /people/{id}': peopleRoute([SAM]),
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
