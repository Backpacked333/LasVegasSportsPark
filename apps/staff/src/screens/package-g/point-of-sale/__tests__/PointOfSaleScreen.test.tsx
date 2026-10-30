/**
 * SCR-S-55 Point of sale, setup and register sessions (Package G; §3.16 POS, SPK-PAY-001,
 * SPK-PAY-002, SPK-PAY-012, POL-018, DEC-016, DEC-079): turned off by default with existing
 * records readable, registers and their sessions, products with approved taxes and fees, the
 * revision on a product change, and closing a session with a counted amount whose difference is
 * raised for finance.
 */
import { CAPABILITY_PRESENTATION } from '@sportspark/api-client';
import {
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  FACILITIES,
  REGISTER_B_ID,
  REGISTER_ID,
  SALE_ID,
  SESSION_ID,
  apiError,
  baseRoutes,
  ok,
  page,
  permissions,
  product,
  register,
  session,
  taxVersion,
} from '../../../../features/pos-access-accounting/__tests__/fixtures';
import { FACILITY_A, createTestApp } from '../../../../testing/test-app';

const POS = '/finance/point-of-sale';
const ON = ['point_of_sale'] as const;
const FINANCE = [
  'finance.manage_pos_products',
  'finance.manage_pos_registers',
  'finance.operate_register',
  'finance.approve_pos_return',
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...baseRoutes(),
    'GET /pos-registers': page([
      register(),
      register({ id: REGISTER_B_ID, code: 'FD2', name: 'Snack bar', openSessionId: SESSION_ID }),
    ]),
    'GET /pos-products': page([product()]),
    'GET /policy-versions': page([taxVersion()]),
    'GET /pos-register-sessions/{id}': ok(session()),
    ...extra,
  };
}

describe('SCR-S-55 PointOfSaleScreen: registers, products and sessions', () => {
  it('DEC-016: opens from the Finance navigation turned off, keeps registers readable and offers no new commitment', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': permissions([], FINANCE) },
    });
    render(app.at('/finance'));
    const nav = await screen.findByRole('navigation', { name: 'Finance' });
    await user.click(within(nav).getByRole('link', { name: 'Point of sale (SCR-S-55)' }));
    const pageEl = await screen.findByTestId('package-g-point-of-sale');
    expect(pageEl).toHaveAccessibleName('Point of sale');
    const notice = await within(pageEl).findByTestId('state-turned-off');
    expect(notice).toHaveTextContent('Point of sale turned off');
    expect(notice).toHaveTextContent(
      `(${CAPABILITY_PRESENTATION.point_of_sale.decisions.join(', ')})`,
    );
    expect(notice).toHaveTextContent('Voids, returns, closing a register session');
    const list = await screen.findByRole('list', { name: 'Registers' });
    expect(within(list).getByText('Front desk (FD1)')).toBeInTheDocument();
    // New commitments are not offered while the switch is off; retiring stays (never gated).
    expect(screen.queryByRole('button', { name: 'Open a session on FD1' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Create a register' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retire register FD1' })).toBeInTheDocument();
  });

  it('§3.16 POS: opens a session with its opening float in the products’ currency, one key per intent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-registers/{id}/sessions': ok(session(), 201),
      },
    });
    render(app.at(POS));
    const list = await screen.findByRole('list', { name: 'Registers' });
    expect(
      within(list).getByRole('link', { name: 'Go to the open session of Snack bar' }),
    ).toHaveAttribute('href', `${POS}/sessions/${SESSION_ID}`);
    await user.click(within(list).getByRole('button', { name: 'Open a session on FD1' }));
    const form = screen.getByRole('form', { name: 'Open a session on FD1' });
    // The facility's products are all priced in USD: the API's answer, not a client default.
    await waitFor(() =>
      expect(within(form).getByLabelText(/^Currency of the cash drawer/)).toHaveValue('USD'),
    );
    await user.type(within(form).getByLabelText(/^Opening float \(USD\)/), '100');
    await user.click(within(form).getByRole('button', { name: 'Open the session' }));
    expect(await screen.findByRole('heading', { name: /Register session 0192f1a0/ })).toBeVisible();
    const call = app.fake.requests.find((r) => r.route === '/pos-registers/{id}/sessions');
    expect(call?.params.id).toBe(REGISTER_ID);
    expect(call?.body).toEqual({ currency: 'USD', openingFloatMinor: 10000 });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('creates a register and shows the API refusal of a code already used, keeping the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-registers': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'Another register already uses this code.',
          nextAction: 'resolve_conflict',
          details: { code: 'REGISTER_CODE_TAKEN' },
        }),
      },
    });
    render(app.at(POS));
    const form = await screen.findByRole('form', { name: 'Create a register' });
    await within(form).findByRole('option', { name: 'North Park' });
    await user.selectOptions(within(form).getByLabelText(/^Facility/), FACILITY_A);
    await user.type(within(form).getByLabelText(/^Register code/), 'fd1');
    await user.type(within(form).getByLabelText(/^Register name/), 'Front desk');
    await user.click(within(form).getByRole('button', { name: 'Create the register' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('This register code is already used');
    expect(refusal).toHaveTextContent('Error code: RESOURCE_CONFLICT (REGISTER_CODE_TAKEN)');
    const call = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/pos-registers');
    expect(call?.body).toEqual({ facilityId: FACILITY_A, code: 'FD1', name: 'Front desk' });
    expect(within(form).getByLabelText(/^Register code/)).toHaveValue('FD1');
  });

  it('a register command refused because the switch was turned off meanwhile shows "turned off"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-registers/{id}/sessions': () =>
          fakeResponse(403, capabilityDisabledBody('point_of_sale', ['DEC-016', 'DEC-079'])),
      },
    });
    render(app.at(POS));
    const list = await screen.findByRole('list', { name: 'Registers' });
    await user.click(within(list).getByRole('button', { name: 'Open a session on FD1' }));
    const form = screen.getByRole('form', { name: 'Open a session on FD1' });
    await waitFor(() =>
      expect(within(form).getByLabelText(/^Currency of the cash drawer/)).toHaveValue('USD'),
    );
    await user.type(within(form).getByLabelText(/^Opening float \(USD\)/), '50');
    await user.click(within(form).getByRole('button', { name: 'Open the session' }));
    const state = await within(form).findByTestId('state-turned-off');
    expect(state).toHaveTextContent('Point of sale turned off');
    expect(state).toHaveTextContent('Error code: ACCESS_DENIED (CAPABILITY_DISABLED)');
  });

  it('SPK-PAY-002, DEC-057: creates a product with the approved taxes and fees the catalog lists, price in minor units', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-products': ok(product({ sku: 'CAP', name: 'Team cap', priceMinor: 1850 }), 201),
      },
    });
    render(app.at(`${POS}/products`));
    const list = await screen.findByRole('list', { name: 'Products' });
    expect(within(list).getByText('Water bottle (WATER)')).toBeInTheDocument();
    expect(within(list).getByText(/\$2\.50/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Create a product' });
    await user.type(within(form).getByLabelText(/^SKU/), 'cap');
    await user.type(within(form).getByLabelText(/^Name/), 'Team cap');
    await user.selectOptions(within(form).getByLabelText(/^Kind/), 'merchandise');
    await user.type(within(form).getByLabelText(/^Currency/), 'usd');
    await user.type(within(form).getByLabelText(/^Price \(USD\)/), '18.50');
    const charges = await within(form).findByRole('group', { name: 'Taxes and fees' });
    await user.click(within(charges).getByLabelText('County sales tax (sales-tax)'));
    await user.click(within(form).getByRole('button', { name: 'Create the product' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'Product CAP created at $18.50.',
    );
    const call = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/pos-products');
    expect(call?.body).toEqual({
      sku: 'CAP',
      name: 'Team cap',
      kind: 'merchandise',
      priceMinor: 1850,
      currency: 'USD',
      chargePolicyKeys: ['sales-tax'],
    });
    const listCall = app.fake.requests.find((r) => r.route === '/policy-versions');
    expect(listCall?.query).toMatchObject({ kind: 'tax_fee', approvalStatus: 'approved' });
  });

  it('DEC-057: with no approved tax or fee, says products sell without charges instead of assuming a rate', async () => {
    const app = createTestApp({
      routes: {
        ...routes({ 'GET /policy-versions': page([]) }),
        'GET /me/permissions': permissions(ON, FINANCE),
      },
    });
    render(app.at(`${POS}/products`));
    expect(await screen.findByTestId('no-approved-charges')).toHaveTextContent(
      'No tax or fee is approved (DEC-057)',
    );
  });

  it('§4.9: a product change sends the revision it was read at; STALE_REVISION offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'PATCH /pos-products/{id}': apiError(409, 'STALE_REVISION', {
          message: 'The product changed since it was read.',
          nextAction: 'reload_current_state',
        }),
      },
    });
    render(app.at(`${POS}/products`));
    await user.click(await screen.findByRole('button', { name: 'Change WATER' }));
    const form = screen.getByRole('form', { name: 'Change WATER' });
    const price = within(form).getByLabelText(/^Price \(USD\)/);
    expect(price).toHaveValue('2.50');
    await user.clear(price);
    await user.type(price, '3');
    await user.click(within(form).getByRole('button', { name: 'Save the change' }));
    const stale = await within(form).findByTestId('state-stale');
    expect(stale).toHaveTextContent('This record changed since it was loaded');
    expect(within(stale).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/pos-products/{id}');
    expect(call?.body).toEqual({ priceMinor: 300, expectedRevision: 3 });
    expect(price).toHaveValue('3');
  });

  it('retires a product with a reason and its revision, even while the switch is off (never gated)', async () => {
    const user = userEvent.setup();
    let retired = false;
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions([], FINANCE),
        'GET /pos-products': () =>
          fakeResponse(200, {
            items: [
              retired
                ? product({ status: 'retired', retireReason: 'Discontinued', revision: 4 })
                : product(),
            ],
            nextCursor: null,
          }),
        'POST /pos-products/{id}/retire': () => {
          retired = true;
          return fakeResponse(200, product({ status: 'retired', retireReason: 'Discontinued' }));
        },
      },
    });
    render(app.at(`${POS}/products`));
    expect(await screen.findByTestId('state-turned-off')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Retire WATER' }));
    const form = screen.getByRole('form', { name: 'Retire WATER' });
    await user.click(within(form).getByRole('button', { name: 'Retire the product' }));
    expect(within(form).getByText('Enter a reason.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Reason for retiring/), 'Discontinued');
    await user.click(within(form).getByRole('button', { name: 'Retire the product' }));
    // The list is read again: the product is retired and offers nothing more.
    const list = await screen.findByRole('list', { name: 'Products' });
    expect(await within(list).findByText('Retired: Discontinued')).toBeInTheDocument();
    expect(within(list).getByText('retired')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Retire WATER' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire WATER' })).toBeNull();
    const call = app.fake.requests.find((r) => r.route === '/pos-products/{id}/retire');
    expect(call?.body).toEqual({ reason: 'Discontinued', expectedRevision: 3 });
  });

  it('§4.9: a stale product retirement offers Reload instead of applying it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-products/{id}/retire': apiError(409, 'STALE_REVISION', {
          message: 'The product changed since it was read.',
          nextAction: 'reload_current_state',
        }),
      },
    });
    render(app.at(`${POS}/products`));
    await user.click(await screen.findByRole('button', { name: 'Retire WATER' }));
    const form = screen.getByRole('form', { name: 'Retire WATER' });
    await user.type(within(form).getByLabelText(/^Reason for retiring/), 'Discontinued');
    await user.click(within(form).getByRole('button', { name: 'Retire the product' }));
    const stale = await screen.findByTestId('state-stale');
    expect(stale).toHaveTextContent('Error code: STALE_REVISION');
    const reads = app.fake.requests.filter((r) => r.route === '/pos-products').length;
    await user.click(within(stale).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/pos-products').length).toBeGreaterThan(
        reads,
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('state-stale')).toBeNull());
  });

  it('retires a register with a reason and its revision while the switch is off; an open session is refused with its code', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions([], FINANCE),
        'POST /pos-registers/{id}/retire': () => {
          attempts += 1;
          return attempts === 1
            ? fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'Close the register session before retiring the register.',
                correlationId: 'c-reg',
                nextAction: 'resolve_conflict',
                details: { code: 'REGISTER_SESSION_OPEN' },
              })
            : fakeResponse(200, register({ status: 'retired', retireReason: 'Moved' }));
        },
      },
    });
    render(app.at(POS));
    expect(await screen.findByTestId('state-turned-off')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Registers' });
    await user.click(within(list).getByRole('button', { name: 'Retire register FD1' }));
    const form = within(list).getByRole('form', { name: 'Retire register FD1' });
    expect(form).toHaveTextContent('A retired register opens no new session');
    await user.type(within(form).getByLabelText(/^Reason for retiring/), 'Moved');
    await user.click(within(form).getByRole('button', { name: 'Retire the register' }));
    const refusal = await within(list).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('The register has an open session');
    expect(refusal).toHaveTextContent('Close the open session with its counted cash first.');
    expect(refusal).toHaveTextContent('Error code: RESOURCE_CONFLICT (REGISTER_SESSION_OPEN)');
    // The form keeps the reason; once the session is closed elsewhere, the retirement goes through.
    expect(within(form).getByLabelText(/^Reason for retiring/)).toHaveValue('Moved');
    await user.click(within(form).getByRole('button', { name: 'Retire the register' }));
    await waitFor(() =>
      expect(within(list).queryByRole('form', { name: 'Retire register FD1' })).toBeNull(),
    );
    const calls = app.fake.requests.filter((r) => r.route === '/pos-registers/{id}/retire');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params.id).toBe(REGISTER_ID);
    expect(calls[0]?.body).toEqual({ reason: 'Moved', expectedRevision: 1 });
    // A definitive refusal ends the intent: the second attempt is a new key.
    expect(calls[1]?.headers['idempotency-key']).not.toBe(calls[0]?.headers['idempotency-key']);
  });

  it('POL-018: closes a session with the counted cash and its revision; a difference is raised for finance', async () => {
    const user = userEvent.setup();
    let closed = false;
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'GET /pos-register-sessions/{id}': () =>
          fakeResponse(
            200,
            closed
              ? session({
                  status: 'closed',
                  countedCashMinor: 12210,
                  varianceMinor: -500,
                  closedAt: '2026-10-25T03:00:00.000Z',
                  closedByPersonId: '0192f1a0-0000-7000-8000-0000000000dd',
                  revision: 5,
                })
              : session(),
          ),
        'POST /pos-register-sessions/{id}/close': () => {
          closed = true;
          return fakeResponse(201, session({ status: 'closed', varianceMinor: -500 }));
        },
      },
    });
    render(app.at(`${POS}/sessions/${SESSION_ID}`));
    const facts = await screen.findByLabelText('Register session');
    expect(within(facts).getByText('$127.10')).toBeInTheDocument();
    // SPK-SCHED-008: the facility's zone, named.
    expect(within(facts).getByText(/PDT/)).toBeInTheDocument();
    expect(within(facts).getByText('Oct 24, 2026')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Close the session' });
    expect(form).toHaveTextContent('no tolerance is approved (POL-018)');
    await user.type(within(form).getByLabelText(/^Counted cash \(USD\)/), '122.10');
    await user.click(within(form).getByRole('button', { name: 'Close with this count' }));
    expect(await screen.findByText('short by $5.00: raised for finance')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/pos-register-sessions/{id}/close');
    expect(call?.body).toEqual({ countedCashMinor: 12210, expectedRevision: 4 });
    expect(screen.queryByRole('form', { name: 'Close the session' })).toBeNull();
  });

  it('a session with open sales is not closed: the API names how many, the count is kept', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-register-sessions/{id}/close': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'Complete or void the open sales of this session before closing it.',
          nextAction: 'resolve_conflict',
          details: { code: 'SESSION_HAS_OPEN_SALES', openSales: 2 },
        }),
      },
    });
    render(app.at(`${POS}/sessions/${SESSION_ID}`));
    const form = await screen.findByRole('form', { name: 'Close the session' });
    await user.type(within(form).getByLabelText(/^Counted cash \(USD\)/), '127.10');
    await user.click(within(form).getByRole('button', { name: 'Close with this count' }));
    expect(await within(form).findByTestId('state-validation')).toHaveTextContent(
      'Complete or void the 2 open sales of this session',
    );
    expect(within(form).getByLabelText(/^Counted cash \(USD\)/)).toHaveValue('127.10');
  });

  it('starts a sale naming its customer and opens it; a sale is also opened by its reference', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'POST /pos-sales': ok({ id: SALE_ID }, 201),
        'GET /pos-sales/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    render(app.at(`${POS}/sessions/${SESSION_ID}`));
    const form = await screen.findByRole('form', { name: 'Start a sale' });
    await user.type(
      within(form).getByLabelText(/^Customer reference/),
      '0192f1a0-0000-7000-8000-000000000301',
    );
    expect(await within(form).findByTestId('person-preview')).toHaveTextContent('Alex Rivera');
    await user.click(within(form).getByRole('button', { name: 'Start the sale' }));
    // The sale page then reads the sale; here the API answers NOT_FOUND: "not available".
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/pos-sales');
    expect(call?.body).toEqual({
      registerSessionId: SESSION_ID,
      customerPersonId: '0192f1a0-0000-7000-8000-000000000301',
    });
  });

  it('without the operating permission the session offers no sale and names the permission', async () => {
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': permissions(ON, []) },
    });
    render(app.at(`${POS}/sessions/${SESSION_ID}`));
    expect(
      await screen.findByText('Selling needs the permission finance.operate_register.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Start a sale' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Close the session' })).toBeNull();
  });

  it('§4.10: a session the API does not show is "not available"; a malformed link names no record', async () => {
    const app = createTestApp({
      routes: {
        ...routes({
          'GET /pos-register-sessions/{id}': apiError(404, 'NOT_FOUND', {
            nextAction: 'verify_reference',
          }),
        }),
        'GET /me/permissions': permissions(ON, FINANCE),
      },
    });
    const view = render(app.at(`${POS}/sessions/${SESSION_ID}`));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    view.unmount();
    render(app.at(`${POS}/sessions/not-a-record`));
    expect(await screen.findByText('Link not available')).toBeInTheDocument();
  });

  it('shows the registers read error with its code and "Try again"', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me/permissions': permissions(ON, FINANCE),
        'GET /facilities': FACILITIES,
        'GET /pos-registers': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, {
                code: 'INTEGRATION_UNAVAILABLE',
                message: 'Unavailable.',
                correlationId: 'c-pos',
                nextAction: 'retry_later',
              })
            : fakeResponse(200, { items: [register()], nextCursor: null });
        },
      },
    });
    render(app.at(POS));
    expect(
      await screen.findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-pos'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Registers' })).toBeInTheDocument();
  });
});
