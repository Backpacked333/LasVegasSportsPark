/**
 * SCR-C-17 Invitation acceptance (SPK-IAM-004 "Accepting an invitation grants only the
 * authorized scope", SPK-IAM-003, SPK-CAP-001, POL-044).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { clearLinkSecrets, holdLinkSecret, readLinkSecret } from '../../../links/link-secrets';
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
import { InvitationScreen, invitationStateLabel } from '../InvitationScreen';

const INVITATION = '0192f1a0-0000-7000-8000-00000000c001';
const AT = '2026-10-24T12:00:00.000Z';
const SAM = person(CHILD, 'Sam', 'Morgan', 'child');
const RIO = person(CHILD_TWO, 'Rio', 'Morgan', 'child');

function grant(permission: string, subjectPersonId = CHILD) {
  return {
    id: `grant-${permission}-${subjectPersonId}`,
    relationshipId: '0192f1a0-0000-7000-8000-00000000d100',
    actorPersonId: SELF,
    subjectPersonId,
    permission,
    source: 'invitation',
    effectiveFrom: AT,
    effectiveTo: null,
    revokedAt: null,
    revocationReason: null,
    suspendedAt: null,
    suspendedByReviewId: null,
    effective: true,
    revision: 1,
    createdAt: AT,
  };
}

function familyAccepted() {
  return {
    invitation: {
      id: INVITATION,
      invitedByPersonId: '0192f1a0-0000-7000-8000-00000000a002',
      recipientPersonId: null,
      recipientContact: { kind: 'email', value: 'alex@example.test' },
      scope: { type: 'person', personId: CHILD },
      relationshipKind: 'guardian',
      requestedPermissions: ['view', 'pay', 'collect'],
      grantedPermissions: ['view', 'collect'],
      status: 'accepted',
      expiresAt: '2026-10-27T12:00:00.000Z',
      acceptedAt: AT,
      acceptedByPersonId: SELF,
      revokedAt: null,
      revision: 2,
      createdAt: '2026-10-24T10:00:00.000Z',
    },
    relationships: [],
    grants: [grant('view'), grant('collect')],
    droppedPermissions: ['pay'],
  };
}

function teamAccepted(personId = SELF, displayName = 'Alex Morgan') {
  return {
    invitation: {
      id: INVITATION,
      teamEntryId: '0192f1a0-0000-7000-8000-00000000e100',
      invitedByPersonId: '0192f1a0-0000-7000-8000-00000000a002',
      recipientPersonId: personId,
      recipientContact: null,
      message: null,
      status: 'accepted',
      expiresAt: '2026-10-27T12:00:00.000Z',
      acceptedAt: AT,
      acceptedByPersonId: personId,
      revokedAt: null,
      rosterMembershipId: '0192f1a0-0000-7000-8000-00000000e200',
      revision: 2,
      createdAt: '2026-10-24T10:00:00.000Z',
    },
    membership: {
      id: '0192f1a0-0000-7000-8000-00000000e200',
      teamEntryId: '0192f1a0-0000-7000-8000-00000000e100',
      personId,
      displayName,
      personKind: personId === SELF ? 'adult' : 'child',
      status: 'active',
      source: 'invitation',
      jerseyNumber: null,
      effectiveFrom: AT,
      effectiveTo: null,
      removedAt: null,
      removalReason: null,
      statusBeforeRemoval: null,
      eligibility: { status: 'eligible', reasons: [] },
    },
  };
}

afterEach(clearLinkSecrets);

describe('SCR-C-17 InvitationScreen (family access)', () => {
  it('empty: without the link it shows that there is no invitation to show', async () => {
    const app = createTestApp();
    render(<InvitationScreen invitationId={INVITATION} type="family" token={null} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('header', { name: 'No invitation to show' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('SPK-IAM-004: accepting lists exactly what was granted, what was left out, and nothing else', async () => {
    holdLinkSecret('invitation', TOKEN, INVITATION);
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': ok(familyAccepted()),
        'GET /people/{id}': peopleRoute([SAM]),
        'GET /me': ok(me({})),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Details shown after you accept')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByLabelText('Accepted')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'Sam Morgan: View and Collect. Not granted for Sam Morgan, because the sender no longer holds them: Pay',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('Nothing else was granted.')).toBeOnTheScreen();

    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.params.id).toBe(INVITATION);
    expect(post?.body).toEqual({ token: TOKEN });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
    expect(readLinkSecret('invitation', INVITATION)).toBeNull(); // a used token is not kept
  });

  it('SPK-IAM-004: a household invitation says, per child, what was left out (only one child lost a permission)', async () => {
    holdLinkSecret('invitation', TOKEN, INVITATION);
    const household = familyAccepted();
    household.invitation.scope = {
      type: 'household',
      householdId: '0192f1a0-0000-7000-8000-00000000f001',
    } as never;
    household.invitation.requestedPermissions = ['view', 'pay'];
    household.grants = [grant('view', CHILD), grant('pay', CHILD), grant('view', CHILD_TWO)];
    household.droppedPermissions = ['pay'];
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': ok(household),
        'GET /people/{id}': peopleRoute([SAM, RIO]),
        'GET /me': ok(me({})),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByLabelText('Sam Morgan: View and Pay')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'Rio Morgan: View. Not granted for Rio Morgan, because the sender no longer holds them: Pay',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/^Not granted, because/)).toBeNull();
  });

  it('permission restriction: an invitation addressed to someone else (NOT_FOUND) is "not available", with no hint it exists', async () => {
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': () =>
          apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByLabelText('Invitation not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('stale version: an expired invitation shows "Expired" (INVALID_TRANSITION)', async () => {
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': () =>
          apiError(409, 'INVALID_TRANSITION', {
            nextAction: 'reload_current_state',
            details: { machine: 'Invitation', from: 'expired', event: 'accept' },
          }),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByLabelText('Expired')).toBeOnTheScreen();
    expect(screen.getByText(/no longer open, so it cannot be accepted/)).toBeOnTheScreen();
  });

  it('uses the journeys.md labels for every closed state', () => {
    expect(invitationStateLabel('accepted')).toBe('Accepted');
    expect(invitationStateLabel('declined')).toBe('Declined');
    expect(invitationStateLabel('expired')).toBe('Expired');
    expect(invitationStateLabel('revoked')).toBe('Revoked');
    expect(invitationStateLabel(undefined)).toBe('No longer open');
  });

  it('shows the API reason when the account may not accept yet (ACCESS_DENIED: contact not verified)', async () => {
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': () =>
          apiError(403, 'ACCESS_DENIED', {
            message: 'This invitation was sent to a contact point your account has not verified.',
            nextAction: 'contact_support_or_request_access',
          }),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByLabelText('You cannot accept this invitation yet')).toBeOnTheScreen();
    expect(screen.getByText(/has not verified/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Go to account setup' })).toBeOnTheScreen();
  });

  it('§4.9: a failed accept is retried under the same idempotency key', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        'POST /invitations/{id}/accept': () => {
          calls += 1;
          return calls === 1
            ? apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })
            : fakeResponse(200, familyAccepted());
        },
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(app.fake.requests.map((r) => r.headers['idempotency-key'])).toEqual([
      'key-00000001',
      'key-00000001',
    ]);
  });

  it('offline: accepting is disabled and the invitation is kept', async () => {
    const app = createTestApp({ reachable: false });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeDisabled();
    expect(
      screen.getByText('Accepting needs a connection. The invitation is kept.'),
    ).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('signed out: asks to sign in and sends nothing', async () => {
    const app = createTestApp({ session: null });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('"Not now" says declining is not recorded', async () => {
    const app = createTestApp();
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const notNow = await screen.findByRole('button', { name: 'Not now' });
    expect(notNow).toHaveProp(
      'accessibilityHint',
      'Leaves without answering. Nothing is recorded.',
    );
    expect(screen.getByText(/Declining in the app is not available yet/)).toBeOnTheScreen();
  });
});

describe('SCR-C-17 InvitationScreen (team)', () => {
  it('SPK-CAP-001: offers the person and each child they may register, as radio choices with state', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(
          me({
            authorities: [
              { subjectPersonId: CHILD, permissions: ['view', 'register'] },
              { subjectPersonId: CHILD_TWO, permissions: ['view'] },
            ],
          }),
        ),
        'GET /people/{id}': peopleRoute([SAM, RIO]),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const self = await screen.findByRole('radio', { name: 'You, Alex Morgan' });
    expect(self).toBeChecked();
    const sam = await screen.findByRole('radio', { name: 'Sam Morgan' });
    expect(sam).not.toBeChecked();
    // Rio may be viewed but not registered: not offered.
    expect(screen.queryByRole('radio', { name: 'Rio Morgan' })).toBeNull();
    expect(screen.getByText('Accept for')).toBeOnTheScreen();
  });

  it('accepts for a child by sending personId, and names who joined the roster', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['register'] }] })),
        'GET /people/{id}': peopleRoute([SAM]),
        'POST /team-invitations/{id}/accept': ok(teamAccepted(CHILD, 'Sam Morgan')),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Sam Morgan' }));
    fireEvent.press(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Sam Morgan is on the team roster.')).toBeOnTheScreen();
    const post = app.fake.requests.find((r) => r.method === 'POST');
    expect(post?.route).toBe('/team-invitations/{id}/accept');
    expect(post?.body).toEqual({ token: TOKEN, personId: CHILD });
  });

  it('accepts for the person themself without a personId', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'POST /team-invitations/{id}/accept': ok(teamAccepted()),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Alex Morgan is on the team roster.')).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({ token: TOKEN });
  });

  it('shows "You cannot accept for this participant" on PARTICIPANT_AUTHORITY_REQUIRED', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['register'] }] })),
        'GET /people/{id}': peopleRoute([SAM]),
        'POST /team-invitations/{id}/accept': () =>
          apiError(403, 'PARTICIPANT_AUTHORITY_REQUIRED', {
            message: 'Authority over this participant is required.',
            nextAction: 'request_participant_authority',
          }),
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Sam Morgan' }));
    fireEvent.press(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(
      await screen.findByLabelText('You cannot accept for this participant'),
    ).toBeOnTheScreen();
    // The choice is kept for another attempt.
    expect(screen.getByRole('radio', { name: 'Sam Morgan' })).toBeChecked();
  });

  it('asks to finish setup first when the account is not linked to a person', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    await act(async () => undefined);
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});
