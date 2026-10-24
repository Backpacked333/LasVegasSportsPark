/**
 * The registration routes under app/registration (SCR-C-07 to SCR-C-16) resolve to their screens
 * through the real Expo Router tree (SPK-UX-001 native navigation), carry only opaque ids, and
 * Discover leads to the offering detail.
 */
import { apiErrorBody, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import {
  IDS,
  basket,
  checkout,
  familyRoutes,
  offering,
  operation,
  page,
  quote,
  waitlistEntry,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';

const NOT_FOUND = {
  status: 404,
  body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
};

const ROUTES: Record<string, FakeHandler> = {
  ...familyRoutes(),
  'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
  'GET /offerings': page([offering()]),
  'GET /offerings/{id}': { status: 200, body: offering() },
  'GET /offerings/{id}/sessions': { status: 200, body: [] },
  'GET /policy-versions/{id}': NOT_FOUND,
  'GET /baskets/{id}': { status: 200, body: basket() },
  'GET /acknowledgments': { status: 200, body: [] },
  'GET /registration-quotes/{id}': { status: 200, body: quote() },
  'GET /credits': { status: 200, body: { items: [], nextCursor: null } },
  'GET /registration-checkouts/{id}': { status: 200, body: checkout() },
  'GET /operations/{id}': { status: 200, body: operation() },
  'GET /enrollments/{id}': NOT_FOUND,
  'GET /waitlist-entries/{id}': { status: 200, body: waitlistEntry() },
};

/** Rendering the whole router tree is slow on a shared machine; allow it time. */
const SLOW = { timeout: 5_000 };

function renderApp(initialUrl: string) {
  const app = createRegistrationTestApp({ routes: ROUTES });
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

describe('registration routes (SCR-C-07 to SCR-C-16)', () => {
  it('Discover opens the offering detail by its opaque id', async () => {
    const { router } = renderApp('/discover');
    fireEvent.press(await screen.findByRole('button', { name: /^Autumn Youth Program, / }, SLOW));
    expect(router.getPathname()).toBe(`/registration/offering/${IDS.offering}`);
    expect(await screen.findByRole('button', { name: 'Register' }, SLOW)).toBeOnTheScreen();
  });

  it.each([
    [`/registration/start/${IDS.offering}`, 'How do you want to register?'],
    [`/registration/basket/${IDS.basket}`, 'Your basket'],
    [`/registration/quote/${IDS.quote}`, 'Your price'],
    [`/registration/forms?basketId=${IDS.basket}`, 'Required forms'],
    [`/registration/checkout/${IDS.quote}`, 'Checkout'],
    [`/registration/outcome/${IDS.checkout}`, 'Registration and payment'],
    [`/registration/waitlist/${IDS.entry}`, 'Waitlist for Ada'],
    ['/registration/waitlists', 'No waitlists'],
  ])('%s resolves to its screen', async (url, heading) => {
    renderApp(url);
    expect(await screen.findByRole('header', { name: heading }, SLOW)).toBeOnTheScreen();
    expect(screen.queryByLabelText('Link not available')).toBeNull();
  });
});
