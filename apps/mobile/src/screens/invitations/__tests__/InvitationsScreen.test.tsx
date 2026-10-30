/**
 * SCR-C-17 open invitations (SPK-IAM-004, SPK-CAP-001; inventory state "empty (no open
 * invitations)"): `GET /v1/me/invitations?direction=received&status=pending` and
 * `GET /v1/me/team-invitations?status=pending`, each paged, each opening the invitation.
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  fireEvent as routerFire,
  renderRouter,
  screen as routerScreen,
} from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';
import {
  apiError,
  CHILD,
  me,
  namesRoute,
  ok,
  OTHER_ADULT,
  page,
  person,
} from '../../account/__tests__/fixtures';
import { InvitationsScreen } from '../InvitationsScreen';

const FAMILY_ID = '0192f1a0-0000-7000-8000-00000000c001';
const FAMILY_TWO = '0192f1a0-0000-7000-8000-00000000c002';
const TEAM_ID = '0192f1a0-0000-7000-8000-00000000c101';

function familyView(id = FAMILY_ID, overrides: Record<string, unknown> = {}) {
  return {
    id,
    invitedByPersonId: OTHER_ADULT,
    recipientPersonId: null,
    recipientContact: { kind: 'email', value: 'alex@example.test' },
    scope: { type: 'person', personId: CHILD },
    relationshipKind: 'delegate',
    requestedPermissions: ['view', 'collect'],
    grantedPermissions: [],
    status: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    revokedAt: null,
    declinedAt: null,
    revision: 1,
    createdAt: '2026-10-24T10:00:00.000Z',
    inviter: { personId: OTHER_ADULT, displayName: 'Jordan Lee' },
    subjects: [{ personId: CHILD, displayName: 'Sam Morgan' }],
    effectiveStatus: 'pending',
    ...overrides,
  };
}

function teamView() {
  return {
    id: TEAM_ID,
    teamEntryId: '0192f1a0-0000-7000-8000-00000000e100',
    teamName: 'Thursday Strikers',
    seasonName: 'Fall 2026 Adult League',
    invitedBy: { personId: OTHER_ADULT, displayName: 'Jordan Lee' },
    message: null,
    status: 'pending',
    effectiveStatus: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    revision: 1,
  };
}

function listApp(routes: Record<string, unknown> = {}) {
  return createTestApp({
    routes: {
      'GET /me': ok(me({})),
      'GET /me/invitations': page([familyView()]),
      'GET /me/team-invitations': page([teamView()]),
      ...(routes as Record<string, never>),
    },
  });
}

describe('SCR-C-17 InvitationsScreen', () => {
  it('SPK-IAM-004: lists open family and team invitations with sender, scope, permissions and expiry', async () => {
    const app = listApp();
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    const family = await screen.findByTestId(`invitation-family-${FAMILY_ID}`);
    expect(family.props.accessibilityLabel).toMatch(
      /^Delegate for Sam Morgan, From Jordan Lee\. View and Collect, Open until /,
    );
    expect(family).toHaveProp('accessibilityHint', 'Opens the invitation');
    const team = await screen.findByTestId(`invitation-team-${TEAM_ID}`);
    expect(team.props.accessibilityLabel).toMatch(
      /^Thursday Strikers, Fall 2026 Adult League\. From Jordan Lee, Open until /,
    );
    const familyRead = app.fake.requests.find((r) => r.route === '/me/invitations');
    expect(familyRead?.query).toEqual({ direction: 'received', status: 'pending', limit: '20' });
    const teamRead = app.fake.requests.find((r) => r.route === '/me/team-invitations');
    expect(teamRead?.query).toEqual({ status: 'pending', limit: '20' });
  });

  it('empty: says there are no open invitations', async () => {
    const app = listApp({
      'GET /me/invitations': page([]),
      'GET /me/team-invitations': page([]),
    });
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No open invitations' })).toBeOnTheScreen();
  });

  it('loads older invitations with "Load more", sending the API cursor', async () => {
    const app = listApp({
      'GET /me/invitations': (request: { query: Record<string, string> }) =>
        request.query.cursor === 'c2'
          ? fakeResponse(200, { items: [familyView(FAMILY_TWO)], nextCursor: null })
          : fakeResponse(200, { items: [familyView()], nextCursor: 'c2' }),
    });
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Load more family access invitations' }),
    );
    expect(await screen.findByTestId(`invitation-family-${FAMILY_TWO}`)).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Load more family access invitations' }),
    ).toBeNull();
    const reads = app.fake.requests.filter((r) => r.route === '/me/invitations');
    expect(reads.map((r) => r.query.cursor)).toEqual([undefined, 'c2']);
  });

  it('partial completion: a failed team list shows its code and "Try again" while family invitations stay', async () => {
    const app = listApp({
      'GET /me/team-invitations': () =>
        apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
    });
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    // Each list answers on its own: wait for each one, never assert one after the other's flush.
    expect(await screen.findByTestId(`invitation-family-${FAMILY_ID}`)).toBeOnTheScreen();
    const failure = await screen.findByTestId('invitations-team');
    expect(await within(failure).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(failure).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('invitations-family')).queryByRole('button', { name: 'Try again' }),
    ).toBeNull();
  });

  it('a team invitation the API returns as pending but past its expiry (effectiveStatus expired) is not listed as open', async () => {
    const app = listApp({
      'GET /me/invitations': page([]),
      'GET /me/team-invitations': page([{ ...teamView(), effectiveStatus: 'expired' }]),
    });
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No open invitations' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'No team invitations' })).toBeOnTheScreen();
    expect(screen.queryByTestId(`invitation-team-${TEAM_ID}`)).toBeNull();
    expect(screen.queryByLabelText(/Expired/)).toBeNull();
  });

  it('asks to finish setup when the account is not linked to a person, and reads no invitations', async () => {
    const app = listApp({ 'GET /me': ok(me({ person: null })) });
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Finish setting up first')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/me/invitations')).toBe(false);
  });

  it('offline: keeps the cached invitations with their age', async () => {
    const app = listApp();
    render(<InvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId(`invitation-family-${FAMILY_ID}`)).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getAllByLabelText('You are offline').length).toBeGreaterThan(0);
    expect(screen.getByTestId(`invitation-team-${TEAM_ID}`)).toBeOnTheScreen();
  });
});

describe('SCR-C-17 navigation from the list', () => {
  it('opens a family invitation by id only (no token or name in the route)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/invitations': page([familyView()]),
        'GET /me/team-invitations': page([]),
        'GET /me/invitations/{id}': ok(familyView()),
        'GET /person-names': namesRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
      },
    });
    const TestRootLayout = () => (
      <app.wrapper>
        <RootNavigator />
      </app.wrapper>
    );
    const router = renderRouter(
      { appDir: 'app', overrides: { _layout: TestRootLayout } },
      { initialUrl: '/invitations' },
    );
    routerFire.press(await routerScreen.findByTestId(`invitation-family-${FAMILY_ID}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/invitations/${FAMILY_ID}`));
    const params = router.getSearchParams() as Record<string, string>;
    expect(params.type).toBe('family');
    expect(params).not.toHaveProperty('token');
    expect(JSON.stringify(params)).not.toContain('Sam');
    const details = await routerScreen.findByLabelText('Invitation details');
    expect(within(details).getByLabelText('From, Jordan Lee')).toBeOnTheScreen();
  });
});
