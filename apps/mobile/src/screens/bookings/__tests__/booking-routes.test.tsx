/**
 * Package G booking routes in the real navigator (SPK-UX-001, SCR-C-39, §4.14): `/bookings/[id]`
 * opens the booking through `GET /v1/bookings/{id}`, a row of `/bookings` opens it, and a
 * malformed id is "Link not available" without any request. Route parameters are opaque ids.
 */
import { renderRouter, screen, fireEvent } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';
import { me } from '../../../features/money/testing/fixtures';
import {
  basket,
  booking,
  G,
  ok,
  page,
  switchesOn,
} from '../../../features/package-g/__tests__/fixtures';

function renderApp(initialUrl: string) {
  const app = createTestApp({
    routes: {
      ...switchesOn('rentals'),
      'GET /me': ok(me()),
      'GET /me/inbox': ok(page([])),
      'GET /me/bookings': ok(page([booking()])),
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket()),
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

describe('Package G booking routes', () => {
  it('a row of /bookings opens /bookings/[id], which reads the booking', async () => {
    const { app, router } = renderApp('/bookings');
    fireEvent.press(await screen.findByRole('button', { name: /^Court rental, Rental\./ }));
    expect(router.getPathname()).toBe(`/bookings/${G.booking}`);
    expect(await screen.findByTestId('screen-booking-detail')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Held for you: pay to confirm')).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/bookings/{id}')?.params.id).toBe(G.booking);
  });

  it('a malformed booking id is "Link not available" without a request', async () => {
    const { app } = renderApp('/bookings/not-an-id');
    expect((await screen.findAllByLabelText('Link not available')).length).toBeGreaterThan(0);
    expect(app.fake.requests.filter((r) => r.route === '/bookings/{id}')).toHaveLength(0);
  });
});
