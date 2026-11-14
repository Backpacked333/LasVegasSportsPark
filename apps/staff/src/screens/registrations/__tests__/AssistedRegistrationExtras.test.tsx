/**
 * SCR-S-25 assisted registration, proposed amendments PA-03 (SPK-PAY-014: tier, days and add-ons,
 * capability `price_tiers_addons`, pending DEC-097) and PA-07 (SPK-REG-012: uniform size,
 * capability `uniforms`, pending DEC-101): the choices come from the offering's purchase options,
 * the line is sent with them, the basket line shows the API's estimate, and each add-on and the
 * uniform is its own quote line with the basis the quote stored. With the capabilities off the
 * form asks nothing new and sends the request of before.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ADDON_LUNCH_ID,
  ADDON_SHIRT_ID,
  CAMP_SESSIONS,
  SESSION_MON_ID,
  SESSION_TUE_ID,
  SESSION_WED_ID,
  TIER_DAYS_ID,
  TIER_WEEK_ID,
  UNIFORM_ID,
  purchaseOptions,
} from '../../../features/registration-finance/__tests__/extras-fixtures';
import {
  BASKET_ID,
  OFFERING_ID,
  PERSON_ID,
  PROGRAM_ID,
  basket,
  hold,
  nameRoutes,
  offering,
  ok,
  program,
  quote,
} from '../../../features/registration-finance/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';

const HELD = basket({ status: 'held', holds: [hold()], holdExpiresAt: '2026-10-24T12:10:00.000Z' });

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /baskets/{id}': ok(basket()),
    'GET /programs': ok({ items: [program()], nextCursor: null }),
    'GET /programs/{id}/offerings': ok({ items: [offering()], nextCursor: null }),
    'GET /offerings/{id}/purchase-options': ok(purchaseOptions()),
    'GET /offerings/{id}/sessions': ok(CAMP_SESSIONS),
    ...extra,
  };
}

async function chooseOffering(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Add a participant and offering' });
  const f = within(form);
  await user.type(f.getByLabelText(/^Participant/), PERSON_ID);
  await user.selectOptions(f.getByLabelText(/^Registration intent/), 'youth');
  await waitFor(() =>
    expect(f.getByRole('option', { name: 'Spring academy' })).toBeInTheDocument(),
  );
  await user.selectOptions(f.getByLabelText('Offering: program'), PROGRAM_ID);
  await waitFor(() =>
    expect(f.getByRole('option', { name: /Spring academy U10/ })).toBeInTheDocument(),
  );
  await user.selectOptions(f.getByLabelText('Offering: offering'), OFFERING_ID);
  return f;
}

describe('SCR-S-25 assisted registration: tier, days, add-ons and uniform', () => {
  it('SPK-PAY-014, SPK-REG-012: with the capabilities off the form asks nothing new, reads no purchase options and sends the request of before', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /baskets/{id}/lines': ok(basket(), 201) }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const f = await chooseOffering(user);
    expect(f.queryByLabelText(/^Price tier/)).not.toBeInTheDocument();
    expect(f.queryByRole('group', { name: /Tier, days, add-ons and uniform/ })).toBeNull();
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toEqual({
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 2,
      }),
    );
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/purchase-options')).toBe(
      false,
    );
  });

  it('SPK-PAY-014, SPK-REG-012: staff choose the tier, the days it allows, add-ons for days attended and the uniform size; the line is sent with them', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons', 'uniforms'] }),
        'POST /baskets/{id}/lines': ok(basket(), 201),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const f = await chooseOffering(user);
    const tier = await f.findByLabelText(/^Price tier/);
    // The proposed rules are named with their decision records.
    expect(f.getByText(/pending DEC-097/)).toBeInTheDocument();
    expect(f.getByText(/pending DEC-101/)).toBeInTheDocument();
    expect(
      within(tier).getByRole('option', { name: 'Two days: $130.00, 2 days of your choice' }),
    ).toBeInTheDocument();

    // Nothing chosen: the line is not sent and each missing choice is named.
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    expect(await f.findByText('Choose a price tier.')).toBeInTheDocument();
    expect(f.getByText('Choose a size: this offering requires the uniform.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);

    await user.selectOptions(tier, TIER_DAYS_ID);
    const days = await f.findByRole('group', { name: 'Days for Two days' });
    await user.click(within(days).getByLabelText(/^Day 1:/));
    // One day of two: still not sent.
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    // The hint already says it; the refusal repeats it as an error.
    await waitFor(() => expect(f.getAllByText('Choose 2 days of your choice.')).toHaveLength(2));
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);
    await user.click(within(days).getByLabelText(/^Day 3:/));
    // Lunch is offered only for the days chosen.
    const lunch = f.getByRole('group', { name: 'Lunch: $9.00 each day' });
    expect(within(lunch).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(lunch).queryByLabelText(/^Day 2:/)).not.toBeInTheDocument();
    await user.click(within(lunch).getByLabelText(/^Day 3:/));
    await user.click(f.getByLabelText('Add Camp shirt to this registration'));
    expect(f.getByText('Limited to 40 place(s) in all.')).toBeInTheDocument();
    await user.selectOptions(f.getByLabelText(/^Club kit size/), 'YM');
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toEqual({
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 2,
        priceTierId: TIER_DAYS_ID,
        selectedSessionIds: [SESSION_MON_ID, SESSION_WED_ID],
        addons: [
          { addonId: ADDON_LUNCH_ID, sessionIds: [SESSION_WED_ID] },
          { addonId: ADDON_SHIRT_ID },
        ],
        uniform: { offeringUniformId: UNIFORM_ID, size: 'YM' },
      }),
    );
  });

  it('SPK-PAY-014: a tier of every session sends no days, and an add-on can be chosen for any day', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons'] }),
        'GET /offerings/{id}/purchase-options': ok(purchaseOptions({ uniform: null })),
        'POST /baskets/{id}/lines': ok(basket(), 201),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const f = await chooseOffering(user);
    await user.selectOptions(await f.findByLabelText(/^Price tier/), TIER_WEEK_ID);
    expect(f.queryByRole('group', { name: /^Days for/ })).not.toBeInTheDocument();
    expect(f.queryByLabelText(/size$/)).not.toBeInTheDocument();
    const lunch = await f.findByRole('group', { name: 'Lunch: $9.00 each day' });
    await waitFor(() => expect(within(lunch).getAllByRole('checkbox')).toHaveLength(3));
    await user.click(within(lunch).getByLabelText(/^Day 2:/));
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toMatchObject({
        priceTierId: TIER_WEEK_ID,
        addons: [{ addonId: ADDON_LUNCH_ID, sessionIds: [SESSION_TUE_ID] }],
      }),
    );
    const sent = app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty('selectedSessionIds');
    expect(sent).not.toHaveProperty('uniform');
  });

  it('SPK-PAY-014, SPK-REG-012: a basket line shows the estimate of its tier, its days, its add-ons and its uniform, never the base price of another tier', async () => {
    const [line] = basket().lines;
    const chosen = basket({
      subtotalMinor: 13000 + 1800 + 2500,
      lines: [
        {
          ...(line as NonNullable<typeof line>),
          priceTierId: TIER_DAYS_ID,
          selectedSessionIds: [SESSION_MON_ID, SESSION_WED_ID],
          price: {
            priceRuleId: '0192f1a0-0000-7000-8000-000000002201',
            basePriceMinor: 30000,
            currency: 'USD',
            chargeLines: [],
            estimate: {
              pricingBasis: 'term',
              tier: { id: TIER_DAYS_ID, code: 'two_days', name: 'Two days' },
              appliedPrice: 'standard',
              appliedPriceMinor: 13000,
              sessionCount: null,
              unitPriceMinor: 13000,
              estimatedAt: '2026-10-24T12:00:00.000Z',
            },
          },
          addons: [
            {
              addonId: ADDON_LUNCH_ID,
              code: 'lunch',
              name: 'Lunch',
              selection: 'per_session',
              sessionIds: [SESSION_MON_ID, SESSION_WED_ID],
              priceMinor: 900,
              currency: 'USD',
              quantity: 2,
            },
          ],
          uniform: {
            offeringUniformId: UNIFORM_ID,
            itemKey: 'club-kit-2026',
            name: 'Club kit',
            size: 'YM',
            priceMinor: 2500,
            currency: 'USD',
            returningHolderFree: true,
            heldUniformOrderId: '0192f1a0-0000-7000-8000-000000004301',
          },
        },
      ],
    });
    const app = createTestApp({ routes: routes({ 'GET /baskets/{id}': ok(chosen) }) });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const lines = await screen.findByRole('list', { name: 'Basket lines' });
    const item = within(lines).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(item).getByText(/price \$130\.00/)).toBeInTheDocument();
    expect(within(item).queryByText(/\$300\.00/)).not.toBeInTheDocument();
    expect(
      within(item).getByText('Tier: Two days · Estimate: the quote decides the price'),
    ).toBeInTheDocument();
    expect(within(item).getByText('2 days chosen')).toBeInTheDocument();
    expect(within(item).getByText('Add-on Lunch: $9.00 each × 2 days')).toBeInTheDocument();
    expect(
      within(item).getByText(
        'Uniform Club kit, size YM: $25.00 (already held: the quote will not charge it again)',
      ),
    ).toBeInTheDocument();
  });

  it('SPK-PAY-014, SPK-REG-012: the quote shows each add-on and the uniform as its own line with the basis the quote stored', async () => {
    const user = userEvent.setup();
    const [base] = quote().lines;
    const line = base as NonNullable<typeof base>;
    const priced = quote({
      lines: [
        {
          ...line,
          description: 'Spring academy U10: Two days',
          unitPriceMinor: 13000,
          baseAmountMinor: 13000,
          totalMinor: 13000,
          priceBasis: {
            pricingBasis: 'term',
            standardPriceMinor: 13000,
            tier: {
              tierId: TIER_DAYS_ID,
              code: 'two_days',
              name: 'Two days',
              attendance: 'chosen_sessions',
              priceMinor: 13000,
              memberPriceMinor: null,
              availableUntil: null,
              purchasedAt: '2026-10-24T12:00:00.000Z',
              selectedSessionIds: [SESSION_MON_ID, SESSION_WED_ID],
            },
            appliedPrice: 'standard',
            appliedPriceMinor: 13000,
            member: null,
            sessions: null,
            unitPriceMinor: 13000,
          },
        },
        {
          ...line,
          id: '0192f1a0-0000-7000-8000-000000000711',
          sequence: 2,
          description: 'Lunch',
          quantity: 2,
          unitPriceMinor: 900,
          baseAmountMinor: 1800,
          totalMinor: 1800,
          lineKind: 'addon',
          sourceId: ADDON_LUNCH_ID,
          addon: {
            addonId: ADDON_LUNCH_ID,
            code: 'lunch',
            name: 'Lunch',
            selection: 'per_session',
            sessionIds: [SESSION_MON_ID, SESSION_WED_ID],
            quantity: 2,
            unitPriceMinor: 900,
          },
        },
        {
          ...line,
          id: '0192f1a0-0000-7000-8000-000000000712',
          sequence: 3,
          description: 'Club kit (YM)',
          unitPriceMinor: 0,
          baseAmountMinor: 0,
          totalMinor: 0,
          lineKind: 'uniform',
          sourceId: UNIFORM_ID,
          uniform: {
            offeringUniformId: UNIFORM_ID,
            itemKey: 'club-kit-2026',
            name: 'Club kit',
            size: 'YM',
            priceMinor: 2500,
            charged: false,
            reason: 'returning_holder',
            heldUniformOrderId: '0192f1a0-0000-7000-8000-000000004301',
            unitPriceMinor: 0,
          },
        },
      ],
      subtotalMinor: 14800,
      totalMinor: 14800,
      dueNowMinor: 14800,
    });
    const app = createTestApp({
      routes: routes({
        'GET /baskets/{id}': ok(HELD),
        'POST /registration-quotes': ok(priced, 201),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    await user.click(await screen.findByRole('button', { name: 'Price the basket' }));
    const table = await screen.findByRole('table', { name: 'Quote lines' });
    const [, place, lunch, kit] = within(table).getAllByRole('row') as HTMLElement[];
    expect(
      within(place as HTMLElement).getByText('Tier: Two days (2 days chosen)'),
    ).toBeInTheDocument();
    expect(within(lunch as HTMLElement).getByText(/Add-on: Lunch/)).toBeInTheDocument();
    expect(
      within(lunch as HTMLElement).getByText('$9.00 each × 2 days = $18.00'),
    ).toBeInTheDocument();
    expect(within(kit as HTMLElement).getByText(/Uniform: Club kit \(YM\)/)).toBeInTheDocument();
    expect(within(kit as HTMLElement).getByText('Size YM')).toBeInTheDocument();
    expect(
      within(kit as HTMLElement).getByText(
        'Not charged: the participant already holds this uniform (listed at $25.00).',
      ),
    ).toBeInTheDocument();
  });
});
