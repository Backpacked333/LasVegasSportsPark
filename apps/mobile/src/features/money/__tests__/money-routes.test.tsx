/**
 * Route wiring of SCR-C-32 to SCR-C-38 (SPK-UX-001 native navigation): every route file under
 * app/ resolves to its screen through the real router, with opaque ids only (§4.14), and the
 * Account hub map names each section's route.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { renderRouter, screen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { ACCOUNT_SECTION_ROUTES } from '../routes';
import {
  IDS,
  accountRoutes,
  cancellationPreview,
  enrollment,
  makeup,
  obligation,
  offering,
  page,
} from '../testing/fixtures';
import { createTestApp } from '../../../testing/test-app';

function renderAt(initialUrl: string) {
  const app = createTestApp({
    routes: {
      ...accountRoutes({ child: false }),
      'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
      'GET /enrollments': page([]),
      'GET /enrollments/{id}': { status: 200, body: enrollment() },
      'GET /enrollments/{id}/cancellation-preview': { status: 200, body: cancellationPreview() },
      'GET /offerings/{id}': { status: 200, body: offering() },
      'GET /offerings': page([offering()]),
      'GET /obligations': page([]),
      'GET /obligations/{id}': (req) =>
        req.params.id === IDS.obligation
          ? fakeResponse(200, obligation({ orderId: null }))
          : fakeResponse(404, apiErrorBody('NOT_FOUND')),
      'GET /credits': page([]),
      'GET /makeup-entitlements': { status: 200, body: [] },
      'GET /makeup-entitlements/{id}': { status: 200, body: makeup() },
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

describe('SCR-C-32 to SCR-C-38 routes', () => {
  it.each([
    ['/enrollments', 'No enrollments yet'],
    ['/payments', 'No payments'],
    ['/credits', 'No credits'],
  ])('%s opens its screen', async (url, header) => {
    const { router } = renderAt(url);
    expect(await screen.findByRole('header', { name: header })).toBeOnTheScreen();
    expect(router.getPathname()).toBe(url);
  });

  it.each([
    [`/enrollments/${IDS.enrollment}`, 'Review cancellation'],
    [`/enrollments/${IDS.enrollment}/cancel`, 'Cancel registration'],
    [`/enrollments/${IDS.enrollment}/transfer`, 'Preview transfer'],
  ])('%s opens its screen by opaque id', async (url, button) => {
    renderAt(url);
    expect(await screen.findByRole('button', { name: button })).toBeOnTheScreen();
  });

  it('opens a balance by opaque id', async () => {
    renderAt(`/payments/${IDS.obligation}`);
    expect(await screen.findByLabelText('Left to pay: $40.00')).toBeOnTheScreen();
  });

  it('§4.10: a balance id the API does not know reads "Not available", not "Link not available"', async () => {
    renderAt('/payments/somewhere-unknown');
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Left to pay: $40.00')).toBeNull();
  });

  it('opens the makeup booking', async () => {
    renderAt(`/credits/makeup/${IDS.makeup}`);
    expect(await screen.findByRole('header', { name: 'Choose an activity' })).toBeOnTheScreen();
  });

  it.each([
    ['/youth-feedback', 'Waiting on a decision'],
    ['/support', 'Support requests in the app are not available yet'],
  ])('%s opens its screen', async (url, label) => {
    renderAt(url);
    expect(await screen.findByLabelText(label)).toBeOnTheScreen();
  });

  it('names a route for each Account hub section of this group', () => {
    expect(ACCOUNT_SECTION_ROUTES).toEqual({
      'SCR-C-32': '/enrollments',
      'SCR-C-34': '/payments',
      'SCR-C-35': '/credits',
      'SCR-C-37': '/youth-feedback',
      'SCR-C-38': '/support',
    });
  });
});
