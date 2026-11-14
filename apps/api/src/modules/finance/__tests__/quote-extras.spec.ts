import { newId, type QuoteLineAddonBasis, type QuoteLinePriceBasis } from '@sportspark/contracts';
import { json, pgConstraintName, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCapability, type TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createEntitlementDefinitionFixture,
  createOfferingAddonFixture,
  createOfferingSessionFixture,
  createOfferingUniformFixture,
  createPolicyVersionFixture,
  createPriceRuleFixture,
  createPriceRuleTierFixture,
  type OfferingFixture,
} from '../../catalog';
import {
  createEnrollmentFixture,
  FINANCE_POLICY_IMPL,
  type FinancePolicyPort,
} from '../../enrollment';
import { unitPriceFromBasis } from '../pricing/quote-calculator';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import {
  adult,
  child,
  drain,
  financeTestApp,
  offering,
  post,
  rejectsWith,
  type Actor,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const UNIQUE = '23505';
const CHECK = '23514';

type Body = Record<string, unknown>;
type Line = Body & {
  id: string;
  lineKind: string;
  sourceId: string | null;
  basketLineId: string;
  priceBasis: QuoteLinePriceBasis | null;
  addon: QuoteLineAddonBasis | null;
};
const linesOf = (quote: Body) => quote['lines'] as Line[];

async function refusedBy(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgConstraintName(error);
  }
  throw new Error('expected the database to reject the statement');
}

/**
 * Proposed amendments PA-03 (SPK-PAY-014, capability `price_tiers_addons`, DEC-097 pending) and
 * PA-07 (SPK-REG-012, capability `uniforms`, DEC-101 pending) in the registration quote, the order
 * and their money consequences (migrations 0690 and 0691; ADR-003). Tiers, add-ons, prices and
 * the membership are test data, not policy.
 */
describe('quote lines for tiers, add-ons and uniforms (SPK-PAY-014, SPK-REG-012; migrations 0690, 0691)', () => {
  let t: TestApp;
  let parent: Actor;
  let port: FinancePolicyPort;
  let membershipDefinitionId: string;
  let membershipOffering: OfferingFixture;

  const switches = async (
    on: Partial<Record<'tiers' | 'uniforms' | 'perSession' | 'member', boolean>>,
  ) => {
    await setCapability(t.db, t.organizationId, 'price_tiers_addons', on.tiers ?? false);
    await setCapability(t.db, t.organizationId, 'uniforms', on.uniforms ?? false);
    await setCapability(t.db, t.organizationId, 'per_session_pricing', on.perSession ?? false);
    await setCapability(t.db, t.organizationId, 'member_pricing', on.member ?? false);
  };

  /** A five-day camp; the rule and its tiers are added by each test. */
  async function camp(
    rule: Parameters<typeof createPriceRuleFixture>[1] extends infer R ? Partial<R> : never = {},
  ) {
    const setup = await offering(t, { basePriceMinor: null });
    const priceRuleId = await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: 30_000,
      effectiveFrom: new Date(NOW - 30 * DAY),
      ...rule,
    });
    const sessionIds: string[] = [];
    for (let day = 0; day < 5; day += 1) {
      sessionIds.push(
        await createOfferingSessionFixture(t, {
          offeringId: setup.offeringId,
          scheduledStart: new Date(NOW + (7 + day) * DAY),
          scheduledEnd: new Date(NOW + (7 + day) * DAY + 7 * HOUR),
        }),
      );
    }
    return { setup, priceRuleId, sessionIds };
  }

  const tierOf = (
    priceRuleId: string,
    offeringId: string,
    input: Omit<Parameters<typeof createPriceRuleTierFixture>[1], 'priceRuleId' | 'offeringId'>,
  ) => createPriceRuleTierFixture(t, { priceRuleId, offeringId, ...input });

  /** A basket of `parent` with one line; returns the basket id, its body and the participant. */
  async function basketLine(
    setup: OfferingFixture,
    line: Body = {},
    options: { hold?: boolean; participantPersonId?: string } = {},
  ): Promise<{ basketId: string; body: Body; kid: string }> {
    const kid = options.participantPersonId ?? (await child(t, [parent]));
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: parent.personId,
    });
    const created = await post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const basketId = created.body.id as string;
    const added = await post(t, `/v1/baskets/${basketId}/lines`, parent.header, {
      participantPersonId: kid,
      offeringId: setup.offeringId,
      intent: 'youth',
      ...line,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    let body = added.body as Body;
    if (options.hold ?? true) {
      const held = await post(t, `/v1/baskets/${basketId}/hold`, parent.header, {});
      expect(held.status, JSON.stringify(held.body)).toBe(200);
      body = held.body as Body;
    }
    return { basketId, body, kid };
  }

  const quote = (basketId: string) =>
    post(t, '/v1/registration-quotes', parent.header, { basketId });
  async function quoted(basketId: string): Promise<Body & { id: string }> {
    const res = await quote(basketId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Body & { id: string };
  }
  async function pay(quoteId: string): Promise<void> {
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain(t);
  }
  const enrollmentOf = (body: Body) => (body['lines'] as Body[])[0]?.['enrollmentId'] as string;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    port = t.app.get<FinancePolicyPort>(FINANCE_POLICY_IMPL);
    membershipDefinitionId = await createEntitlementDefinitionFixture(t, {
      name: 'Annual membership',
      kind: 'membership_benefit',
    });
    membershipOffering = await offering(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-014, SPK-PAY-015, SPK-PAY-013: the quote prices a line by its tier, then the member price, then the days still to attend; the basket estimate says the same, and the purchase keeps the basis', async () => {
    await switches({ tiers: true, perSession: true, member: true });
    const { setup, priceRuleId, sessionIds } = await camp({
      basePriceMinor: 7_000,
      pricingBasis: 'per_session',
      memberPriceMinor: 6_500,
      memberEntitlementDefinitionId: membershipDefinitionId,
    });
    const pickDays = await tierOf(priceRuleId, setup.offeringId, {
      code: 'pick_days',
      name: 'Pick your days',
      attendance: 'chosen_sessions',
      minSessions: 1,
      priceMinor: 6_800,
      memberPriceMinor: 6_000,
    });
    const member = await child(t, [parent]);
    const membershipId = await createEnrollmentFixture(t, {
      offeringId: membershipOffering.offeringId,
      participantPersonId: member,
      intent: 'membership',
      entitlementDefinitionId: membershipDefinitionId,
    });
    await t.db
      .updateTable('enrollments')
      .set({
        membership_starts_at: new Date(NOW - 30 * DAY),
        membership_ends_at: new Date(NOW + 300 * DAY),
      })
      .where('id', '=', membershipId)
      .execute();
    const days = [sessionIds[0], sessionIds[2], sessionIds[4]] as string[];
    const { basketId, body } = await basketLine(
      setup,
      { priceTierId: pickDays, selectedSessionIds: days },
      { participantPersonId: member },
    );
    const estimate = (((body['lines'] as Body[])[0]?.['price'] as Body)['estimate'] ?? {}) as Body;

    const q = await quoted(basketId);
    const [line] = linesOf(q);
    // Tier 68.00 (member 60.00) x 3 days = 180.00; not 70.00 x 3, not 68.00 x 3, not 65.00 x 3.
    expect(line).toMatchObject({
      lineKind: 'registration',
      sourceId: null,
      priceRuleId,
      quantity: 1,
      unitPriceMinor: 18_000,
      totalMinor: 18_000,
    });
    expect(line?.priceBasis).toEqual({
      pricingBasis: 'per_session',
      standardPriceMinor: 6_800,
      tier: {
        tierId: pickDays,
        code: 'pick_days',
        name: 'Pick your days',
        attendance: 'chosen_sessions',
        priceMinor: 6_800,
        memberPriceMinor: 6_000,
        availableUntil: null,
        purchasedAt: '2026-11-02T15:00:00.000Z',
        selectedSessionIds: days,
      },
      appliedPrice: 'member',
      appliedPriceMinor: 6_000,
      member: {
        priceMinor: 6_000,
        entitlementDefinitionId: membershipDefinitionId,
        entitlementName: 'Annual membership',
        applied: true,
        reason: 'active_membership',
        membershipEnrollmentId: membershipId,
        checkedAt: '2026-11-02T15:00:00.000Z',
      },
      sessions: { count: 3, sessionIds: days, countedAt: '2026-11-02T15:00:00.000Z' },
      unitPriceMinor: 18_000,
    });
    // The basket showed the same price before the quote, from the same facts.
    expect(estimate).toMatchObject({
      appliedPrice: 'member',
      appliedPriceMinor: 6_000,
      sessionCount: 3,
      unitPriceMinor: line?.['unitPriceMinor'],
    });
    expect(body['subtotalMinor']).toBe(18_000);
    expect(unitPriceFromBasis(line?.priceBasis as QuoteLinePriceBasis)).toBe(18_000);

    await pay(q.id);
    const orderLine = await t.db
      .selectFrom('order_lines')
      .select(['line_kind', 'source_id', 'unit_price_minor', 'price_basis'])
      .where('quote_line_id', '=', line?.id as string)
      .executeTakeFirstOrThrow();
    expect(orderLine).toMatchObject({
      line_kind: 'registration',
      source_id: null,
      unit_price_minor: 18_000,
    });
    expect((orderLine.price_basis as { pricing?: unknown }).pricing).toEqual(line?.priceBasis);
    // The enrollment keeps the tier and the days that were bought.
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['price_tier_id', 'selected_session_ids', 'status'])
      .where('id', '=', enrollmentOf(body))
      .executeTakeFirstOrThrow();
    expect(enrollment).toEqual({
      price_tier_id: pickDays,
      selected_session_ids: days,
      status: 'confirmed',
    });
  });

  it('SPK-PAY-014: add-on lines are priced from the catalog at the quote, charged with their own charge lines, and the basket price estimate counts them', async () => {
    await switches({ tiers: true });
    const { setup, priceRuleId, sessionIds } = await camp();
    const fullWeek = await tierOf(priceRuleId, setup.offeringId, {
      code: 'full_week',
      name: 'Full week',
      priceMinor: 30_000,
    });
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'lunch',
      name: 'Lunch',
      priceMinor: 900,
      selection: 'per_session',
      chargeLines: [
        { code: 'food', label: 'Food tax', kind: 'tax', basisPoints: 1_000, inclusive: false },
      ],
    });
    const shirt = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'shirt',
      name: 'Camp shirt',
      priceMinor: 1_500,
    });
    const days = [sessionIds[1], sessionIds[3]].sort() as string[];
    const { basketId } = await basketLine(setup, {
      priceTierId: fullWeek,
      addons: [{ addonId: lunch, sessionIds: days }, { addonId: shirt }],
    });
    // The estimate before the quote already counts the add-on lines and their tax.
    const estimate = await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header);
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
    expect(estimate.body).toMatchObject({
      basis: 'estimate',
      subtotalMinor: 30_000 + 1_800 + 1_500,
      taxMinor: 180,
      totalMinor: 33_480,
    });

    const q = await quoted(basketId);
    const lines = linesOf(q);
    expect(
      lines.map((l) => [
        l['sequence'],
        l.lineKind,
        l.sourceId,
        l['description'],
        l['priceRuleId'],
        l['unitPriceMinor'],
        l['quantity'],
        l['taxMinor'],
        l['totalMinor'],
      ]),
    ).toEqual([
      [
        1,
        'registration',
        null,
        expect.stringMatching(/: Full week$/),
        priceRuleId,
        30_000,
        1,
        0,
        30_000,
      ],
      [2, 'addon', lunch, 'Lunch', null, 900, 2, 180, 1_980],
      [3, 'addon', shirt, 'Camp shirt', null, 1_500, 1, 0, 1_500],
    ]);
    expect(new Set(lines.map((l) => l.basketLineId)).size).toBe(1);
    expect(new Set(lines.map((l) => l['enrollmentId'])).size).toBe(1);
    expect(lines[1]?.addon).toEqual({
      addonId: lunch,
      code: 'lunch',
      name: 'Lunch',
      selection: 'per_session',
      sessionIds: days,
      quantity: 2,
      unitPriceMinor: 900,
    });
    expect(lines[1]?.priceBasis).toBeNull();
    expect(q['subtotalMinor']).toBe(33_300);
    expect(q['totalMinor']).toBe(33_480);
    // An add-on retired after the quote changes nothing quoted; a new quote refuses it.
    await t.db
      .updateTable('offering_addons')
      .set({ status: 'retired', retired_at: new Date(NOW) })
      .where('id', '=', shirt)
      .execute();
    const reread = await t.http.get(`/v1/registration-quotes/${q.id}`).set(parent.header);
    expect(linesOf(reread.body as Body)[2]?.addon).toEqual(lines[2]?.addon);
    const requote = await quote(basketId);
    expect(requote.status).toBe(409);
    expect(requote.body.details).toMatchObject({ code: 'ADDON_NOT_OFFERED', addonId: shirt });
    expect((await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header)).body.basis).toBe(
      'unpriced',
    );
  });

  it('SPK-PAY-014, SPK-REG-012: a capability turned off after the choice refuses the quote with CAPABILITY_DISABLED; with it off a rule that has tiers prices a plain line at its base price, exactly as before', async () => {
    await switches({ tiers: true, uniforms: true });
    const { setup, priceRuleId, sessionIds } = await camp();
    const fullWeek = await tierOf(priceRuleId, setup.offeringId, {
      code: 'full_week',
      priceMinor: 28_000,
    });
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      priceMinor: 900,
      selection: 'per_session',
    });
    const withTier = await basketLine(setup, {
      priceTierId: fullWeek,
      addons: [{ addonId: lunch, sessionIds: [sessionIds[0]] }],
    });
    const kitOffering = await camp();
    const kit = await createOfferingUniformFixture(t, {
      offeringId: kitOffering.setup.offeringId,
      priceMinor: 2_500,
    });
    const withKit = await basketLine(kitOffering.setup, {
      uniform: { offeringUniformId: kit, size: 'YM' },
    });

    await switches({});
    for (const [basketId, capability] of [
      [withTier.basketId, 'price_tiers_addons'],
      [withKit.basketId, 'uniforms'],
    ] as const) {
      const res = await quote(basketId);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED', capability });
      expect(
        (await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header)).body.basis,
      ).toBe('unpriced');
    }
    // Off: the tiers of the rule are not evaluated. A line without a tier is the plain line of
    // before, at the base price, with no basis and one quote line.
    const plain = await basketLine(setup);
    expect((plain.body['lines'] as Body[])[0]).toMatchObject({ priceTierId: null, addons: [] });
    const q = await quoted(plain.basketId);
    expect(linesOf(q)).toEqual([
      expect.objectContaining({
        lineKind: 'registration',
        sourceId: null,
        addon: null,
        uniform: null,
        priceBasis: null,
        unitPriceMinor: 30_000,
        totalMinor: 30_000,
      }),
    ]);
    // On again: that same plain line now needs a tier, and says so.
    await switches({ tiers: true });
    const needsTier = await quote(plain.basketId);
    expect(needsTier.status).toBe(409);
    expect(needsTier.body.details).toMatchObject({ code: 'TIER_REQUIRED' });
  });

  it('SPK-PAY-014, SPK-REG-012: the database allows one place line and one line per add-on or uniform for a basket line in a quote, and refuses an extra without its source, its basis or an add-on of its own offering', async () => {
    await switches({ tiers: true, uniforms: true });
    const { setup, sessionIds } = await camp();
    const elsewhere = await camp();
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      priceMinor: 900,
      selection: 'per_session',
    });
    const foreignAddon = await createOfferingAddonFixture(t, {
      offeringId: elsewhere.setup.offeringId,
      priceMinor: 900,
    });
    const kit = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      priceMinor: 2_500,
    });
    const { basketId } = await basketLine(setup, {
      addons: [{ addonId: lunch, sessionIds: [sessionIds[0]] }],
      uniform: { offeringUniformId: kit, size: 'YM' },
    });
    const q = await quoted(basketId);
    expect(linesOf(q).map((l) => l.lineKind)).toEqual(['registration', 'addon', 'uniform']);
    const rows = await t.db
      .selectFrom('quote_lines')
      .selectAll()
      .where('quote_id', '=', q.id)
      .orderBy('sequence')
      .execute();
    const [placeRow, addonRow, uniformRow] = rows;
    const copy = (row: (typeof rows)[number] | undefined, overrides: Record<string, unknown>) =>
      t.db
        .insertInto('quote_lines')
        .values({
          ...(row as (typeof rows)[number]),
          id: newId(),
          sequence: 50 + Math.floor(Math.random() * 10_000),
          discount_lines: json((row as (typeof rows)[number]).discount_lines),
          charge_lines: json((row as (typeof rows)[number]).charge_lines),
          policy_references: json((row as (typeof rows)[number]).policy_references),
          price_basis: row?.price_basis ? json(row.price_basis) : null,
          ...overrides,
        } as never)
        .execute();
    // The place, the same add-on and the uniform cannot be charged twice in one quote.
    expect(await refusedBy(copy(placeRow, {}))).toBe('quote_lines_one_registration_idx');
    expect(await refusedBy(copy(addonRow, {}))).toBe('quote_lines_one_per_source_idx');
    expect(await refusedBy(copy(uniformRow, {}))).toBe('quote_lines_one_per_source_idx');
    // The place names no source; an extra names one and stores its basis.
    expect(await refusedBy(copy(placeRow, { source_id: lunch, sequence: 91 }))).toBe(
      'quote_lines_source_shape',
    );
    expect(await refusedBy(copy(addonRow, { source_id: null }))).toBe('quote_lines_source_guard');
    expect(await refusedBy(copy(addonRow, { price_basis: null }))).toBe('quote_lines_extra_basis');
    expect(await rejectsWith(copy(addonRow, { line_kind: 'gift' }))).toBe(CHECK);
    // The source is an add-on (or a uniform) of the line's own offering and organization.
    expect(await refusedBy(copy(addonRow, { source_id: foreignAddon }))).toBe(
      'quote_lines_source_guard',
    );
    expect(await refusedBy(copy(addonRow, { source_id: kit }))).toBe('quote_lines_source_guard');
    expect(await refusedBy(copy(uniformRow, { source_id: lunch }))).toBe(
      'quote_lines_source_guard',
    );
    expect(await refusedBy(copy(addonRow, { source_id: newId() }))).toBe(
      'quote_lines_source_guard',
    );
    const other = await seedOrganization(t.db);
    expect(
      await rejectsWith(copy(addonRow, { organization_id: other.organizationId })),
    ).toBeDefined();
    // A stored basis always states the unit price of its line (0687 applies to extras too).
    expect(
      await refusedBy(
        copy(addonRow, {
          source_id: lunch,
          unit_price_minor: 901,
          base_amount_minor: 901,
          total_minor: 901,
          quote_id: (await quoted((await basketLine(setup, {})).basketId)).id,
        }),
      ),
    ).toBeDefined();
    // Quote lines stay append-only.
    expect(
      await rejectsWith(
        t.db
          .updateTable('quote_lines')
          .set({ line_kind: 'registration' })
          .where('id', '=', addonRow?.id as string)
          .execute(),
      ),
    ).toBe('23001');

    // The order follows: its lines carry the kind and source of the quote lines they purchase.
    await pay(q.id);
    const orderLines = await t.db
      .selectFrom('order_lines')
      .selectAll()
      .where(
        'quote_line_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('sequence')
      .execute();
    expect(orderLines.map((l) => [l.line_kind, l.source_id, l.enrollment_id])).toEqual([
      ['registration', null, orderLines[0]?.enrollment_id],
      ['addon', lunch, orderLines[0]?.enrollment_id],
      ['uniform', kit, orderLines[0]?.enrollment_id],
    ]);
    expect((orderLines[1]?.price_basis as Body)['addon']).toEqual(addonRow?.price_basis);
    expect((orderLines[2]?.price_basis as Body)['uniform']).toEqual(uniformRow?.price_basis);
    const relabel = (overrides: Record<string, unknown>) =>
      t.db
        .insertInto('order_lines')
        .values({
          ...(orderLines[1] as (typeof orderLines)[number]),
          id: newId(),
          sequence: 77,
          price_basis: json((orderLines[1] as (typeof orderLines)[number]).price_basis),
          policy_references: json((orderLines[1] as (typeof orderLines)[number]).policy_references),
          ...overrides,
        } as never)
        .execute();
    expect(await refusedBy(relabel({ line_kind: 'uniform', source_id: kit }))).toBe(
      'order_lines_follow_quote_line',
    );
    expect(await refusedBy(relabel({ line_kind: 'registration', source_id: null }))).toBe(
      'order_lines_follow_quote_line',
    );
    expect(await rejectsWith(relabel({}))).toBe(UNIQUE);
  });

  it('SPK-PAY-014, SPK-REG-012: a cancellation follows the lines bought: the policy share applies to the place and its add-ons together, the uniform is named and reviewed, and a transfer of a place with extras goes to finance review', async () => {
    await switches({ tiers: true, uniforms: true });
    const halfBack = await createPolicyVersionFixture(t, {
      kind: 'cancellation',
      content: { refundBasisPoints: 5_000 },
    });
    const at = new Date(NOW);
    const { setup, priceRuleId, sessionIds } = await camp();
    const threeDay = await tierOf(priceRuleId, setup.offeringId, {
      code: 'three_day',
      attendance: 'chosen_sessions',
      minSessions: 3,
      maxSessions: 3,
      priceMinor: 19_000,
    });
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      priceMinor: 900,
      selection: 'per_session',
    });
    const kit = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      priceMinor: 2_500,
    });
    const days = sessionIds.slice(0, 3);
    const bought = await basketLine(setup, {
      priceTierId: threeDay,
      selectedSessionIds: days,
      addons: [{ addonId: lunch, sessionIds: days.slice(0, 2) }],
      uniform: { offeringUniformId: kit, size: 'YM' },
    });
    await pay((await quoted(bought.basketId)).id);
    const enrollmentId = enrollmentOf(bought.body);
    // Enrollment passes the estimate of the place; finance uses what its order lines charged:
    // (190.00 place + 2 x 9.00 lunch) x 50% = 104.00. The 25.00 uniform is not in that amount.
    const consequence = await port.cancellationConsequence(t.organizationId, {
      enrollmentId,
      participantPersonId: bought.kid,
      offeringId: setup.offeringId,
      cancellationPolicyVersionId: halfBack,
      price: { amountMinor: 30_000, currency: 'USD' },
      at,
    });
    expect(consequence).toMatchObject({ kind: 'refund', amountMinor: 10_400, currency: 'USD' });
    expect(consequence.explanation).toBe(
      'The cancellation policy grants a refund of 50% of the price, the add-ons included. The uniform is not part of this amount; finance reviews it.',
    );
    // A transfer of a place bought with add-ons or a uniform is reviewed, never a difference of
    // base prices.
    const plainTarget = await offering(t, { basePriceMinor: 20_000 });
    expect(
      await port.transferConsequence(t.organizationId, {
        enrollmentId,
        participantPersonId: bought.kid,
        fromOfferingId: setup.offeringId,
        toOfferingId: plainTarget.offeringId,
        fromPrice: { amountMinor: 30_000, currency: 'USD' },
        toPrice: { amountMinor: 20_000, currency: 'USD' },
        at,
      }),
    ).toMatchObject({ kind: 'review_required', amountMinor: null });
    // Into an offering sold by tier: reviewed too (its place costs its tier, not the base price).
    const plain = await basketLine(plainTarget);
    await pay((await quoted(plain.basketId)).id);
    expect(
      await port.transferConsequence(t.organizationId, {
        enrollmentId: enrollmentOf(plain.body),
        participantPersonId: plain.kid,
        fromOfferingId: plainTarget.offeringId,
        toOfferingId: setup.offeringId,
        fromPrice: { amountMinor: 20_000, currency: 'USD' },
        toPrice: { amountMinor: 30_000, currency: 'USD' },
        at,
      }),
    ).toMatchObject({ kind: 'review_required' });
    // A plain place still cancels on the price enrollment passes, as before.
    expect(
      await port.cancellationConsequence(t.organizationId, {
        enrollmentId: enrollmentOf(plain.body),
        participantPersonId: plain.kid,
        offeringId: plainTarget.offeringId,
        cancellationPolicyVersionId: halfBack,
        price: { amountMinor: 20_000, currency: 'USD' },
        at,
      }),
    ).toMatchObject({
      kind: 'refund',
      amountMinor: 10_000,
      explanation: 'The cancellation policy grants a refund of 50% of the price.',
    });

    // A free place whose uniform was charged: nothing to work out by share; finance reviews it.
    const free = await camp({ basePriceMinor: 0 });
    const freeKit = await createOfferingUniformFixture(t, {
      offeringId: free.setup.offeringId,
      priceMinor: 2_500,
    });
    await switches({ uniforms: true });
    const kitOnly = await basketLine(free.setup, {
      uniform: { offeringUniformId: freeKit, size: 'YS' },
    });
    await pay((await quoted(kitOnly.basketId)).id);
    expect(
      await port.cancellationConsequence(t.organizationId, {
        enrollmentId: enrollmentOf(kitOnly.body),
        participantPersonId: kitOnly.kid,
        offeringId: free.setup.offeringId,
        cancellationPolicyVersionId: halfBack,
        price: { amountMinor: 0, currency: 'USD' },
        at,
      }),
    ).toMatchObject({ kind: 'review_required', amountMinor: null });
  });
});
