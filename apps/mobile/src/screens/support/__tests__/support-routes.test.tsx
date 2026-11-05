/**
 * Route wiring of SCR-C-37 and SCR-C-38 (SPK-UX-001 native navigation): the route files under
 * app/ resolve to their screens through the real router, a request opens by its opaque id only
 * (§4.14), and a malformed id is "Link not available" without any request (SCR-C-39).
 */
import { renderRouter, screen } from 'expo-router/testing-library';
import { ok } from '../../../features/today/__tests__/fixtures';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';

const CASE_ID = '0192f1a0-0000-7000-8000-00000000ca01';
const PAYMENT = '0192f1a0-0000-7000-8000-00000000cb01';

function renderAt(initialUrl: string) {
  const app = createTestApp({
    routes: {
      'GET /me/inbox': ok({ items: [], nextCursor: null }),
      'GET /me/cases': ok({ items: [], nextCursor: null }),
      'GET /me/team-entries': ok([]),
      'GET /me/cases/{id}': ok({
        id: CASE_ID,
        category: 'payment',
        title: 'Refund question',
        status: 'open',
        createdAt: '2026-10-24T11:00:00.000Z',
        updatedAt: '2026-10-24T11:00:00.000Z',
        resolvedAt: null,
      }),
      'GET /me/youth-feedback': ok({ assessments: [], recommendations: [] }),
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

describe('SCR-C-37 / SCR-C-38 routes', () => {
  it('/support opens the request form and the history', async () => {
    const { router } = renderAt('/support');
    expect(await screen.findByRole('button', { name: 'Send request' })).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'No requests yet' })).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/support');
  });

  it('/support with a linked record names it; a malformed one links nothing', async () => {
    renderAt(`/support?aboutType=payment_attempt&aboutId=${PAYMENT}`);
    expect(
      await screen.findByText('About this payment (from the link you followed).'),
    ).toBeOnTheScreen();

    screen.unmount();
    renderAt('/support?aboutType=person&aboutId=Sam');
    expect(await screen.findByRole('button', { name: 'Send request' })).toBeOnTheScreen();
    expect(screen.queryByTestId('support-about')).toBeNull();
  });

  it('/support/<id> opens one request by opaque id', async () => {
    renderAt(`/support/${CASE_ID}`);
    expect(await screen.findByRole('header', { name: 'Refund question' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Open')).toBeOnTheScreen();
  });

  it('SCR-C-39: a malformed request id is "Link not available" and sends no request', async () => {
    const { app } = renderAt('/support/not-a-request');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/me/cases/{id}')).toBe(false);
  });

  it('/youth-feedback opens the record (turned off while the switch is off, still readable)', async () => {
    renderAt('/youth-feedback');
    expect(
      await screen.findByLabelText('Youth assessments and progression turned off'),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'No feedback yet' })).toBeOnTheScreen();
  });
});
