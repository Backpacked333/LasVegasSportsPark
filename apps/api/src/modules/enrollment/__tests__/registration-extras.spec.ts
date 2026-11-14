import { newId } from '@sportspark/contracts';
import { json, pgConstraintName, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCapability, type TestApp } from '../../../testing';
import {
  createEntitlementDefinitionFixture,
  createOfferingAddonFixture,
  createOfferingSessionFixture,
  createOfferingUniformFixture,
  createPriceRuleFixture,
  createPriceRuleTierFixture,
} from '../../catalog';
import { createPersonFixture } from '../../identity';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  acknowledge,
  adult,
  child,
  enrollmentTestApp,
  offering,
  post,
  rejectsWith,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const RESTRICT = '23001';
const ACTOR = json({ kind: 'system', actorLabel: 'test' });

type Body = Record<string, unknown>;

/** The constraint the database named when it refused the statement. */
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
 * PA-07 (SPK-REG-012, capability `uniforms`, DEC-101 pending) in the enrollment module: what a
 * basket line may choose, the price estimate it carries, the pools it holds, and the integrity
 * rules the database enforces by itself (migrations 0215-0217, 0521-0523). Tiers, add-ons,
 * prices and sizes are test data, not policy.
 */
describe('registration tiers, days, add-ons and uniforms (SPK-PAY-014, SPK-REG-012)', () => {
  let t: TestApp;
  let parent: Actor;

  /** A five-day camp with a tiered rule, two add-ons and a uniform, all still to come. */
  async function camp(
    options: {
      seats?: number;
      earlyCareCapacity?: number | null;
      pricingBasis?: 'term' | 'per_session';
    } = {},
  ) {
    const setup = await offering(t, {
      kind: 'camp',
      basePriceMinor: null,
      capacityUnits: [{ unit: 'seats', limit: options.seats ?? 20 }],
    });
    const priceRuleId = await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: options.pricingBasis === 'per_session' ? 7_000 : 30_000,
      pricingBasis: options.pricingBasis ?? 'term',
      effectiveFrom: new Date(NOW - DAY),
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
    const tier = (code: string, input: Parameters<typeof createPriceRuleTierFixture>[1]) =>
      createPriceRuleTierFixture(t, { ...input, code });
    const base = { priceRuleId, offeringId: setup.offeringId };
    const tiers = {
      fullWeek: await tier('full_week', {
        ...base,
        code: '',
        name: 'Full week',
        priceMinor: 30_000,
      }),
      threeDay: await tier('three_day', {
        ...base,
        code: '',
        name: 'Three days',
        attendance: 'chosen_sessions',
        minSessions: 3,
        maxSessions: 3,
        priceMinor: 19_000,
      }),
      singleDay: await tier('single_day', {
        ...base,
        code: '',
        name: 'Single day',
        attendance: 'chosen_sessions',
        minSessions: 1,
        maxSessions: 1,
        priceMinor: 7_000,
      }),
    };
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'lunch',
      name: 'Lunch',
      priceMinor: 900,
      selection: 'per_session',
    });
    const earlyCare = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'early_care',
      name: 'Early care',
      priceMinor: 1_200,
      selection: 'per_session',
      capacity: options.earlyCareCapacity === undefined ? null : options.earlyCareCapacity,
    });
    const shirt = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'shirt',
      name: 'Camp shirt',
      priceMinor: 1_500,
      selection: 'per_registration',
    });
    return { setup, priceRuleId, sessionIds, tiers, lunch, earlyCare, shirt };
  }

  async function basket(owner: Actor = parent): Promise<Body> {
    const created = await post(t, '/v1/baskets', owner.header, { ownerPersonId: owner.personId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as Body;
  }

  async function addLine(
    setup: OfferingSetup,
    line: Body,
    options: { owner?: Actor; basketId?: string } = {},
  ) {
    const owner = options.owner ?? parent;
    let kid = line['participantPersonId'] as string | undefined;
    if (!kid) {
      kid = await child(t, [owner]);
      await acknowledge(t, setup, kid, owner.personId);
    }
    const basketId = options.basketId ?? ((await basket(owner))['id'] as string);
    const res = await post(t, `/v1/baskets/${basketId}/lines`, owner.header, {
      offeringId: setup.offeringId,
      intent: 'youth',
      ...line,
      participantPersonId: kid,
    });
    return { res, basketId, kid };
  }

  /** A line added through the service, for the tests that then write around it. */
  async function lineOf(
    setup: OfferingSetup,
    line: Body,
  ): Promise<{ lineId: string; kid: string }> {
    const { res, kid } = await addLine(setup, line);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { lineId: ((res.body as Body)['lines'] as Body[])[0]?.['id'] as string, kid };
  }

  const selectAddon = (
    lineId: string,
    offeringId: string,
    addonId: string,
    sessionId: string | null,
  ) =>
    t.db
      .insertInto('basket_line_addons')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        basket_line_id: lineId,
        offering_id: offeringId,
        addon_id: addonId,
        session_id: sessionId,
      })
      .execute();

  beforeAll(async () => {
    t = await enrollmentTestApp();
    await setCapability(t.db, t.organizationId, 'price_tiers_addons', true);
    await setCapability(t.db, t.organizationId, 'uniforms', true);
    parent = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  // ---------------------------------------------------------------------------------------------
  // What a line may choose
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014: exactly one tier applies to a line: a tiered offering needs a tier, the days chosen must meet its bounds, and each day must be a session that can still be attended', async () => {
    const { setup, sessionIds, tiers } = await camp();
    const [mon, tue, wed] = sessionIds as [string, string, string];
    const refused = async (line: Body, code: string, status = 400) => {
      const { res } = await addLine(setup, line);
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.details).toMatchObject({ code });
    };
    await refused({}, 'TIER_REQUIRED');
    await refused({ priceTierId: newId() }, 'TIER_NOT_OFFERED');
    await refused(
      { priceTierId: tiers.threeDay, selectedSessionIds: [mon, tue] },
      'TIER_SESSION_COUNT',
    );
    await refused({ priceTierId: tiers.singleDay }, 'TIER_SESSION_COUNT');
    await refused(
      { priceTierId: tiers.fullWeek, selectedSessionIds: [mon] },
      'TIER_ATTENDS_ALL_SESSIONS',
    );
    await refused(
      { priceTierId: tiers.singleDay, selectedSessionIds: [newId()] },
      'SESSION_NOT_SELECTABLE',
    );
    // A session of another offering is not a day of this one.
    const other = await camp();
    await refused(
      { priceTierId: tiers.singleDay, selectedSessionIds: [other.sessionIds[0]] },
      'SESSION_NOT_SELECTABLE',
    );
    // A canceled day cannot be chosen.
    await t.db
      .updateTable('offering_sessions')
      .set({ status: 'canceled', canceled_at: new Date(NOW), cancel_reason: 'heat' })
      .where('id', '=', wed)
      .execute();
    await refused(
      { priceTierId: tiers.singleDay, selectedSessionIds: [wed] },
      'SESSION_NOT_SELECTABLE',
    );

    const { res } = await addLine(setup, {
      priceTierId: tiers.threeDay,
      selectedSessionIds: [sessionIds[4], mon, tue],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [line] = (res.body as Body)['lines'] as Body[];
    expect(line).toMatchObject({
      priceTierId: tiers.threeDay,
      selectedSessionIds: [mon, tue, sessionIds[4]],
    });
    expect((line?.['price'] as Body)['estimate']).toMatchObject({
      pricingBasis: 'term',
      tier: { code: 'three_day', name: 'Three days' },
      appliedPrice: 'standard',
      appliedPriceMinor: 19_000,
      sessionCount: null,
      unitPriceMinor: 19_000,
    });
    expect((res.body as Body)['subtotalMinor']).toBe(19_000);
  });

  it('SPK-PAY-014: a tier with a purchase deadline applies only until the deadline (the date of purchase against a deadline)', async () => {
    const { setup, priceRuleId } = await camp();
    const early = await createPriceRuleTierFixture(t, {
      priceRuleId,
      offeringId: setup.offeringId,
      code: 'early_week',
      name: 'Early full week',
      priceMinor: 26_000,
      availableUntil: new Date(NOW + 2 * DAY),
    });
    const before = await addLine(setup, { priceTierId: early });
    expect(before.res.status, JSON.stringify(before.res.body)).toBe(201);
    expect(
      ((((before.res.body as Body)['lines'] as Body[])[0]?.['price'] as Body)['estimate'] as Body)[
        'unitPriceMinor'
      ],
    ).toBe(26_000);
    t.clock.advance(3 * DAY);
    try {
      const after = await addLine(setup, { priceTierId: early });
      expect(after.res.status).toBe(409);
      expect(after.res.body.details).toMatchObject({
        code: 'TIER_NOT_AVAILABLE',
        priceTierId: early,
      });
      // The line added before the deadline can no longer be held at the early price either.
      const held = await post(t, `/v1/baskets/${before.basketId}/hold`, parent.header, {});
      expect(held.status).toBe(409);
      expect(held.body.details).toMatchObject({ code: 'TIER_NOT_AVAILABLE' });
    } finally {
      t.clock.set(new Date(NOW));
    }
  });

  it('SPK-PAY-014: an add-on is selected per participant and per day, only for days the participant attends, and only while it is offered', async () => {
    const { setup, sessionIds, tiers, lunch, shirt } = await camp();
    const [mon, tue, wed] = sessionIds as [string, string, string];
    const refused = async (line: Body, code: string) => {
      const { res } = await addLine(setup, {
        priceTierId: tiers.singleDay,
        selectedSessionIds: [mon],
        ...line,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.details).toMatchObject({ code });
    };
    await refused(
      { addons: [{ addonId: lunch, sessionIds: [tue] }] },
      'ADDON_SESSION_NOT_SELECTED',
    );
    await refused({ addons: [{ addonId: lunch }] }, 'ADDON_SELECTION_SHAPE');
    await refused({ addons: [{ addonId: shirt, sessionIds: [mon] }] }, 'ADDON_SELECTION_SHAPE');
    await refused({ addons: [{ addonId: newId(), sessionIds: [mon] }] }, 'ADDON_NOT_OFFERED');
    const elsewhere = await camp();
    await refused(
      { addons: [{ addonId: elsewhere.lunch, sessionIds: [mon] }] },
      'ADDON_NOT_OFFERED',
    );

    const { res } = await addLine(setup, {
      priceTierId: tiers.threeDay,
      selectedSessionIds: [mon, tue, wed],
      addons: [{ addonId: lunch, sessionIds: [wed, mon] }, { addonId: shirt }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [line] = (res.body as Body)['lines'] as Body[];
    expect(line?.['addons']).toEqual([
      {
        addonId: lunch,
        code: 'lunch',
        name: 'Lunch',
        selection: 'per_session',
        sessionIds: [mon, wed].sort(),
        priceMinor: 900,
        currency: 'USD',
        quantity: 2,
      },
      {
        addonId: shirt,
        code: 'shirt',
        name: 'Camp shirt',
        selection: 'per_registration',
        sessionIds: [],
        priceMinor: 1_500,
        currency: 'USD',
        quantity: 1,
      },
    ]);
    // Place, two lunches and the shirt.
    expect((res.body as Body)['subtotalMinor']).toBe(19_000 + 1_800 + 1_500);
    // A basket with a priced add-on owes a payment: it never completes without the checkout.
    const held = await post(
      t,
      `/v1/baskets/${(res.body as Body)['id'] as string}/hold`,
      parent.header,
      {},
    );
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const completed = await post(
      t,
      `/v1/baskets/${(res.body as Body)['id'] as string}/complete`,
      parent.header,
      { expectedRevision: (held.body as Body)['revision'] },
    );
    expect(completed.status).toBe(409);
    expect(completed.body.details).toMatchObject({ code: 'PAYMENT_REQUIRED' });
  });

  it('SPK-PAY-013, SPK-PAY-014, SPK-PAY-015: the basket estimate is worked out in the quote order (tier, member price, per-session count) and never shows one session or another tier as the price of the line', async () => {
    await setCapability(t.db, t.organizationId, 'per_session_pricing', true);
    await setCapability(t.db, t.organizationId, 'member_pricing', true);
    try {
      const membershipDefinitionId = await createEntitlementDefinitionFixture(t, {
        name: 'Annual membership',
        kind: 'membership_benefit',
      });
      const membershipOffering = await offering(t);
      const setup = await offering(t, { kind: 'camp', basePriceMinor: null });
      const priceRuleId = await createPriceRuleFixture(t, {
        offeringId: setup.offeringId,
        basePriceMinor: 7_000,
        pricingBasis: 'per_session',
        memberPriceMinor: 6_500,
        memberEntitlementDefinitionId: membershipDefinitionId,
        effectiveFrom: new Date(NOW - DAY),
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
      const pickDays = await createPriceRuleTierFixture(t, {
        priceRuleId,
        offeringId: setup.offeringId,
        code: 'pick_days',
        name: 'Pick your days',
        attendance: 'chosen_sessions',
        minSessions: 1,
        priceMinor: 6_800,
        memberPriceMinor: 6_000,
      });
      const member = await child(t, [parent]);
      await acknowledge(t, setup, member, parent.personId);
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

      const estimateOf = async (line: Body) => {
        const { res } = await addLine(setup, line);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const body = res.body as Body;
        return {
          estimate: ((body['lines'] as Body[])[0]?.['price'] as Body)['estimate'] as Body,
          price: (body['lines'] as Body[])[0]?.['price'] as Body,
          subtotalMinor: body['subtotalMinor'],
        };
      };
      // Tier 68.00 a day, two days chosen, no membership: 68.00 x 2.
      const standard = await estimateOf({
        priceTierId: pickDays,
        selectedSessionIds: [sessionIds[0], sessionIds[3]],
      });
      expect(standard.estimate).toMatchObject({
        pricingBasis: 'per_session',
        tier: { code: 'pick_days' },
        appliedPrice: 'standard',
        appliedPriceMinor: 6_800,
        sessionCount: 2,
        unitPriceMinor: 13_600,
        estimatedAt: '2026-11-02T15:00:00.000Z',
      });
      // The rule's base price stays what it is (one session at the standard price); the estimate
      // is what the line is shown at, and the subtotal follows it.
      expect(standard.price['basePriceMinor']).toBe(7_000);
      expect(standard.subtotalMinor).toBe(13_600);
      // A member: the tier's member price, then the days: 60.00 x 3.
      const memberPrice = await estimateOf({
        participantPersonId: member,
        priceTierId: pickDays,
        selectedSessionIds: sessionIds.slice(0, 3),
      });
      expect(memberPrice.estimate).toMatchObject({
        appliedPrice: 'member',
        appliedPriceMinor: 6_000,
        sessionCount: 3,
        unitPriceMinor: 18_000,
      });
    } finally {
      await setCapability(t.db, t.organizationId, 'per_session_pricing', false);
      await setCapability(t.db, t.organizationId, 'member_pricing', false);
    }
  });

  it('SPK-PAY-014: capacity counts a participant only on the sessions selected, a full-week place and a single day share that day, and add-on capacity is its own pool', async () => {
    const { setup, sessionIds, tiers, lunch, earlyCare } = await camp({
      seats: 2,
      earlyCareCapacity: 1,
    });
    const [mon, tue] = sessionIds as [string, string];
    const holdLine = async (line: Body) => {
      const { res, basketId } = await addLine(setup, line);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return post(t, `/v1/baskets/${basketId}/hold`, parent.header, {});
    };
    const pools = async () =>
      t.db
        .selectFrom('capacity_pools')
        .select(['scope_type', 'scope_id', 'scope_session_id', 'offering_id', 'capacity', 'held'])
        .where('organization_id', '=', t.organizationId)
        .where((eb) =>
          eb.or([
            eb('offering_id', '=', setup.offeringId),
            eb('scope_id', 'in', [lunch, earlyCare]),
          ]),
        )
        .execute();

    expect(
      (
        await holdLine({
          priceTierId: tiers.fullWeek,
          addons: [{ addonId: earlyCare, sessionIds: [mon] }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await holdLine({ priceTierId: tiers.singleDay, selectedSessionIds: [mon] })).status,
    ).toBe(200);
    let rows = await pools();
    const seats = (sessionId: string) =>
      rows.find((p) => p.scope_type === 'session' && p.scope_id === sessionId);
    // Monday has both children, Tuesday only the full-week one; the offering-wide place is taken
    // by the full-week line only.
    expect(seats(mon)).toMatchObject({ capacity: 2, held: 2 });
    expect(seats(tue)).toMatchObject({ capacity: 2, held: 1 });
    expect(rows.find((p) => p.scope_type === 'offering')).toMatchObject({ capacity: 2, held: 1 });
    // The add-on pool names no offering and is limited per session.
    expect(rows.find((p) => p.scope_type === 'addon')).toMatchObject({
      scope_id: earlyCare,
      scope_session_id: mon,
      offering_id: null,
      capacity: 1,
      held: 1,
    });
    // An add-on without a capacity has no pool.
    expect(rows.some((p) => p.scope_id === lunch)).toBe(false);

    // Monday is full for a third child; Tuesday is not.
    const third = await holdLine({ priceTierId: tiers.singleDay, selectedSessionIds: [mon] });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('CAPACITY_UNAVAILABLE');
    expect(
      (await holdLine({ priceTierId: tiers.singleDay, selectedSessionIds: [tue] })).status,
    ).toBe(200);
    // Early care on Monday is taken although Tuesday's seats are not the limit here.
    const noCare = await holdLine({
      priceTierId: tiers.singleDay,
      selectedSessionIds: [sessionIds[2]],
      addons: [{ addonId: earlyCare, sessionIds: [sessionIds[2]] }],
    });
    expect(noCare.status).toBe(200);
    rows = await pools();
    expect(rows.filter((p) => p.scope_type === 'addon')).toHaveLength(2);
  });

  it('SPK-PAY-014: twelve concurrent holds for the last place of an add-on yield exactly one (the add-on pool is never oversold)', async () => {
    const { setup, sessionIds, tiers, earlyCare } = await camp({ seats: 50, earlyCareCapacity: 1 });
    const mon = sessionIds[0] as string;
    const contenders: Array<{ owner: Actor; basketId: string }> = [];
    for (let i = 0; i < 12; i += 1) {
      const owner = await adult(t);
      const { res, basketId } = await addLine(
        setup,
        {
          priceTierId: tiers.singleDay,
          selectedSessionIds: [mon],
          addons: [{ addonId: earlyCare, sessionIds: [mon] }],
        },
        { owner },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      contenders.push({ owner, basketId });
    }
    // Under TEST_DATABASE_URL these overlap; under PGlite they run one after another.
    const results = await Promise.all(
      contenders.map(({ owner, basketId }) =>
        post(t, `/v1/baskets/${basketId}/hold`, owner.header, {}),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'CAPACITY_UNAVAILABLE'),
    ).toBe(true);
    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['id', 'capacity', 'held', 'committed'])
      .where('scope_type', '=', 'addon')
      .where('scope_id', '=', earlyCare)
      .execute();
    expect(pool).toEqual([{ id: expect.any(String), capacity: 1, held: 1, committed: 0 }]);
    // A refused hold left nothing behind: one pending enrollment, and the day's seats count one.
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('offering_id', '=', setup.offeringId)
        .where('status', '=', 'pending')
        .execute(),
    ).toHaveLength(1);
    const day = await t.db
      .selectFrom('capacity_pools')
      .select('held')
      .where('scope_type', '=', 'session')
      .where('scope_id', '=', mon)
      .executeTakeFirstOrThrow();
    expect(day.held).toBe(1);
  });

  it('SPK-PAY-014, SPK-REG-012: with the capabilities off, the tier, day, add-on and uniform fields are refused on write and a line behaves exactly as before', async () => {
    const { setup, sessionIds, tiers, lunch } = await camp();
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'required',
      priceMinor: 2_500,
    });
    await setCapability(t.db, t.organizationId, 'price_tiers_addons', false);
    await setCapability(t.db, t.organizationId, 'uniforms', false);
    try {
      for (const [line, capability] of [
        [{ priceTierId: tiers.fullWeek }, 'price_tiers_addons'],
        [{ selectedSessionIds: [sessionIds[0]] }, 'price_tiers_addons'],
        [{ addons: [{ addonId: lunch, sessionIds: [sessionIds[0]] }] }, 'price_tiers_addons'],
        [{ uniform: { offeringUniformId: uniformId, size: 'YM' } }, 'uniforms'],
      ] as const) {
        const { res } = await addLine(setup, line);
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED', capability });
      }
      // No tier is asked for and no uniform is required: the line is the plain line of before,
      // at the rule's base price, with the offering-wide place only.
      const { res, basketId } = await addLine(setup, {});
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [line] = (res.body as Body)['lines'] as Body[];
      expect(line).toMatchObject({
        priceTierId: null,
        selectedSessionIds: null,
        addons: [],
        uniform: null,
      });
      expect(line?.['price']).toEqual({
        priceRuleId: expect.any(String),
        basePriceMinor: 30_000,
        currency: 'USD',
        chargeLines: [],
      });
      const held = await post(t, `/v1/baskets/${basketId}/hold`, parent.header, {});
      expect(held.status, JSON.stringify(held.body)).toBe(200);
      const pools = await t.db
        .selectFrom('capacity_pools')
        .select(['scope_type', 'held'])
        .where('offering_id', '=', setup.offeringId)
        .execute();
      expect(pools).toEqual([{ scope_type: 'offering', held: 1 }]);
      expect(
        await t.db
          .selectFrom('uniform_orders')
          .select('id')
          .where('offering_id', '=', setup.offeringId)
          .execute(),
      ).toEqual([]);

      // A line that chose a tier while the capability was on is not held once it is off.
      await setCapability(t.db, t.organizationId, 'price_tiers_addons', true);
      const chosen = await addLine(setup, { priceTierId: tiers.fullWeek });
      expect(chosen.res.status).toBe(201);
      await setCapability(t.db, t.organizationId, 'price_tiers_addons', false);
      const refusedHold = await post(t, `/v1/baskets/${chosen.basketId}/hold`, parent.header, {});
      expect(refusedHold.status).toBe(403);
      expect(refusedHold.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'price_tiers_addons',
      });
    } finally {
      await setCapability(t.db, t.organizationId, 'price_tiers_addons', true);
      await setCapability(t.db, t.organizationId, 'uniforms', true);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // What the database refuses by itself
  // ---------------------------------------------------------------------------------------------

  it("SPK-PAY-014: the database refuses a tier of another organization's price rule, a tier of another offering on a line, and a day selection without a tier", async () => {
    const { setup, priceRuleId, sessionIds, tiers } = await camp();
    const other = await seedOrganization(t.db);
    const tierRow = (organizationId: string, offeringId: string) =>
      t.db
        .insertInto('price_rule_tiers')
        .values({
          id: newId(),
          organization_id: organizationId,
          price_rule_id: priceRuleId,
          offering_id: offeringId,
          code: `x_${newId().slice(0, 8)}`,
          name: 'Foreign tier',
          sequence: 99,
          attendance: 'all_sessions',
          min_sessions: null,
          max_sessions: null,
          price_minor: 1,
          member_price_minor: null,
          available_until: null,
        })
        .execute();
    // Another organization cannot attach a tier to this organization's rule.
    expect(await rejectsWith(tierRow(other.organizationId, setup.offeringId))).toBe(FOREIGN_KEY);
    // Nor can a tier name a rule of another offering.
    const elsewhere = await camp();
    expect(await rejectsWith(tierRow(t.organizationId, elsewhere.setup.offeringId))).toBe(
      FOREIGN_KEY,
    );
    // A tier is pricing content: never rewritten, never deleted.
    expect(
      await rejectsWith(
        t.db
          .updateTable('price_rule_tiers')
          .set({ price_minor: 1 })
          .where('id', '=', tiers.fullWeek)
          .execute(),
      ),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        t.db.deleteFrom('price_rule_tiers').where('id', '=', tiers.fullWeek).execute(),
      ),
    ).toBe(RESTRICT);
    // A tier member price needs the rule's membership entitlement.
    expect(
      await refusedBy(
        createPriceRuleTierFixture(t, {
          priceRuleId,
          offeringId: setup.offeringId,
          code: 'members_week',
          priceMinor: 30_000,
          memberPriceMinor: 25_000,
        }),
      ),
    ).toBe('price_rule_tiers_member_price_needs_entitlement');

    // A basket line cannot name a tier of another offering, nor choose days without a tier.
    const { lineId } = await lineOf(setup, { priceTierId: tiers.fullWeek });
    const line = await t.db
      .selectFrom('basket_lines')
      .selectAll()
      .where('id', '=', lineId)
      .executeTakeFirstOrThrow();
    const copy = (overrides: Record<string, unknown>) =>
      t.db
        .insertInto('basket_lines')
        .values({
          ...line,
          id: newId(),
          sequence: line.sequence + 10 + Math.floor(Math.random() * 1_000),
          participant_person_id: line.participant_person_id,
          eligibility_result: json(line.eligibility_result),
          price_snapshot: line.price_snapshot ? json(line.price_snapshot) : null,
          policy_references: json(line.policy_references),
          session_id: null,
          ...overrides,
        } as never)
        .execute();
    const stranger = await createPersonFixture(t, { kind: 'child' });
    expect(
      await rejectsWith(
        copy({ participant_person_id: stranger, price_tier_id: elsewhere.tiers.fullWeek }),
      ),
    ).toBe(FOREIGN_KEY);
    expect(
      await refusedBy(
        copy({
          participant_person_id: stranger,
          price_tier_id: null,
          selected_session_ids: [sessionIds[0] as string],
        }),
      ),
    ).toBe('basket_lines_selection_needs_tier');
    // What a line chose is never changed in place.
    expect(
      await refusedBy(
        t.db
          .updateTable('basket_lines')
          .set({ price_tier_id: tiers.singleDay })
          .where('id', '=', lineId)
          .execute(),
      ),
    ).toBe('basket_lines_selection_immutable');
  });

  it('SPK-PAY-014: the database refuses a selected day that is not a session of the offering, an empty selection and a day listed twice', async () => {
    const { setup, sessionIds, tiers } = await camp();
    const elsewhere = await camp();
    const { kid } = await lineOf(setup, { priceTierId: tiers.fullWeek });
    const enrollment = (selected: string[]) =>
      t.db
        .insertInto('enrollments')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: setup.offeringId,
          participant_person_id: kid,
          intent: 'youth',
          entitlement_definition_id: null,
          equivalence_key: null,
          status: 'pending',
          payer_person_id: null,
          registered_by: ACTOR,
          registered_by_person_id: null,
          assisted_by_person_id: null,
          source_application_id: null,
          basket_id: null,
          basket_line_id: null,
          placement_request_id: null,
          trial_participation_id: null,
          renewed_from_enrollment_id: null,
          order_ref: null,
          last_operation_id: null,
          price_snapshot: null,
          policy_references: json({}),
          eligibility_result: json({}),
          confirmed_at: null,
          canceled_at: null,
          cancellation_reason: null,
          cancellation_policy_version_id: null,
          cancellation_consequence: null,
          transferred_at: null,
          transferred_to_enrollment_id: null,
          transferred_from_enrollment_id: null,
          transfer_consequence: null,
          completed_at: null,
          price_tier_id: tiers.threeDay,
          selected_session_ids: selected,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    expect(await refusedBy(enrollment([elsewhere.sessionIds[0] as string]))).toBe(
      'registration_selection_sessions_of_offering',
    );
    expect(await refusedBy(enrollment([]))).toBe('registration_selection_not_empty');
    expect(await refusedBy(enrollment([sessionIds[0] as string, sessionIds[0] as string]))).toBe(
      'registration_selection_distinct',
    );
    // What was bought is what is attended: the selection of an enrollment never changes.
    const row = await enrollment(sessionIds.slice(0, 3));
    expect(
      await refusedBy(
        t.db
          .updateTable('enrollments')
          .set({ selected_session_ids: sessionIds.slice(1, 4) })
          .where('id', '=', row.id)
          .execute(),
      ),
    ).toBe('enrollments_selection_immutable');
  });

  it("SPK-PAY-014: the database refuses an add-on selected for a session outside the participant's selection, in the wrong shape, twice, or from another offering or organization", async () => {
    const { setup, sessionIds, tiers, lunch, shirt } = await camp();
    const [mon, tue] = sessionIds as [string, string];
    const elsewhere = await camp();
    const { lineId } = await lineOf(setup, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    // Tuesday is not a day this participant attends.
    expect(await refusedBy(selectAddon(lineId, setup.offeringId, lunch, tue))).toBe(
      'basket_line_addons_session_selected',
    );
    // Nor is a session of another offering.
    expect(
      await refusedBy(
        selectAddon(lineId, setup.offeringId, lunch, elsewhere.sessionIds[0] as string),
      ),
    ).toBe('basket_line_addons_session_selected');
    // A per-session add-on names its session; a per-registration one names none.
    expect(await refusedBy(selectAddon(lineId, setup.offeringId, lunch, null))).toBe(
      'basket_line_addons_selection_shape',
    );
    expect(await refusedBy(selectAddon(lineId, setup.offeringId, shirt, mon))).toBe(
      'basket_line_addons_selection_shape',
    );
    // An add-on of another offering, whichever offering the row claims.
    expect(await rejectsWith(selectAddon(lineId, setup.offeringId, elsewhere.lunch, mon))).toBe(
      FOREIGN_KEY,
    );
    expect(
      await refusedBy(selectAddon(lineId, elsewhere.setup.offeringId, elsewhere.lunch, mon)),
    ).toBe('basket_line_addons_offering_of_line');
    // Another organization cannot select this organization's add-on for this line: the row
    // finds no line, add-on or session of its own organization.
    const other = await seedOrganization(t.db);
    expect(
      await refusedBy(
        t.db
          .insertInto('basket_line_addons')
          .values({
            id: newId(),
            organization_id: other.organizationId,
            basket_line_id: lineId,
            offering_id: setup.offeringId,
            addon_id: lunch,
            session_id: mon,
          })
          .execute(),
      ),
    ).toBe('basket_line_addons_offering_of_line');
    // Once per line and session; never rewritten.
    await selectAddon(lineId, setup.offeringId, lunch, mon);
    expect(await rejectsWith(selectAddon(lineId, setup.offeringId, lunch, mon))).toBe(UNIQUE);
    await selectAddon(lineId, setup.offeringId, shirt, null);
    expect(await rejectsWith(selectAddon(lineId, setup.offeringId, shirt, null))).toBe(UNIQUE);
    expect(
      await rejectsWith(
        t.db
          .updateTable('basket_line_addons')
          .set({ session_id: tue })
          .where('basket_line_id', '=', lineId)
          .execute(),
      ),
    ).toBe(RESTRICT);
  });

  it('SPK-PAY-014: the database refuses an add-on pool beyond its capacity, a pool that names no add-on, and a second pool for the same add-on and session', async () => {
    const { setup, sessionIds, earlyCare } = await camp({ earlyCareCapacity: 2 });
    const mon = sessionIds[0] as string;
    const pool = (scopeId: string, sessionId: string | null) =>
      t.db
        .insertInto('capacity_pools')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: null,
          scope_type: 'addon',
          scope_id: scopeId,
          scope_session_id: sessionId,
          unit: 'seats',
          constraint_kind: 'commercial',
          capacity: 2,
          participants_per_staff: null,
          staff_count: null,
          created_by: ACTOR,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    expect(await refusedBy(pool(newId(), mon))).toBe('capacity_pools_addon_scope_guard');
    const created = await pool(earlyCare, mon);
    expect(await rejectsWith(pool(earlyCare, mon))).toBe(UNIQUE);
    // The same add-on on another day is its own pool.
    await pool(earlyCare, sessionIds[1] as string);
    // §4.7 invariant 3 on the add-on pool: held plus committed never exceeds its capacity.
    expect(
      await refusedBy(
        t.db
          .updateTable('capacity_pools')
          .set({ held: 2, committed: 1 })
          .where('id', '=', created.id)
          .execute(),
      ),
    ).toBe('capacity_pools_within_capacity');
    // Only an add-on pool names a session scope.
    expect(
      await refusedBy(
        t.db
          .insertInto('capacity_pools')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            offering_id: setup.offeringId,
            scope_type: 'camp_group',
            scope_id: newId(),
            scope_session_id: mon,
            unit: 'camp_group_places',
            constraint_kind: 'commercial',
            capacity: 2,
            participants_per_staff: null,
            staff_count: null,
            created_by: ACTOR,
          })
          .execute(),
      ),
    ).toBe('capacity_pools_scope_session_addon_only');
  });

  it('SPK-REG-012: the database refuses a second live uniform for the same participant and offering, a size the uniform does not come in, and a uniform of another offering or organization', async () => {
    const { setup, tiers } = await camp();
    const elsewhere = await camp();
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      sizes: ['YS', 'YM'],
      priceMinor: 2_500,
    });
    const foreignUniform = await createOfferingUniformFixture(t, {
      offeringId: elsewhere.setup.offeringId,
    });
    // One live uniform per offering (catalog 0217).
    expect(
      await rejectsWith(createOfferingUniformFixture(t, { offeringId: setup.offeringId })),
    ).toBe(UNIQUE);

    const added = await addLine(setup, {
      priceTierId: tiers.fullWeek,
      uniform: { offeringUniformId: uniformId, size: 'YM' },
    });
    const kid = added.kid;
    expect(added.res.status, JSON.stringify(added.res.body)).toBe(201);
    const lineId = ((added.res.body as Body)['lines'] as Body[])[0]?.['id'] as string;
    const choose = (offeringId: string, offeringUniformId: string, size: string, line = lineId) =>
      t.db
        .insertInto('basket_line_uniforms')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          basket_line_id: line,
          offering_id: offeringId,
          offering_uniform_id: offeringUniformId,
          size,
        })
        .execute();
    // One choice per line.
    expect(await rejectsWith(choose(setup.offeringId, uniformId, 'YS'))).toBe(UNIQUE);
    const second = await lineOf(setup, { priceTierId: tiers.fullWeek });
    expect(await refusedBy(choose(setup.offeringId, uniformId, 'XXL', second.lineId))).toBe(
      'basket_line_uniforms_size_offered',
    );
    expect(await rejectsWith(choose(setup.offeringId, foreignUniform, 'YM', second.lineId))).toBe(
      FOREIGN_KEY,
    );
    expect(
      await refusedBy(choose(elsewhere.setup.offeringId, foreignUniform, 'YM', second.lineId)),
    ).toBe('basket_line_uniforms_offering_of_line');

    // Holding the line orders the uniform; a second live order for the same participant and
    // offering is refused, whichever enrollment it names.
    const held = await post(t, `/v1/baskets/${added.basketId}/hold`, parent.header, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const order = await t.db
      .selectFrom('uniform_orders')
      .selectAll()
      .where('participant_person_id', '=', kid)
      .executeTakeFirstOrThrow();
    expect(order).toMatchObject({
      status: 'ordered',
      size: 'YM',
      price_minor: 2_500,
      currency: 'USD',
    });
    const otherEnrollment = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      status: 'canceled',
    });
    const duplicate = (overrides: Record<string, unknown> = {}) =>
      t.db
        .insertInto('uniform_orders')
        .values({
          ...order,
          id: newId(),
          enrollment_id: otherEnrollment,
          basket_line_id: null,
          handed_over_by: null,
          ...overrides,
        } as never)
        .execute();
    expect(await refusedBy(duplicate())).toBe('uniform_orders_live_idx');
    // Another organization's order cannot name this organization's enrollment or uniform.
    const other = await seedOrganization(t.db);
    expect(await rejectsWith(duplicate({ organization_id: other.organizationId }))).toBe(
      FOREIGN_KEY,
    );
    // A canceled order is not live: a new one may then be placed.
    await t.db
      .updateTable('uniform_orders')
      .set({ status: 'canceled', canceled_at: new Date(NOW), cancel_reason: 'test' })
      .where('id', '=', order.id)
      .execute();
    await duplicate();
  });

  it('SPK-REG-012: the database moves a uniform order only as its machine allows, hands over only with a recorded hand-over, and refuses a hand-over rewritten or deleted', async () => {
    const { setup, tiers } = await camp();
    const uniformId = await createOfferingUniformFixture(t, { offeringId: setup.offeringId });
    const { res, basketId } = await addLine(setup, {
      priceTierId: tiers.fullWeek,
      uniform: { offeringUniformId: uniformId, size: 'YM' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await post(t, `/v1/baskets/${basketId}/hold`, parent.header, {})).status).toBe(200);
    const order = await t.db
      .selectFrom('uniform_orders')
      .select(['id', 'status'])
      .where('offering_id', '=', setup.offeringId)
      .executeTakeFirstOrThrow();
    const move = (set: Record<string, unknown>) =>
      t.db
        .updateTable('uniform_orders')
        .set(set as never)
        .where('id', '=', order.id)
        .execute();
    const handedOver = {
      status: 'handed_over',
      handed_over_at: new Date(NOW),
      handed_over_by: ACTOR,
    };
    // ordered -> handed_over is not a transition of the machine.
    expect(await refusedBy(move({ ...handedOver, paid_at: new Date(NOW) }))).toBe(
      'uniform_orders_machine',
    );
    await move({ status: 'paid', paid_at: new Date(NOW) });
    // Paid, but no hand-over was recorded: the order cannot say it was handed over.
    expect(await refusedBy(move(handedOver))).toBe('uniform_orders_hand_over_recorded');
    // What was ordered never changes.
    expect(await refusedBy(move({ size: 'YL' }))).toBe('uniform_orders_basis_immutable');

    const event = (values: Record<string, unknown>) =>
      t.db
        .insertInto('uniform_handover_events')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          uniform_order_id: order.id,
          kind: 'handed_over',
          corrects_event_id: null,
          reason: null,
          actor: ACTOR,
          actor_person_id: null,
          occurred_at: new Date(NOW),
          ...values,
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
    const handOver = await event({});
    // Each status carries exactly its facts: handed over needs who and when on the order too.
    expect(await refusedBy(move({ status: 'handed_over' }))).toBe(
      'uniform_orders_handed_over_fact',
    );
    await move(handedOver);
    // A hand-over is never rewritten or deleted.
    expect(
      await rejectsWith(
        t.db
          .updateTable('uniform_handover_events')
          .set({ occurred_at: new Date(NOW - DAY) })
          .where('id', '=', handOver.id)
          .execute(),
      ),
    ).toBe(RESTRICT);
    expect(
      await rejectsWith(
        t.db.deleteFrom('uniform_handover_events').where('id', '=', handOver.id).execute(),
      ),
    ).toBe(RESTRICT);
    // Nor is the order: it cannot leave handed over without a correction, and is never deleted.
    expect(
      await refusedBy(move({ status: 'paid', handed_over_at: null, handed_over_by: null })),
    ).toBe('uniform_orders_hand_over_recorded');
    expect(
      await rejectsWith(t.db.deleteFrom('uniform_orders').where('id', '=', order.id).execute()),
    ).toBe(RESTRICT);
    // A correction carries a reason and undoes a hand-over of the same order, once.
    expect(
      await refusedBy(event({ kind: 'correction', corrects_event_id: handOver.id, reason: ' ' })),
    ).toBe('uniform_handover_events_correction_reason');
    expect(await refusedBy(event({ kind: 'correction', reason: 'No hand-over named' }))).toBe(
      'uniform_handover_events_corrects_hand_over',
    );
    expect(await refusedBy(event({ corrects_event_id: handOver.id }))).toBe(
      'uniform_handover_events_correction_shape',
    );
    const correction = await event({
      kind: 'correction',
      corrects_event_id: handOver.id,
      reason: 'Wrong child',
    });
    expect(
      await rejectsWith(
        event({ kind: 'correction', corrects_event_id: handOver.id, reason: 'Again' }),
      ),
    ).toBe(UNIQUE);
    expect(
      await refusedBy(
        event({ kind: 'correction', corrects_event_id: correction.id, reason: 'Of a correction' }),
      ),
    ).toBe('uniform_handover_events_corrects_hand_over');
    await move({ status: 'paid', handed_over_at: null, handed_over_by: null });
    // Another organization's event cannot name this order.
    const other = await seedOrganization(t.db);
    expect(await rejectsWith(event({ organization_id: other.organizationId }))).toBe(FOREIGN_KEY);
  });
});
