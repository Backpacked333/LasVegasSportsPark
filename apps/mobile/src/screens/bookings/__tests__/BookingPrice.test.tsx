/**
 * Package G booking price (SPK-PAY-002; park UI "booking prices"): a booking with a basket shows
 * `GET /v1/basket-prices/{id}`: the order's figures once checked out, an estimate before discounts
 * and credits otherwise (the quote is binding), "no price set" for an unpriced line, and
 * protected NOT_FOUND as "not available".
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react-native';
import { createRouterMock } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { basket, booking, G, ok } from '../../../features/package-g/__tests__/fixtures';
import { BookingDetailScreen, basketPriceLines } from '../BookingDetailScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function price(overrides: Record<string, unknown> = {}) {
  return {
    basketId: G.basket,
    basis: 'estimate',
    currency: 'USD',
    subtotalMinor: 9500,
    taxMinor: 760,
    feeMinor: 0,
    totalMinor: 10260,
    orderId: null,
    paymentStatus: null,
    asOf: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

function renderDetail(routes: Record<string, FakeHandler>) {
  const app = createTestApp({
    routes: { 'GET /bookings/{id}': ok(booking()), 'GET /baskets/{id}': ok(basket()), ...routes },
  });
  render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: app.wrapper });
  return app;
}

describe('booking price (GET /v1/basket-prices/{id})', () => {
  afterEach(settleApps);

  it('SPK-PAY-002: an estimate before discounts and credits, with tax, the quote being binding', async () => {
    const app = renderDetail({ 'GET /basket-prices/{id}': ok(price()) });
    const section = await screen.findByTestId('booking-price');
    expect(await within(section).findByLabelText('Subtotal: $95.00')).toBeOnTheScreen();
    expect(within(section).getByLabelText('Tax: $7.60')).toBeOnTheScreen();
    expect(within(section).queryByLabelText(/^Fees/)).toBeNull();
    expect(within(section).getByLabelText('Estimated total: $102.60')).toBeOnTheScreen();
    expect(
      within(section).getByText(/Your quote at checkout gives the binding price/),
    ).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/basket-prices/{id}')?.params.id).toBe(
      G.basket,
    );
  });

  it('once checked out, the order’s figures; an unpriced line says no price is set', async () => {
    renderDetail({ 'GET /basket-prices/{id}': ok(price({ basis: 'order', orderId: G.basket })) });
    expect(await screen.findByLabelText('Total: $102.60')).toBeOnTheScreen();
    expect(screen.getByText('From your order.')).toBeOnTheScreen();
    expect(
      basketPriceLines(
        price({ basis: 'unpriced', currency: null, totalMinor: null }) as Parameters<
          typeof basketPriceLines
        >[0],
      ),
    ).toEqual([]);
  });

  it('§4.10: protected NOT_FOUND is "Price not available"; a failure shows its code', async () => {
    renderDetail({
      'GET /basket-prices/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(await screen.findByText('Price not available')).toBeOnTheScreen();
    await settleApps();

    renderDetail({
      'GET /basket-prices/{id}': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
    });
    const sections = await screen.findAllByTestId('booking-price');
    expect(
      await within(sections.at(-1)!).findByText(/Error code: INTERNAL_ERROR/),
    ).toBeOnTheScreen();
  });

  it('a booking without a basket shows no price', async () => {
    renderDetail({ 'GET /bookings/{id}': ok(booking({ basketId: null, status: 'requested' })) });
    expect(await screen.findByTestId('booking-times')).toBeOnTheScreen();
    expect(screen.queryByTestId('booking-price')).toBeNull();
  });
});
