/**
 * SCR-C-17 Invitation acceptance (SPK-IAM-004 "Invitations record inviter, recipient, scope,
 * requested permissions and expiry; accepting grants only the authorized scope", SPK-IAM-003,
 * SPK-CAP-001, POL-044).
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
  namesRoute,
  ok,
  OTHER_ADULT,
  person,
  SELF,
  TOKEN,
} from '../../account/__tests__/fixtures';
import { InvitationScreen, invitationStateLabel } from '../InvitationScreen';

const INVITATION = '0192f1a0-0000-7000-8000-00000000c001';
const TEAM_ENTRY = '0192f1a0-0000-7000-8000-00000000e100';
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

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION,
    invitedByPersonId: OTHER_ADULT,
    recipientPersonId: null,
    recipientContact: { kind: 'email', value: 'alex@example.test' },
    scope: { type: 'person', personId: CHILD },
    relationshipKind: 'guardian',
    requestedPermissions: ['view', 'pay', 'collect'],
    grantedPermissions: [],
    status: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    revokedAt: null,
    declinedAt: null,
    revision: 1,
    createdAt: '2026-10-24T10:00:00.000Z',
    ...overrides,
  };
}

/** `GET /me/invitations/{id}` (InvitationView): names as the API gives them, fixed at issue. */
function familyView(overrides: Record<string, unknown> = {}) {
  return {
    ...invitation(),
    inviter: { personId: OTHER_ADULT, displayName: 'Jordan Lee' },
    subjects: [{ personId: CHILD, displayName: 'Sam Morgan' }],
    effectiveStatus: 'pending',
    ...overrides,
  };
}

function familyAccepted() {
  return {
    invitation: invitation({
      grantedPermissions: ['view', 'collect'],
      status: 'accepted',
      acceptedAt: AT,
      acceptedByPersonId: SELF,
      revision: 2,
    }),
    relationships: [],
    grants: [grant('view'), grant('collect')],
    droppedPermissions: ['pay'],
  };
}

/** `GET /team-invitations/{id}` (TeamInvitationView). */
function teamView(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION,
    teamEntryId: TEAM_ENTRY,
    teamName: 'Thursday Strikers',
    seasonName: 'Fall 2026 Adult League',
    invitedBy: { personId: OTHER_ADULT, displayName: 'Jordan Lee' },
    message: 'We play Thursdays at 7.',
    status: 'pending',
    effectiveStatus: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    revision: 3,
    ...overrides,
  };
}

function teamAccepted(personId = SELF, displayName = 'Alex Morgan') {
  return {
    invitation: {
      id: INVITATION,
      teamEntryId: TEAM_ENTRY,
      invitedByPersonId: OTHER_ADULT,
      recipientPersonId: personId,
      recipientContact: null,
      message: null,
      status: 'accepted',
      expiresAt: '2026-10-27T12:00:00.000Z',
      acceptedAt: AT,
      acceptedByPersonId: personId,
      revokedAt: null,
      rosterMembershipId: '0192f1a0-0000-7000-8000-00000000e200',
      revision: 4,
      createdAt: '2026-10-24T10:00:00.000Z',
    },
    membership: {
      id: '0192f1a0-0000-7000-8000-00000000e200',
      teamEntryId: TEAM_ENTRY,
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

function familyApp(routes: Record<string, unknown> = {}, reachable = true) {
  return createTestApp({
    reachable,
    routes: {
      'GET /me': ok(me({})),
      'GET /me/invitations/{id}': ok(familyView()),
      'GET /person-names': namesRoute([SAM, RIO]),
      ...(routes as Record<string, never>),
    },
  });
}

const posts = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST');

afterEach(clearLinkSecrets);

describe('SCR-C-17 InvitationScreen (family access)', () => {
  it('SPK-IAM-004: shows the sender, the people covered, the relationship, each requested permission and the expiry before anything is answered', async () => {
    const app = familyApp();
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('From, Jordan Lee')).toBeOnTheScreen();
    expect(screen.getByLabelText('For, Sam Morgan')).toBeOnTheScreen();
    expect(screen.getByLabelText('As, Guardian')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Permissions requested, View, Pay and Collect. Each one is separate.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Sent to, alex@example.test')).toBeOnTheScreen();
    // POL-044 is pending: the expiry is the one the API states.
    expect(screen.getByLabelText(/^Open until /)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeOnTheScreen();
    expect(posts(app)).toHaveLength(0);
    const read = app.fake.requests.find((r) => r.route === '/me/invitations/{id}');
    expect(read?.params.id).toBe(INVITATION);
    // The token never travels on a read (§4.14).
    expect(JSON.stringify(read)).not.toContain(TOKEN);
  });

  it('SPK-IAM-004: accepting lists exactly what was granted, what was left out, and nothing else', async () => {
    holdLinkSecret('invitation', TOKEN, INVITATION);
    const app = familyApp({ 'POST /invitations/{id}/accept': ok(familyAccepted()) });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByLabelText('Accepted')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'Sam Morgan: View and Collect. Not granted for Sam Morgan, because the sender no longer holds them: Pay',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('Nothing else was granted.')).toBeOnTheScreen();

    const post = posts(app)[0];
    expect(post?.params.id).toBe(INVITATION);
    expect(post?.body).toEqual({ token: TOKEN });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
    expect(readLinkSecret('invitation', INVITATION)).toBeNull(); // a used token is not kept
  });

  it('SPK-IAM-004: a household invitation says, per child, what was left out (only one child lost a permission)', async () => {
    const household = familyAccepted();
    household.invitation.scope = {
      type: 'household',
      householdId: '0192f1a0-0000-7000-8000-00000000f001',
    } as never;
    household.invitation.requestedPermissions = ['view', 'pay'];
    household.grants = [grant('view', CHILD), grant('pay', CHILD), grant('view', CHILD_TWO)];
    household.droppedPermissions = ['pay'];
    const app = familyApp({ 'POST /invitations/{id}/accept': ok(household) });
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

  it('permission restriction: an invitation addressed to someone else (NOT_FOUND on the read) is "not available", with no hint it exists and nothing to answer', async () => {
    const app = familyApp({
      'GET /me/invitations/{id}': () =>
        apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Invitation not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(screen.getByText(/verified on this account/)).toBeOnTheScreen();
  });

  it('a failed read shows its code and "Try again", and nothing can be answered yet', async () => {
    let calls = 0;
    const app = familyApp({
      'GET /me/invitations/{id}': () => {
        calls += 1;
        return calls === 1
          ? apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' })
          : fakeResponse(200, familyView());
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeOnTheScreen();
  });

  it('stale version: an invitation the read reports as expired shows "Expired" and offers no answer', async () => {
    const app = familyApp({
      'GET /me/invitations/{id}': ok(familyView({ effectiveStatus: 'expired' })),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const closed = await screen.findByTestId('invitation-closed');
    expect(closed).toBeOnTheScreen();
    expect(screen.getByLabelText('Expired')).toBeOnTheScreen();
    expect(screen.getByText(/has expired, so it cannot be answered/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('stale version: INVALID_TRANSITION on accept names the state the invitation is in now, reads it again and never keeps "Open until"', async () => {
    const app = familyApp({
      'POST /invitations/{id}/accept': () =>
        apiError(409, 'INVALID_TRANSITION', {
          nextAction: 'reload_current_state',
          details: { machine: 'Invitation', from: 'revoked', event: 'accept' },
        }),
    });
    holdLinkSecret('invitation', TOKEN, INVITATION);
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByLabelText('Revoked')).toBeOnTheScreen();
    // The invitation is read again; until that read reports it closed, the badge is the state the
    // refusal named, not the old "Open until".
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/invitations/{id}')).toHaveLength(2),
    );
    expect(await screen.findByLabelText('Revoked')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Open until /)).toBeNull();
    expect(screen.getByText(/The sender withdrew this invitation/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // A closed invitation's token is dead: it is not offered again.
    expect(readLinkSecret('invitation', INVITATION)).toBeNull();
  });

  it('stale version: after INVALID_TRANSITION the refreshed read shows the closed invitation as it is now', async () => {
    let reads = 0;
    const app = familyApp({
      'GET /me/invitations/{id}': () => {
        reads += 1;
        return fakeResponse(
          200,
          reads === 1
            ? familyView()
            : familyView({ status: 'revoked', effectiveStatus: 'revoked', revokedAt: AT }),
        );
      },
      'POST /invitations/{id}/accept': () =>
        apiError(409, 'INVALID_TRANSITION', {
          nextAction: 'reload_current_state',
          details: { machine: 'Invitation', from: 'revoked', event: 'accept' },
        }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText(/^Revoked .*\.$/)).toBeOnTheScreen(); // the read's revokedAt
    expect(reads).toBe(2);
    expect(screen.getByLabelText('Revoked')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Open until /)).toBeNull();
  });

  it('SPK-IAM-004: an invitation this person already accepted says so and points to what it gave them, not to the sender', async () => {
    const app = familyApp({
      'GET /me/invitations/{id}': ok(
        familyView({
          status: 'accepted',
          effectiveStatus: 'accepted',
          acceptedAt: AT,
          acceptedByPersonId: SELF,
          grantedPermissions: ['view', 'collect'],
        }),
      ),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByText('You accepted this invitation.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Accepted')).toBeOnTheScreen();
    expect(screen.getByText('Permissions granted: View and Collect.')).toBeOnTheScreen();
    expect(screen.queryByText(/Ask the sender/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Family and permissions' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
  });

  it('an invitation someone else accepted, or one that was declined, is not shown as answered by this person', async () => {
    const accepted = familyApp({
      'GET /me/invitations/{id}': ok(
        familyView({
          status: 'accepted',
          effectiveStatus: 'accepted',
          acceptedAt: AT,
          acceptedByPersonId: OTHER_ADULT,
        }),
      ),
    });
    const first = render(
      <InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />,
      { wrapper: accepted.wrapper },
    );
    expect(await screen.findByText(/has already been accepted/)).toBeOnTheScreen();
    expect(screen.queryByText('You accepted this invitation.')).toBeNull();
    first.unmount();

    const declined = familyApp({
      'GET /me/invitations/{id}': ok(
        familyView({ status: 'declined', effectiveStatus: 'declined', declinedAt: AT }),
      ),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: declined.wrapper,
    });
    expect(
      await screen.findByText(/was declined, so it can no longer be accepted/),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Declined')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('uses the journeys.md labels for every closed state', () => {
    expect(invitationStateLabel('accepted')).toBe('Accepted');
    expect(invitationStateLabel('declined')).toBe('Declined');
    expect(invitationStateLabel('expired')).toBe('Expired');
    expect(invitationStateLabel('revoked')).toBe('Revoked');
    expect(invitationStateLabel(undefined)).toBe('No longer open');
  });

  it('shows the API reason when the account may not accept yet (ACCESS_DENIED: contact not verified)', async () => {
    const app = familyApp({
      'POST /invitations/{id}/accept': () =>
        apiError(403, 'ACCESS_DENIED', {
          message: 'This invitation was sent to a contact point your account has not verified.',
          nextAction: 'contact_support_or_request_access',
        }),
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
    const app = familyApp({
      'POST /invitations/{id}/accept': () => {
        calls += 1;
        return calls === 1
          ? apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })
          : fakeResponse(200, familyAccepted());
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(posts(app).map((r) => r.headers['idempotency-key'])).toEqual([
      'key-00000001',
      'key-00000001',
    ]);
    expect(await screen.findByLabelText('Accepted')).toBeOnTheScreen();
  });

  it('SPK-IAM-004: declines after a confirmation with the token, the revision read and the optional reason', async () => {
    holdLinkSecret('invitation', TOKEN, INVITATION);
    const app = familyApp({
      'POST /invitations/{id}/decline': ok(
        invitation({ status: 'declined', declinedAt: AT, revision: 2 }),
      ),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const decline = await screen.findByRole('button', { name: 'Decline' });
    expect(decline).toHaveProp(
      'accessibilityHint',
      'Asks you to confirm. Declining cannot be undone.',
    );
    fireEvent.press(decline);
    expect(posts(app)).toHaveLength(0); // nothing is sent before the confirmation
    expect(screen.getByText(/Declining is final/)).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText('Reason (optional)'), 'I am not a guardian');
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));

    expect(await screen.findByTestId('invitation-declined')).toBeOnTheScreen();
    expect(screen.getByLabelText('Declined')).toBeOnTheScreen();
    const post = posts(app)[0];
    expect(post?.route).toBe('/invitations/{id}/decline');
    expect(post?.body).toEqual({
      token: TOKEN,
      expectedRevision: 1,
      reason: 'I am not a guardian',
    });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
    expect(readLinkSecret('invitation', INVITATION)).toBeNull();
  });

  it('stale version: STALE_REVISION on decline offers Reload, which reads the invitation again', async () => {
    let reads = 0;
    const app = familyApp({
      'GET /me/invitations/{id}': () => {
        reads += 1;
        return fakeResponse(200, familyView({ revision: reads }));
      },
      'POST /invitations/{id}/decline': () =>
        apiError(409, 'STALE_REVISION', { nextAction: 'reload_and_retry' }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    expect(posts(app)[0]?.body).toEqual({ token: TOKEN, expectedRevision: 1 });
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByRole('button', { name: 'Decline' })).toBeOnTheScreen();
    expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull();
  });

  it('§4.9: "Check again" on a decline resends the same request, revision included, under the same key after the read refreshed', async () => {
    let reads = 0;
    let declines = 0;
    const app = familyApp({
      'GET /me/invitations/{id}': () => {
        reads += 1;
        return fakeResponse(
          200,
          reads === 1
            ? familyView()
            : familyView({ revision: 2, expiresAt: '2026-10-29T12:00:00.000Z' }),
        );
      },
      'POST /invitations/{id}/decline': () => {
        declines += 1;
        return declines === 1
          ? apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })
          : fakeResponse(200, invitation({ status: 'declined', declinedAt: AT, revision: 2 }));
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.changeText(screen.getByLabelText('Reason (optional)'), 'Not me');
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    // The read refreshes meanwhile (return to the app, reconnect) with a newer revision.
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/me/invitations/{id}'] });
    });
    expect(await screen.findByLabelText(/^Open until .*29/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('invitation-declined')).toBeOnTheScreen();
    const sent = posts(app);
    expect(sent.map((r) => r.body)).toEqual([
      { token: TOKEN, expectedRevision: 1, reason: 'Not me' },
      { token: TOKEN, expectedRevision: 1, reason: 'Not me' },
    ]);
    expect(sent.map((r) => r.headers['idempotency-key'])).toEqual(['key-00000001', 'key-00000001']);
  });

  it('a failed decline offers no "Check again" once the read shows the invitation closed', async () => {
    let reads = 0;
    const app = familyApp({
      'GET /me/invitations/{id}': () => {
        reads += 1;
        return fakeResponse(
          200,
          reads === 1
            ? familyView()
            : familyView({ status: 'declined', effectiveStatus: 'declined', declinedAt: AT }),
        );
      },
      'POST /invitations/{id}/decline': () =>
        apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeOnTheScreen();
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/me/invitations/{id}'] });
    });
    expect(await screen.findByLabelText('Declined')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.queryByText(/INTEGRATION_UNAVAILABLE/)).toBeNull();
  });

  it('processing: the decline cannot be cancelled while its answer is outstanding', async () => {
    let answer: (response: Response) => void = () => undefined;
    const app = familyApp({
      'POST /invitations/{id}/decline': () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    expect(screen.getByRole('button', { name: 'Keep invitation' })).not.toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Keep invitation' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Keep invitation' })).toHaveProp(
      'accessibilityHint',
      'Waiting for the answer to the decline',
    );
    await act(async () => {
      answer(fakeResponse(200, invitation({ status: 'declined', declinedAt: AT, revision: 2 })));
    });
    expect(await screen.findByTestId('invitation-declined')).toBeOnTheScreen();
  });

  it('opened from the list without the link: shows the invitation and says to open the link to answer', async () => {
    const app = familyApp();
    render(<InvitationScreen invitationId={INVITATION} type="family" token={null} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('From, Jordan Lee')).toBeOnTheScreen();
    expect(screen.getByText(/To accept or decline, open the invitation link/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).toHaveProp(
      'accessibilityHint',
      'Leaves without answering. Nothing is recorded.',
    );
  });

  it('offline: answering is disabled and the invitation is kept on screen', async () => {
    const app = familyApp();
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).not.toBeDisabled();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled();
    expect(
      screen.getByText('Answering an invitation needs a connection. The invitation is kept.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('From, Jordan Lee')).toBeOnTheScreen();
    expect(posts(app)).toHaveLength(0);
  });

  it('signed out: asks to sign in and sends nothing', async () => {
    const app = createTestApp({ session: null });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('asks to finish setup first when the account is not linked to a person, without reading the invitation', async () => {
    const app = familyApp({ 'GET /me': ok(me({ person: null })) });
    render(<InvitationScreen invitationId={INVITATION} type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/me/invitations/{id}')).toBe(false);
  });

  it('a malformed id is "Invitation not available" and nothing is requested', async () => {
    const app = familyApp();
    render(<InvitationScreen invitationId="not-an-id" type="family" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Invitation not available')).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});

describe('SCR-C-17 InvitationScreen (team)', () => {
  function teamApp(routes: Record<string, unknown> = {}) {
    return createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /team-invitations/{id}': ok(teamView()),
        'GET /person-names': namesRoute([SAM, RIO]),
        ...(routes as Record<string, never>),
      },
    });
  }

  it('SPK-CAP-001: shows the team, season, sender, message and expiry before accepting', async () => {
    const app = teamApp();
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Team, Thursday Strikers')).toBeOnTheScreen();
    expect(screen.getByLabelText('Season, Fall 2026 Adult League')).toBeOnTheScreen();
    expect(screen.getByLabelText('From, Jordan Lee')).toBeOnTheScreen();
    expect(screen.getByLabelText('Message, We play Thursdays at 7.')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Open until /)).toBeOnTheScreen();
  });

  it('SPK-CAP-001: offers the person and each child they may register, as radio choices with state', async () => {
    const app = teamApp({
      'GET /me': ok(
        me({
          authorities: [
            { subjectPersonId: CHILD, permissions: ['view', 'register'] },
            { subjectPersonId: CHILD_TWO, permissions: ['view'] },
          ],
        }),
      ),
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
    const app = teamApp({
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['register'] }] })),
      'POST /team-invitations/{id}/accept': ok(teamAccepted(CHILD, 'Sam Morgan')),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const sam = await screen.findByRole('radio', { name: 'Sam Morgan' });
    await waitFor(() => expect(sam).not.toBeDisabled());
    fireEvent.press(sam);
    fireEvent.press(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Sam Morgan is on the team roster.')).toBeOnTheScreen();
    const post = posts(app)[0];
    expect(post?.route).toBe('/team-invitations/{id}/accept');
    expect(post?.body).toEqual({ token: TOKEN, personId: CHILD });
  });

  it('accepts for the person themself without a personId', async () => {
    const app = teamApp({ 'POST /team-invitations/{id}/accept': ok(teamAccepted()) });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Alex Morgan is on the team roster.')).toBeOnTheScreen();
    expect(posts(app)[0]?.body).toEqual({ token: TOKEN });
  });

  it('shows "You cannot accept for this participant" on PARTICIPANT_AUTHORITY_REQUIRED and keeps the choice', async () => {
    const app = teamApp({
      'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['register'] }] })),
      'POST /team-invitations/{id}/accept': () =>
        apiError(403, 'PARTICIPANT_AUTHORITY_REQUIRED', {
          message: 'Authority over this participant is required.',
          nextAction: 'request_participant_authority',
        }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    const sam = await screen.findByRole('radio', { name: 'Sam Morgan' });
    await waitFor(() => expect(sam).not.toBeDisabled());
    fireEvent.press(sam);
    fireEvent.press(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(
      await screen.findByLabelText('You cannot accept for this participant'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Sam Morgan' })).toBeChecked();
  });

  it('CMP-03: declines from the list without the link, sending the revision read; accepting needs the link', async () => {
    const app = teamApp({
      'POST /team-invitations/{id}/decline': ok(
        teamView({ status: 'declined', effectiveStatus: 'declined', revision: 4 }),
      ),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={null} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByText(/To accept, open the invitation link/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByLabelText('Declined')).toBeOnTheScreen();
    const post = posts(app)[0];
    expect(post?.route).toBe('/team-invitations/{id}/decline');
    expect(post?.body).toEqual({ expectedRevision: 3 });
    expect(post?.headers['idempotency-key']).toBe('key-00000001');
  });

  it('INVALID_TRANSITION on decline (expired meanwhile) shows "Expired", reads the invitation again and offers no further answer', async () => {
    const app = teamApp({
      'POST /team-invitations/{id}/decline': () =>
        apiError(409, 'INVALID_TRANSITION', {
          nextAction: 'reload_current_state',
          details: { machine: 'TeamInvitation', from: 'expired', event: 'decline' },
        }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByLabelText('Expired')).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/team-invitations/{id}')).toHaveLength(2),
    );
    // The read still says pending (the sweep has not run): the badge keeps the refused state.
    expect(await screen.findByLabelText('Expired')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Open until /)).toBeNull();
    expect(screen.getByText(/has expired, so it cannot be answered/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('§4.9: "Check again" on a team decline resends the revision read when the decline started', async () => {
    let reads = 0;
    let declines = 0;
    const app = teamApp({
      'GET /team-invitations/{id}': () => {
        reads += 1;
        return fakeResponse(
          200,
          reads === 1
            ? teamView()
            : teamView({ revision: 4, expiresAt: '2026-10-29T12:00:00.000Z' }),
        );
      },
      'POST /team-invitations/{id}/decline': () => {
        declines += 1;
        return declines === 1
          ? apiError(503, 'INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })
          : fakeResponse(200, teamView({ status: 'declined', effectiveStatus: 'declined' }));
      },
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={null} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    fireEvent.press(screen.getByRole('button', { name: 'Confirm decline' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/team-invitations/{id}'] });
    });
    expect(await screen.findByLabelText(/^Open until .*29/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByTestId('invitation-declined')).toBeOnTheScreen();
    expect(posts(app).map((r) => r.body)).toEqual([
      { expectedRevision: 3 },
      { expectedRevision: 3 },
    ]);
    expect(posts(app).map((r) => r.headers['idempotency-key'])).toEqual([
      'key-00000001',
      'key-00000001',
    ]);
  });

  it('a team invitation accepted already is not answered again and does not ask for a new one', async () => {
    const app = teamApp({
      'GET /team-invitations/{id}': ok(
        teamView({ status: 'accepted', effectiveStatus: 'accepted' }),
      ),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Accepted')).toBeOnTheScreen();
    expect(screen.getByText(/has already been accepted/)).toBeOnTheScreen();
    expect(screen.queryByText(/Ask the sender/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
  });

  it('permission restriction: a team invitation the API does not show (NOT_FOUND) is not available', async () => {
    const app = teamApp({
      'GET /team-invitations/{id}': () =>
        apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
    });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Invitation not available')).toBeOnTheScreen();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('asks to finish setup first when the account is not linked to a person', async () => {
    const app = teamApp({ 'GET /me': ok(me({ person: null })) });
    render(<InvitationScreen invitationId={INVITATION} type="team" token={TOKEN} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    expect(posts(app)).toHaveLength(0);
  });
});
