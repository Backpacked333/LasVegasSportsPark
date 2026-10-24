/**
 * SCR-C-39 Verified link landing (SPK-UX-001, §4.13 safe deep-link destinations, §6.2 "Deep
 * links", "Notification opened after its event changes", SPK-AT-027). Covers redirect to the
 * target with the token kept out of the route, malformed and unsupported links, an operation shown
 * in its current state, NOT_FOUND as not available, offline, and the real router path through
 * +native-intent.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { clearLinkSecrets, readLinkSecret } from '../../../links/link-secrets';
import { resolveLinkParams } from '../../../links/link-targets';
import * as nativeIntent from '../../../../app/+native-intent';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';
import { LinkLanding, operationStatus, routeForTarget } from '../LinkLandingScreen';

const INVITATION = '0192f1a0-0000-7000-8000-00000000c001';
const OPERATION = '0192f1a0-0000-7000-8000-00000000d001';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-abcd';

const operation = (status: string, extra: Record<string, unknown> = {}) => ({
  id: OPERATION,
  kind: 'registration.checkout',
  status,
  correlationId: 'corr-1',
  result: null,
  error: null,
  createdAt: '2026-10-24T11:00:00.000Z',
  updatedAt: '2026-10-24T11:30:00.000Z',
  completedAt: null,
  ...extra,
});

afterEach(clearLinkSecrets);

describe('SCR-C-39 LinkLanding', () => {
  it('redirects an invitation link to its screen and keeps the token in memory, not in the route (§4.13, §4.14)', async () => {
    const app = createTestApp();
    const navigate = jest.fn();
    const resolution = resolveLinkParams({ to: 'invitation', id: INVITATION, token: TOKEN });
    render(<LinkLanding resolution={resolution} navigate={navigate} />, { wrapper: app.wrapper });
    await act(async () => undefined);
    expect(navigate).toHaveBeenCalledTimes(1);
    const href = navigate.mock.calls[0]?.[0] as string;
    expect(href).toBe(`/invitations/${INVITATION}?type=family`);
    expect(href).not.toContain(TOKEN);
    expect(readLinkSecret('invitation', INVITATION)).toBe(TOKEN);
    expect(app.fake.requests).toHaveLength(0); // a link never performs an action by itself
  });

  it('maps every redirect destination to an in-app route only', () => {
    expect(routeForTarget({ to: 'team-invitation', id: INVITATION, token: TOKEN })).toBe(
      `/invitations/${INVITATION}?type=team`,
    );
    expect(routeForTarget({ to: 'claim', token: TOKEN })).toBe('/onboarding');
    expect(routeForTarget({ to: 'inbox' })).toBe('/inbox');
    expect(routeForTarget({ to: 'family' })).toBe('/family');
    expect(routeForTarget({ to: 'preferences' })).toBe('/preferences');
    expect(routeForTarget({ to: 'account' })).toBe('/account');
    expect(routeForTarget({ to: 'operation', id: OPERATION })).toBeNull();
  });

  it('shows a malformed link as "Link not available" with a way home (validation failure)', async () => {
    const app = createTestApp();
    const navigate = jest.fn();
    render(<LinkLanding resolution={{ kind: 'malformed' }} navigate={navigate} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(screen.getByText(/incomplete or damaged/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Go to Home' }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('refuses an unsupported destination without following it', async () => {
    const app = createTestApp();
    const navigate = jest.fn();
    render(<LinkLanding resolution={{ kind: 'unsupported' }} navigate={navigate} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(screen.getByText(/does not open anything in the app/)).toBeOnTheScreen();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows an operation in its current state, read now from the API (stale link: current state shown)', async () => {
    const app = createTestApp({
      routes: { 'GET /operations/{id}': { status: 200, body: operation('succeeded') } },
    });
    render(
      <LinkLanding
        resolution={{ kind: 'target', target: { to: 'operation', id: OPERATION } }}
        navigate={jest.fn()}
      />,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByLabelText('Done')).toBeOnTheScreen();
    expect(screen.getByText(/This is the current state/)).toBeOnTheScreen();
    expect(app.fake.requests[0]?.path).toBe(`/operations/${OPERATION}`);
  });

  it('labels operation statuses with the journeys.md vocabulary, never colour alone', () => {
    expect(operationStatus('pending')).toEqual({ tone: 'pending', label: 'Processing' });
    expect(operationStatus('running').label).toBe('Processing');
    expect(operationStatus('succeeded').label).toBe('Done');
    expect(operationStatus('failed').label).toBe('Failed');
    expect(operationStatus('recovery_required').label).toBe('Needs attention');
    expect(operationStatus('compensated').label).toBe('Needs attention');
  });

  it('says not to repeat a request that needs attention (recovery required)', async () => {
    const app = createTestApp({
      routes: { 'GET /operations/{id}': { status: 200, body: operation('recovery_required') } },
    });
    render(
      <LinkLanding
        resolution={{ kind: 'target', target: { to: 'operation', id: OPERATION } }}
        navigate={jest.fn()}
      />,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByLabelText('Needs attention')).toBeOnTheScreen();
    expect(screen.getByText(/Do not repeat it/)).toBeOnTheScreen();
  });

  it('shows a target in another household (NOT_FOUND) as not available, without the code (§4.10)', async () => {
    const app = createTestApp({ routes: {} });
    render(
      <LinkLanding
        resolution={{ kind: 'target', target: { to: 'operation', id: OPERATION } }}
        navigate={jest.fn()}
      />,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('shows the API error code and "Try again" when the operation cannot be read', async () => {
    const app = createTestApp({
      routes: {
        'GET /operations/{id}': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      },
    });
    render(
      <LinkLanding
        resolution={{ kind: 'target', target: { to: 'operation', id: OPERATION } }}
        navigate={jest.fn()}
      />,
      { wrapper: app.wrapper },
    );
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('keeps the link and offers "Try again" when offline (cannot resolve)', async () => {
    const app = createTestApp({
      reachable: false,
      routes: { 'GET /operations/{id}': { status: 200, body: operation('running') } },
    });
    render(
      <LinkLanding
        resolution={{ kind: 'target', target: { to: 'operation', id: OPERATION } }}
        navigate={jest.fn()}
      />,
      { wrapper: app.wrapper },
    );
    expect((await screen.findAllByLabelText('You are offline')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nothing has been loaded yet/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});

describe('SCR-C-39 through the router (+native-intent)', () => {
  function renderApp(initialUrl: string) {
    const app = createTestApp({
      routes: {
        'GET /me': {
          status: 200,
          body: {
            principal: {
              kind: 'customer',
              organizationId: null,
              accountId: null,
              personId: null,
              staffRoles: [],
              facilityIds: [],
            },
            person: null,
            staffMemberships: [],
            authorities: [],
          },
        },
      },
    });
    const TestRootLayout = () => (
      <app.wrapper>
        <RootNavigator />
      </app.wrapper>
    );
    const router = renderRouter(
      { appDir: 'app', overrides: { _layout: TestRootLayout } },
      { initialUrl },
    );
    return { app, router };
  }

  // The test router hands redirectSystemPath the path only (it drops scheme and host), so the
  // scheme rewriting is unit-tested in src/links; here the landing route and its redirect run.
  it('opens an invitation link on the invitation screen, with no token in the path', async () => {
    const { router } = renderApp(`/link?to=team-invitation&id=${INVITATION}&token=${TOKEN}`);
    expect(await routerScreen.findByRole('header', { name: 'Team invitation' })).toBeOnTheScreen();
    expect(router.getPathname()).toBe(`/invitations/${INVITATION}`);
    expect(JSON.stringify(router.getSearchParams())).not.toContain(TOKEN);
    expect(readLinkSecret('team-invitation', INVITATION)).toBe(TOKEN);
  });

  it('lands an unsupported link on "Link not available"', async () => {
    const { router } = renderApp('/link?problem=unsupported');
    expect(await routerScreen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/link');
  });

  it('wires app/+native-intent to the safe-destination rewrite', () => {
    expect(
      nativeIntent.redirectSystemPath({ path: 'sportspark://payments/1', initial: true }),
    ).toBe('/link?problem=unsupported');
    expect(
      nativeIntent.redirectSystemPath({ path: 'sportspark://link?to=inbox', initial: false }),
    ).toBe('/link?to=inbox');
  });
});
