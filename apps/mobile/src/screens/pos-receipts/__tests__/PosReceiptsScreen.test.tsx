/**
 * Point-of-sale receipts (Package G; SPK-PAY-001, SPK-PAY-002, SPK-PAY-008, SPK-SCHED-008,
 * DEC-016, DEC-079, DEC-057, SPK-UX-008): each receipt as the API states it (lines, subtotal,
 * approved taxes and fees, total, tenders, returns), money in minor units with its currency, the
 * facility's name and zone; a card return never reads as refunded; readable while the switch is
 * off; paging; errors with their code; not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import {
  facility,
  G,
  ok,
  page,
  receipt,
  switchesOn,
} from '../../../features/package-g/__tests__/fixtures';
import { PosReceiptsScreen } from '../PosReceiptsScreen';

const RETURNED = receipt({
  saleId: G.saleB,
  saleNumber: 'S-1043',
  status: 'partially_returned',
  tenders: [
    { kind: 'cash', amountMinor: 400 },
    { kind: 'card', amountMinor: 250 },
  ],
  returns: [{ amountMinor: 325, tenderKind: 'card', returnedAt: '2026-10-24T01:15:00.000Z' }],
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...switchesOn('point_of_sale'),
    'GET /me/pos-receipts': ok(page([receipt(), RETURNED])),
    'GET /facilities/{id}': ok(facility()),
    ...overrides,
  };
}

function renderScreen(r: Record<string, FakeHandler> = routes()) {
  const app = createTestApp({ routes: r });
  render(<PosReceiptsScreen />, { wrapper: app.wrapper });
  return app;
}

describe('Package G PosReceiptsScreen (SPK-PAY-002)', () => {
  afterEach(settleApps);

  it('SPK-PAY-001: shows each receipt as the API states it, formatted from minor units, at the facility in its zone', async () => {
    renderScreen();
    const card = await screen.findByTestId(`receipt-${G.sale}`);
    expect(within(card).getByRole('header', { name: 'Receipt S-1042' })).toBeOnTheScreen();
    expect(within(card).getByLabelText('Paid')).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText('Paid: Oct 23, 2026, 11:30 AM PDT at North Fields'),
    ).toBeOnTheScreen();
    expect(within(card).getByLabelText('2 × Water bottle: $6.00 ($3.00 each)')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Subtotal: $6.00')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Sales tax: $0.50')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Total: $6.50')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Paid with: Card: $6.50')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Point-of-sale receipts' })).toBeOnTheScreen();
  });

  it('SPK-PAY-008: a card return is never shown as refunded; tenders are listed as recorded', async () => {
    renderScreen();
    const card = await screen.findByTestId(`receipt-${G.saleB}`);
    expect(within(card).getByLabelText('Paid, partly returned')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Paid with: Cash: $4.00')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Paid with: Card: $2.50')).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText('Returned Oct 23, 2026, 6:15 PM PDT: $3.25'),
    ).toBeOnTheScreen();
    expect(within(card).getByText(/does not show whether it has arrived/)).toBeOnTheScreen();
    expect(within(card).queryByText(/^Refunded to your card/)).toBeNull();
  });

  it('DEC-016: turned off by default naming DEC-079, while earlier receipts stay readable', async () => {
    renderScreen(routes(switchesOn()));
    const off = await screen.findByTestId('state-turned-off');
    expect(within(off).getByLabelText('Point-of-sale receipts turned off')).toBeOnTheScreen();
    expect(within(off).getByText(/DEC-079/)).toBeOnTheScreen();
    expect(
      within(off).getByText('Receipts of earlier purchases stay available here.'),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`receipt-${G.sale}`)).toBeOnTheScreen();
  });

  it('§4.5: "Load more receipts" reads the next page with the API cursor', async () => {
    const app = renderScreen(
      routes({
        'GET /me/pos-receipts': (req) =>
          fakeResponse(200, req.query.cursor ? page([RETURNED]) : page([receipt()], 'next-1')),
      }),
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Load more receipts' }));
    expect(await screen.findByTestId(`receipt-${G.saleB}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`receipt-${G.sale}`)).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/pos-receipts').at(-1)?.query).toEqual(
        { limit: '20', cursor: 'next-1' },
      ),
    );
  });

  it('without the facility read the device zone is named; the read error shows its code; refused is not available; none is empty', async () => {
    renderScreen(
      routes({
        'GET /facilities/{id}': {
          status: 404,
          body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
        },
      }),
    );
    const card = await screen.findByTestId(`receipt-${G.sale}`);
    expect(await within(card).findByText(/Times are in this device's time zone/)).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    let calls = 0;
    renderScreen(
      routes({
        'GET /me/pos-receipts': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-r' }))
            : fakeResponse(200, page([receipt()]));
        },
      }),
    );
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-r/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId(`receipt-${G.sale}`)).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderScreen(
      routes({ 'GET /me/pos-receipts': { status: 403, body: apiErrorBody('ACCESS_DENIED') } }),
    );
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderScreen(routes({ 'GET /me/pos-receipts': ok(page([])) }));
    expect(
      await screen.findByRole('header', { name: 'No point-of-sale receipts' }),
    ).toBeOnTheScreen();
  });
});
