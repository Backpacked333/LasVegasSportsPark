import { newId } from '@sportspark/contracts';
import { json, pgConstraintName, pgErrorCode, seedOrganization, type Db } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, setCapability, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { PRICING_PORT, type PricingPort } from '../catalog.ports';
import {
  createEntitlementDefinitionFixture,
  createOfferingAddonFixture,
  createOfferingFixture,
  createOfferingUniformFixture,
  createPriceRuleFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const CHECK = '23514';
const RESTRICT = '23001';
const ACTOR = json({ kind: 'system', actorLabel: 'test' });

type Header = { Authorization: string };
type Body = Record<string, unknown>;

async function rejectsWith(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgErrorCode(error);
  }
  throw new Error('expected the database to reject the statement');
}
async function refusedBy(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgConstraintName(error);
  }
  throw new Error('expected the database to reject the statement');
}

/**
 * Proposed amendments PA-03 (SPK-PAY-014: price tiers and add-ons, capability
 * `price_tiers_addons`, DEC-097 pending) and PA-07 (SPK-REG-012: uniforms, capability `uniforms`,
 * DEC-101 pending) in the catalog (migrations 0215 to 0217). Tiers, add-ons, sizes and prices are
 * test data, not policy.
 */
describe('price tiers, add-ons and uniforms of an offering (SPK-PAY-014, SPK-REG-012)', () => {
  let t: TestApp;
  let db: Db;
  let managerPersonId: string;
  let finance: Header;
  let programManager: Header;
  let customer: Header;
  let pricing: PricingPort;

  const offeringOf = async (
    publicationState: 'draft' | 'registration_open' = 'registration_open',
  ) =>
    (
      await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        publicationState,
        basePriceMinor: null,
      })
    ).offeringId;
  const post = (path: string, header: Header, body: Body = {}) =>
    t.http.post(path).set(header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, header: Header) => t.http.get(path).set(header);
  const rule = (offeringId: string, body: Body, header: Header = finance) =>
    post(`/v1/offerings/${offeringId}/price-rules`, header, {
      effectiveFrom: '2026-11-02T15:00:00Z',
      currency: 'USD',
      basePriceMinor: 30_000,
      ...body,
    });
  const TIERS = [
    { code: 'full_week', name: 'Full week', attendance: 'all_sessions', priceMinor: 30_000 },
    {
      code: 'single_day',
      name: 'Single day',
      attendance: 'chosen_sessions',
      minSessions: 1,
      maxSessions: 1,
      priceMinor: 7_000,
    },
  ];
  const LUNCH = {
    code: 'lunch',
    name: 'Lunch',
    priceMinor: 900,
    currency: 'USD',
    selection: 'per_session',
  };
  const KIT = {
    itemKey: 'club-kit-2026',
    name: 'Club kit',
    sizes: ['YS', 'YM', 'YL'],
    requirement: 'required',
    priceMinor: 2_500,
    currency: 'USD',
  };
  const switches = async (tiers: boolean, uniforms: boolean) => {
    await setCapability(db, t.organizationId, 'price_tiers_addons', tiers);
    await setCapability(db, t.organizationId, 'uniforms', uniforms);
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
    db = t.db;
    managerPersonId = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    programManager = await authHeaderForPerson(t, managerPersonId);
    const fin = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    finance = await authHeaderForPerson(t, fin.personId);
    const people = await createOrganizationPeople(t);
    customer = await authHeaderForPerson(t, people.adult.personId);
    pricing = t.app.get<PricingPort>(PRICING_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-014, SPK-REG-012 with the capabilities off: tiers, add-ons and uniforms are refused on write, nothing is shown to a customer, and a plain rule is written as before', async () => {
    await switches(false, false);
    const offeringId = await offeringOf();
    for (const [res, capability] of [
      [await rule(offeringId, { tiers: TIERS }), 'price_tiers_addons'],
      [await post(`/v1/offerings/${offeringId}/addons`, finance, LUNCH), 'price_tiers_addons'],
      [await post(`/v1/offerings/${offeringId}/uniforms`, finance, KIT), 'uniforms'],
    ] as const) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
      expect(res.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED', capability });
    }
    for (const table of ['price_rules', 'offering_addons', 'offering_uniforms'] as const) {
      expect(
        await db.selectFrom(table).select('id').where('offering_id', '=', offeringId).execute(),
      ).toEqual([]);
    }
    // A rule without tiers is written and read exactly as before, with an empty tier list.
    const plain = await rule(offeringId, {});
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body).toMatchObject({ basePriceMinor: 30_000, pricingBasis: 'term', tiers: [] });
    // Records that exist stay readable to staff; a customer is shown nothing of the features.
    const addonId = await createOfferingAddonFixture(t, { offeringId, priceMinor: 900 });
    await createOfferingUniformFixture(t, { offeringId, priceMinor: 2_500 });
    const listed = await get(`/v1/offerings/${offeringId}/addons`, finance);
    expect(listed.status).toBe(200);
    expect((listed.body as Body[]).map((a) => a['id'])).toEqual([addonId]);
    const options = await get(`/v1/offerings/${offeringId}/purchase-options`, customer);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body).toMatchObject({ offeringId, tiers: [], addons: [], uniform: null });
    // Retiring is a command of the capability too.
    const retire = await post(`/v1/offering-addons/${addonId}/retire`, finance);
    expect(retire.status).toBe(403);
  });

  it('SPK-PAY-014: a price rule carries its tiers; they are written with the rule, listed in order and shown to customers while the capability is on', async () => {
    await switches(true, false);
    const offeringId = await offeringOf();
    const created = await rule(offeringId, {
      tiers: [
        ...TIERS,
        {
          code: 'early_week',
          name: 'Early full week',
          attendance: 'all_sessions',
          priceMinor: 26_000,
          availableUntil: '2026-11-10T00:00:00Z',
        },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tiers = created.body.tiers as Body[];
    expect(tiers).toEqual([
      {
        id: expect.any(String),
        code: 'full_week',
        name: 'Full week',
        sequence: 1,
        attendance: 'all_sessions',
        minSessions: null,
        maxSessions: null,
        priceMinor: 30_000,
        memberPriceMinor: null,
        availableUntil: null,
      },
      expect.objectContaining({
        code: 'single_day',
        sequence: 2,
        attendance: 'chosen_sessions',
        minSessions: 1,
        maxSessions: 1,
        priceMinor: 7_000,
      }),
      expect.objectContaining({
        code: 'early_week',
        sequence: 3,
        availableUntil: '2026-11-10T00:00:00.000Z',
      }),
    ]);
    const listed = await get(`/v1/offerings/${offeringId}/price-rules`, finance);
    expect((listed.body as Body[])[0]?.['tiers']).toEqual(tiers);
    // The port finance and enrollment price through carries the tiers.
    const effective = await pricing.effectivePriceRule(t.organizationId, offeringId, new Date(NOW));
    expect(effective?.tiers.map((x) => x.code)).toEqual(['full_week', 'single_day', 'early_week']);
    // Discovery shows the tiers; the purchase options show the ones that can still be bought.
    const offering = await get(`/v1/offerings/${offeringId}`, customer);
    expect(((offering.body as Body)['price'] as Body)['tiers']).toEqual(tiers);
    t.clock.advance(9 * DAY);
    try {
      const options = await get(`/v1/offerings/${offeringId}/purchase-options`, customer);
      expect(options.body).toMatchObject({ priceRuleId: created.body.id, pricingBasis: 'term' });
      expect((options.body.tiers as Body[]).map((x) => x['code'])).toEqual([
        'full_week',
        'single_day',
      ]);
    } finally {
      t.clock.set(new Date(NOW));
    }
    // Turned off: the tiers are no longer shown to customers; staff still read the rule.
    await switches(false, false);
    const hidden = await get(`/v1/offerings/${offeringId}`, customer);
    expect(((hidden.body as Body)['price'] as Body)['tiers']).toEqual([]);
    const stillListed = await get(`/v1/offerings/${offeringId}/price-rules`, finance);
    expect(((stillListed.body as Body[])[0]?.['tiers'] as Body[]).length).toBe(3);
  });

  it('SPK-PAY-014: tier input is validated: session bounds follow the attendance, codes are unique, a member price needs the entitlement and a deadline is after the rule takes effect', async () => {
    await switches(true, false);
    const offeringId = await offeringOf();
    const tier = (overrides: Body) => ({
      code: 'tier_a',
      name: 'Tier',
      attendance: 'all_sessions',
      priceMinor: 100,
      ...overrides,
    });
    for (const tiers of [
      [tier({ attendance: 'chosen_sessions' })],
      [tier({ minSessions: 2 })],
      [tier({ attendance: 'chosen_sessions', minSessions: 3, maxSessions: 2 })],
      [tier({}), tier({})],
      [tier({ memberPriceMinor: 80 })],
      [tier({ code: 'Not Valid' })],
      [tier({ availableUntil: '2026-11-01T00:00:00Z' })],
    ]) {
      const res = await rule(offeringId, { tiers });
      expect(res.status, JSON.stringify(tiers)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(
      await db
        .selectFrom('price_rules')
        .select('id')
        .where('offering_id', '=', offeringId)
        .execute(),
    ).toEqual([]);
    // Prices belong to finance: a program manager may not write a rule or its tiers.
    expect((await rule(offeringId, { tiers: TIERS }, programManager)).status).toBe(403);
    // With the rule's membership entitlement, a tier may carry a member price.
    await setCapability(db, t.organizationId, 'member_pricing', true);
    try {
      const membershipDefinitionId = await createEntitlementDefinitionFixture(t, {
        name: 'Annual membership',
        kind: 'membership_benefit',
      });
      const withMember = await rule(offeringId, {
        memberPriceMinor: 27_000,
        memberEntitlementDefinitionId: membershipDefinitionId,
        tiers: [tier({ priceMinor: 30_000, memberPriceMinor: 27_000 })],
      });
      expect(withMember.status, JSON.stringify(withMember.body)).toBe(201);
      expect((withMember.body.tiers as Body[])[0]).toMatchObject({ memberPriceMinor: 27_000 });
    } finally {
      await setCapability(db, t.organizationId, 'member_pricing', false);
    }
  });

  it('SPK-PAY-014: add-ons are created and retired by finance, priced in the offering currency, listed with retired ones for staff and offered to customers while active', async () => {
    await switches(true, false);
    const offeringId = await offeringOf();
    await createPriceRuleFixture(t, {
      offeringId,
      basePriceMinor: 30_000,
      effectiveFrom: new Date(NOW - DAY),
    });
    const lunch = await post(`/v1/offerings/${offeringId}/addons`, finance, LUNCH);
    expect(lunch.status, JSON.stringify(lunch.body)).toBe(201);
    expect(lunch.body).toMatchObject({
      offeringId,
      code: 'lunch',
      name: 'Lunch',
      description: null,
      priceMinor: 900,
      currency: 'USD',
      chargeLines: [],
      selection: 'per_session',
      capacity: null,
      status: 'active',
      revision: 1,
    });
    const care = await post(`/v1/offerings/${offeringId}/addons`, finance, {
      code: 'early_care',
      name: 'Early care',
      priceMinor: 1_200,
      currency: 'USD',
      capacity: 12,
      chargeLines: [{ code: 'tax', label: 'Sales tax', kind: 'tax', basisPoints: 800 }],
    });
    expect(care.status, JSON.stringify(care.body)).toBe(201);
    expect(care.body).toMatchObject({ selection: 'per_registration', capacity: 12 });
    // Refusals: the same live code, another currency, a role without price authority.
    const again = await post(`/v1/offerings/${offeringId}/addons`, finance, LUNCH);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'ADDON_CODE_TAKEN' });
    expect(
      (
        await post(`/v1/offerings/${offeringId}/addons`, finance, {
          ...LUNCH,
          code: 'eur',
          currency: 'EUR',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`/v1/offerings/${offeringId}/addons`, programManager, { ...LUNCH, code: 'pm' }))
        .status,
    ).toBe(403);
    expect(
      (await post(`/v1/offerings/${offeringId}/addons`, customer, { ...LUNCH, code: 'cu' })).status,
    ).toBe(403);
    expect((await post(`/v1/offerings/${newId()}/addons`, finance, LUNCH)).status).toBe(404);

    // The command is audited and announced.
    const audit = await db
      .selectFrom('audit_records')
      .select(['action', 'target_type', 'details'])
      .where('target_id', '=', lunch.body.id as string)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'catalog.manage_offering_addons',
        target_type: 'offering_addon',
        details: expect.objectContaining({ offeringId, code: 'lunch', priceMinor: 900 }),
      }),
    ]);
    const events = await db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', offeringId)
      .where('event_type', '=', 'catalog.offering_addon_changed')
      .execute();
    expect(events.map((e) => (e.payload as Body)['status'])).toEqual(['active', 'active']);

    const retired = await post(`/v1/offering-addons/${lunch.body.id as string}/retire`, finance, {
      expectedRevision: 1,
      reason: 'Kitchen closed for the season',
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ status: 'retired', revision: 2 });
    // A stale revision is refused; retiring twice is a replay of the same state.
    const stale = await post(`/v1/offering-addons/${care.body.id as string}/retire`, finance, {
      expectedRevision: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    // The code is free again for a new add-on (a price change is a retirement and a new add-on).
    const dearer = await post(`/v1/offerings/${offeringId}/addons`, finance, {
      ...LUNCH,
      priceMinor: 1_000,
    });
    expect(dearer.status, JSON.stringify(dearer.body)).toBe(201);

    const staffList = await get(`/v1/offerings/${offeringId}/addons`, finance);
    expect(
      (staffList.body as Body[]).map((a) => [a['code'], a['status'], a['priceMinor']]),
    ).toEqual([
      ['lunch', 'retired', 900],
      ['early_care', 'active', 1_200],
      ['lunch', 'active', 1_000],
    ]);
    expect((await get(`/v1/offerings/${offeringId}/addons`, customer)).status).toBe(403);
    const options = await get(`/v1/offerings/${offeringId}/purchase-options`, customer);
    expect((options.body.addons as Body[]).map((a) => [a['code'], a['priceMinor']])).toEqual([
      ['early_care', 1_200],
      ['lunch', 1_000],
    ]);
    // The port returns every add-on, retired ones included, for purchases that still name them.
    const extras = await pricing.offeringExtras(t.organizationId, offeringId);
    expect(extras.addons).toHaveLength(3);
    expect(await pricing.offeringExtras(newId(), offeringId)).toEqual({ addons: [], uniforms: [] });
  });

  it('SPK-REG-012: an offering requires or offers a uniform with sizes and an optional price; one is live at a time and a retired one stays for the orders that name it', async () => {
    await switches(false, true);
    const offeringId = await offeringOf();
    const created = await post(`/v1/offerings/${offeringId}/uniforms`, finance, {
      ...KIT,
      returningHolderFree: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      offeringId,
      itemKey: 'club-kit-2026',
      name: 'Club kit',
      sizes: ['YS', 'YM', 'YL'],
      requirement: 'required',
      priceMinor: 2_500,
      currency: 'USD',
      returningHolderFree: true,
      status: 'active',
    });
    // Input rules: a price and its currency together, sizes listed once, at least one size.
    for (const body of [
      { ...KIT, currency: undefined },
      { ...KIT, sizes: ['YS', 'YS'] },
      { ...KIT, sizes: [] },
      { ...KIT, itemKey: 'Has Spaces' },
    ]) {
      expect(
        (await post(`/v1/offerings/${await offeringOf()}/uniforms`, finance, body)).status,
      ).toBe(400);
    }
    // One live uniform per offering.
    const second = await post(`/v1/offerings/${offeringId}/uniforms`, finance, KIT);
    expect(second.status).toBe(409);
    expect(second.body.details).toMatchObject({ code: 'UNIFORM_ALREADY_SET' });
    expect((await post(`/v1/offerings/${offeringId}/uniforms`, programManager, KIT)).status).toBe(
      403,
    );
    // A uniform that is not charged: no price, optional.
    const free = await post(`/v1/offerings/${await offeringOf()}/uniforms`, finance, {
      itemKey: 'bib',
      name: 'Training bib',
      sizes: ['One size'],
    });
    expect(free.status, JSON.stringify(free.body)).toBe(201);
    expect(free.body).toMatchObject({ priceMinor: null, currency: null, requirement: 'optional' });

    const options = await get(`/v1/offerings/${offeringId}/purchase-options`, customer);
    expect(options.body.uniform).toMatchObject({ id: created.body.id, sizes: ['YS', 'YM', 'YL'] });
    const retired = await post(
      `/v1/offering-uniforms/${created.body.id as string}/retire`,
      finance,
    );
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ status: 'retired' });
    expect(
      (await get(`/v1/offerings/${offeringId}/purchase-options`, customer)).body.uniform,
    ).toBeNull();
    const next = await post(`/v1/offerings/${offeringId}/uniforms`, finance, {
      ...KIT,
      priceMinor: 2_800,
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const listed = await get(`/v1/offerings/${offeringId}/uniforms`, finance);
    expect((listed.body as Body[]).map((u) => [u['status'], u['priceMinor']])).toEqual([
      ['retired', 2_500],
      ['active', 2_800],
    ]);
    expect((await get(`/v1/offerings/${offeringId}/uniforms`, customer)).status).toBe(403);
  });

  it('§4.10: the purchase options of an offering a customer cannot see read as not found', async () => {
    await switches(true, true);
    const draft = await offeringOf('draft');
    expect((await get(`/v1/offerings/${draft}/purchase-options`, customer)).status).toBe(404);
    expect((await get(`/v1/offerings/${draft}/purchase-options`, finance)).status).toBe(200);
    expect((await get(`/v1/offerings/${newId()}/purchase-options`, finance)).status).toBe(404);
    expect((await t.http.get(`/v1/offerings/${draft}/purchase-options`)).status).toBe(401);
  });

  it('SPK-PAY-014, SPK-PAY-002: the database keeps add-on prices immutable, one live add-on per code, and every add-on inside its organization', async () => {
    const offeringId = await offeringOf();
    const addonId = await createOfferingAddonFixture(t, {
      offeringId,
      code: 'lunch',
      priceMinor: 900,
      capacity: 10,
    });
    const set = (values: Record<string, unknown>) =>
      db
        .updateTable('offering_addons')
        .set(values as never)
        .where('id', '=', addonId)
        .execute();
    for (const values of [
      { price_minor: 1_000 },
      { currency: 'EUR' },
      { selection: 'per_session' },
      { capacity: 11 },
      { charge_lines: json([{ code: 'x' }]) },
    ]) {
      expect(await rejectsWith(set(values))).toBe(RESTRICT);
    }
    expect(
      await rejectsWith(db.deleteFrom('offering_addons').where('id', '=', addonId).execute()),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        createOfferingAddonFixture(t, { offeringId, code: 'lunch', priceMinor: 1 }),
      ),
    ).toBe(UNIQUE);
    // The status and its fact agree; a retired add-on stays retired.
    expect(await rejectsWith(set({ status: 'retired' }))).toBe(CHECK);
    await set({ status: 'retired', retired_at: new Date(NOW) });
    expect(await rejectsWith(set({ status: 'active', retired_at: null }))).toBe(RESTRICT);
    // Another organization cannot hang an add-on on this organization's offering.
    const other = await seedOrganization(db);
    expect(
      await rejectsWith(
        createOfferingAddonFixture(t, {
          offeringId,
          priceMinor: 1,
          organizationId: other.organizationId,
        }),
      ),
    ).toBe(FOREIGN_KEY);
    expect(
      await rejectsWith(
        db
          .insertInto('offering_addons')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            offering_id: offeringId,
            code: 'negative',
            name: 'Negative',
            description: null,
            price_minor: -1,
            currency: 'USD',
            capacity: null,
            created_by: ACTOR,
          })
          .execute(),
      ),
    ).toBe(CHECK);
  });

  it('SPK-REG-012, SPK-PAY-002: the database keeps one live uniform per offering, its basis immutable, a price with its currency, and every uniform inside its organization', async () => {
    const offeringId = await offeringOf();
    const uniformId = await createOfferingUniformFixture(t, { offeringId, priceMinor: 2_500 });
    expect(await refusedBy(createOfferingUniformFixture(t, { offeringId }))).toBe(
      'offering_uniforms_live_idx',
    );
    const set = (values: Record<string, unknown>) =>
      db
        .updateTable('offering_uniforms')
        .set(values as never)
        .where('id', '=', uniformId)
        .execute();
    for (const values of [
      { price_minor: 3_000 },
      { item_key: 'other-kit' },
      { sizes: json(['XL']) },
      { returning_holder_free: true },
    ]) {
      expect(await rejectsWith(set(values))).toBe(RESTRICT);
    }
    expect(
      await rejectsWith(db.deleteFrom('offering_uniforms').where('id', '=', uniformId).execute()),
    ).toBe(RESTRICT);
    const row = (values: Record<string, unknown>) =>
      db
        .insertInto('offering_uniforms')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: offeringId,
          item_key: 'kit',
          name: 'Kit',
          sizes: json(['M']),
          price_minor: null,
          currency: null,
          status: 'retired',
          retired_at: new Date(NOW),
          created_by: ACTOR,
          ...values,
        } as never)
        .execute();
    expect(await refusedBy(row({ price_minor: 100 }))).toBe('offering_uniforms_price_complete');
    expect(await refusedBy(row({ sizes: json([]) }))).toBe('offering_uniforms_sizes_shape');
    expect(await refusedBy(row({ sizes: json({ m: 1 }) }))).toBe('offering_uniforms_sizes_shape');
    const other = await seedOrganization(db);
    expect(await rejectsWith(row({ organization_id: other.organizationId }))).toBe(FOREIGN_KEY);
  });
});
