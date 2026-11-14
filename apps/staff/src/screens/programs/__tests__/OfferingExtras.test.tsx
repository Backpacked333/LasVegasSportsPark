/**
 * SCR-S-14 offering setup, proposed amendments PA-03 (SPK-PAY-014: price tiers and add-ons,
 * capability `price_tiers_addons`, pending DEC-097) and PA-07 (SPK-REG-012: uniform, capability
 * `uniforms`, pending DEC-101): with a capability off the screen is the screen of before; with it
 * on, staff enter tiers with the price rule, add and retire add-ons, and set the uniform. Tiers,
 * add-ons, sizes and prices are test data, not policy.
 */
import type { Schema } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ADDON_LUNCH_ID,
  SHIRT,
  TWO_DAYS,
  UNIFORM_ID,
  addon,
  tier,
  uniform,
} from '../../../features/registration-finance/__tests__/extras-fixtures';
import {
  NOW,
  OFFERING_ID,
  apiError,
  entitlement,
  offering,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { codeOf, tiersOf } from '../OfferingExtras';

function priceRule(overrides: Partial<Schema<'PriceRule'>> = {}): Schema<'PriceRule'> {
  return {
    id: '0192f1a0-0000-7000-8000-000000002201',
    offeringId: OFFERING_ID,
    version: 1,
    effectiveFrom: '2026-10-25T07:00:00.000Z',
    effectiveTo: null,
    basePriceMinor: 30000,
    currency: 'USD',
    chargeLines: [],
    pricingBasis: 'term',
    memberPriceMinor: null,
    memberEntitlementDefinitionId: null,
    memberEntitlementName: null,
    tiers: [],
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([]),
    'GET /offerings/{id}/price-rules': ok([]),
    'GET /offerings/{id}/addons': ok([]),
    'GET /offerings/{id}/uniforms': ok([]),
    'GET /policy-versions': () => fakeResponse(200, { items: [], nextCursor: null }),
    'GET /entitlement-definitions': ok([entitlement()]),
    ...extra,
  };
}

const at = `/programs/offerings/${OFFERING_ID}`;

describe('SCR-S-14 offering setup: price tiers, add-ons and uniform', () => {
  it('SPK-PAY-014, SPK-REG-012: with the capabilities off there is no tier row, no add-on section and no uniform section, and nothing of them is requested', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(at));
    const form = await screen.findByRole('form', { name: 'New price rule version' });
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(
      within(form).queryByRole('button', { name: 'Add a price tier' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Uniform' })).not.toBeInTheDocument();
    expect(app.fake.requests.some((r) => /\/(addons|uniforms)$/.test(r.route ?? ''))).toBe(false);
  });

  it('SPK-PAY-014: the tiers a rule carries are listed as stored, and new tiers are sent with the price rule in minor units', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons'] }),
        'GET /offerings/{id}/price-rules': ok([
          priceRule({
            tiers: [tier({ availableUntil: '2026-11-10T08:00:00.000Z' }), TWO_DAYS],
          }),
        ]),
        'POST /offerings/{id}/price-rules': ok({}, 201),
      }),
    });
    render(app.at(at));
    const versions = await screen.findByRole('list', { name: 'Price rule versions' });
    expect(
      within(versions).getByText(
        'Tier Full week: $300.00, every session, until Tue, Nov 10, 2026, 12:00 AM PST',
      ),
    ).toBeInTheDocument();
    expect(within(versions).getByText('Tier Two days: $130.00, 2 chosen days')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'New price rule version' });
    const f = within(form);
    await user.click(await f.findByRole('button', { name: 'Add a price tier' }));
    // The proposed rule is named with its decision record.
    expect(f.getByText(/pending DEC-097/)).toBeInTheDocument();
    await user.type(f.getByLabelText(/^Base price/), '300.00');
    await user.type(f.getByLabelText(/^Currency/), 'usd');
    await user.type(f.getByLabelText(/^Effective from/), '2026-10-25T00:00');
    // A tier without a name or price is not sent.
    await user.click(f.getByRole('button', { name: 'Create price rule version' }));
    expect(await f.findByText('Enter the name of the tier.')).toBeInTheDocument();
    expect(
      app.fake.requests.some(
        (r) => r.route === '/offerings/{id}/price-rules' && r.method === 'POST',
      ),
    ).toBe(false);

    await user.type(f.getByLabelText('Tier 1 name'), 'Full week');
    await user.type(f.getByLabelText('Tier 1 price'), '300.00');
    await user.click(f.getByRole('button', { name: 'Add a price tier' }));
    await user.type(f.getByLabelText('Tier 2 name'), 'Single day');
    await user.selectOptions(f.getByLabelText('Tier 2 attends'), 'chosen_sessions');
    await user.type(f.getByLabelText('Tier 2 fewest days'), '1');
    await user.type(f.getByLabelText('Tier 2 most days'), '1');
    await user.type(f.getByLabelText('Tier 2 price'), '70.00');
    // Member pricing is off: a tier has no member price input.
    expect(f.queryByLabelText('Tier 1 member price')).not.toBeInTheDocument();
    await user.click(f.getByRole('button', { name: 'Create price rule version' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find(
          (r) => r.route === '/offerings/{id}/price-rules' && r.method === 'POST',
        )?.body,
      ).toEqual({
        effectiveFrom: '2026-10-25T07:00:00.000Z',
        basePriceMinor: 30000,
        currency: 'USD',
        chargeLines: [],
        tiers: [
          { code: 'full_week', name: 'Full week', attendance: 'all_sessions', priceMinor: 30000 },
          {
            code: 'single_day',
            name: 'Single day',
            attendance: 'chosen_sessions',
            minSessions: 1,
            maxSessions: 1,
            priceMinor: 7000,
          },
        ],
      }),
    );
  });

  it('SPK-PAY-014: tier rows become request tiers; a duplicate name, a missing bound or an unreadable price is reported per row', () => {
    const row = {
      name: 'Three days',
      attendance: 'chosen_sessions' as const,
      min: '3',
      max: '',
      price: '190',
      memberPrice: '170',
      until: '2026-11-10T00:00',
    };
    expect(codeOf('  Full week (early)! ')).toBe('full_week_early');
    expect(tiersOf([row], 'USD', 'America/Los_Angeles', true)).toEqual({
      errors: {},
      tiers: [
        {
          code: 'three_days',
          name: 'Three days',
          attendance: 'chosen_sessions',
          minSessions: 3,
          priceMinor: 19000,
          memberPriceMinor: 17000,
          availableUntil: '2026-11-10T08:00:00.000Z',
        },
      ],
    });
    // Without a membership on the rule, a member price is never sent.
    expect(tiersOf([row], 'USD', null, false).tiers[0]).not.toHaveProperty('memberPriceMinor');
    expect(
      tiersOf(
        [row, row, { ...row, name: 'Other', min: '' }, { ...row, name: 'Fourth', price: 'x' }],
        'USD',
        null,
        false,
      ).errors,
    ).toEqual({
      'tiers.1': 'Each tier needs its own name.',
      'tiers.2': 'Enter the fewest days the customer chooses.',
      'tiers.3': 'Enter the price of the tier, for example 190.00.',
    });
  });

  it('SPK-PAY-014: finance adds an add-on for each day with its own capacity and retires one with its revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons'] }),
        'GET /offerings/{id}/addons': ok([addon(), { ...SHIRT, status: 'retired' }]),
        'POST /offerings/{id}/addons': ok(addon(), 201),
        'POST /offering-addons/{id}/retire': ok({ ...addon(), status: 'retired', revision: 2 }),
      }),
    });
    render(app.at(at));
    expect(await screen.findByRole('heading', { name: 'Add-ons' })).toBeInTheDocument();
    // The uniform capability is off: its section is absent.
    expect(screen.queryByRole('heading', { name: 'Uniform' })).not.toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Add-ons' });
    expect(within(list).getByText('Lunch: $9.00 each day')).toBeInTheDocument();
    expect(within(list).getByText('Chosen for each day · no limit')).toBeInTheDocument();
    expect(
      within(list).getByText('Chosen once for the registration · 40 place(s)'),
    ).toBeInTheDocument();
    expect(within(list).getByText('retired')).toBeInTheDocument();
    // Only the active add-on can be retired.
    expect(within(list).getAllByRole('button')).toHaveLength(1);

    const form = screen.getByRole('form', { name: 'New add-on' });
    const f = within(form);
    await user.click(f.getByRole('button', { name: 'Add the add-on' }));
    expect(await f.findByText('Enter the name of the add-on.')).toBeInTheDocument();
    await user.type(f.getByLabelText(/^Add-on name/), 'Early care');
    await user.type(f.getByLabelText(/^Add-on price/), '12.00');
    await user.clear(f.getByLabelText(/^Add-on currency/));
    await user.type(f.getByLabelText(/^Add-on currency/), 'usd');
    await user.selectOptions(f.getByLabelText(/^Add-on is chosen/), 'per_session');
    await user.type(f.getByLabelText(/^Add-on capacity/), '12');
    await user.click(f.getByRole('button', { name: 'Add the add-on' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/offerings/{id}/addons' && r.method === 'POST')
          ?.body,
      ).toEqual({
        code: 'early_care',
        name: 'Early care',
        priceMinor: 1200,
        currency: 'USD',
        selection: 'per_session',
        capacity: 12,
      }),
    );
    await user.click(within(list).getByRole('button', { name: 'Retire Lunch' }));
    await waitFor(() => {
      const retire = app.fake.requests.find((r) => r.route === '/offering-addons/{id}/retire');
      expect(retire?.params).toMatchObject({ id: ADDON_LUNCH_ID });
      expect(retire?.body).toEqual({ expectedRevision: 1 });
    });
  });

  it('SPK-PAY-014: an add-on the API refuses is shown with its reason, and what was typed is kept', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons'] }),
        'POST /offerings/{id}/addons': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'This offering already has a live add-on with that code.',
          details: { code: 'ADDON_CODE_TAKEN' },
        }),
      }),
    });
    render(app.at(at));
    const form = await screen.findByRole('form', { name: 'New add-on' });
    const f = within(form);
    await user.type(f.getByLabelText(/^Add-on name/), 'Lunch');
    await user.type(f.getByLabelText(/^Add-on price/), '9.00');
    await user.type(f.getByLabelText(/^Add-on currency/), 'USD');
    await user.click(f.getByRole('button', { name: 'Add the add-on' }));
    expect(
      await f.findByText(/This offering already has a live add-on with that code\./),
    ).toBeInTheDocument();
    expect(f.getByLabelText(/^Add-on name/)).toHaveValue('Lunch');
  });

  it('SPK-REG-012: finance sets the uniform with its sizes, price and returning-participant rule; one is live at a time', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['uniforms'] }),
        'POST /offerings/{id}/uniforms': ok(uniform(), 201),
      }),
    });
    render(app.at(at));
    expect(await screen.findByRole('heading', { name: 'Uniform' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).not.toBeInTheDocument();
    expect(screen.getByText(/pending DEC-101/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Uniforms ordered and hand-over' })).toHaveAttribute(
      'href',
      `/programs/offerings/${OFFERING_ID}/uniforms`,
    );
    const form = await screen.findByRole('form', { name: 'Set the uniform' });
    const f = within(form);
    await user.click(f.getByRole('button', { name: 'Set the uniform' }));
    expect(await f.findByText('Enter at least one size, separated by commas.')).toBeInTheDocument();
    await user.type(f.getByLabelText(/^Uniform name/), 'Club kit');
    await user.type(f.getByLabelText(/^Kit reference/), 'club-kit-2026');
    await user.type(f.getByLabelText(/^Sizes/), 'YS, YM, YL, YM');
    await user.type(f.getByLabelText(/^Uniform price/), '25.00');
    await user.type(f.getByLabelText(/^Uniform currency/), 'usd');
    await user.click(f.getByLabelText('Required: the customer must choose a size'));
    await user.click(
      f.getByLabelText('A participant who already holds this uniform is not charged again'),
    );
    await user.click(f.getByRole('button', { name: 'Set the uniform' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/offerings/{id}/uniforms' && r.method === 'POST')
          ?.body,
      ).toEqual({
        itemKey: 'club-kit-2026',
        name: 'Club kit',
        sizes: ['YS', 'YM', 'YL'],
        requirement: 'required',
        returningHolderFree: true,
        priceMinor: 2500,
        currency: 'USD',
      }),
    );
  });

  it('SPK-REG-012: with a live uniform the form is replaced by the uniform as stored, which can be retired', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['uniforms'] }),
        'GET /offerings/{id}/uniforms': ok([uniform()]),
        'POST /offering-uniforms/{id}/retire': ok({ ...uniform(), status: 'retired', revision: 2 }),
      }),
    });
    render(app.at(at));
    const list = await screen.findByRole('list', { name: 'Uniforms' });
    expect(within(list).getByText('Club kit: $25.00')).toBeInTheDocument();
    expect(
      within(list).getByText(
        'Required · sizes YS, YM, YL · reference club-kit-2026 · a participant who already holds it is not charged again',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Set the uniform' })).not.toBeInTheDocument();
    expect(screen.getByText(/One uniform at a time/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Retire Club kit' }));
    await waitFor(() => {
      const retire = app.fake.requests.find((r) => r.route === '/offering-uniforms/{id}/retire');
      expect(retire?.params).toMatchObject({ id: UNIFORM_ID });
      expect(retire?.body).toEqual({ expectedRevision: 1 });
    });
  });
});
