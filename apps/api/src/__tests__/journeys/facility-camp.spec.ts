import { describe, expect, it } from 'vitest';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createPolicyVersionFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import { createStaffMemberFixture } from '../../modules/identity';
import type { TestApp } from '../../testing';
import {
  adult,
  child,
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  type Actor,
} from './support';

/**
 * Proposed amendments PA-03 (SPK-PAY-014: camp price tiers and add-ons, capability
 * `price_tiers_addons`, DEC-097 pending) and PA-07 (SPK-REG-012: uniform purchase during
 * registration, capability `uniforms`, DEC-101 pending) on the assembled application. Both are
 * Proposed; with a capability off the application answers exactly as it did before the amendment.
 * Tiers, add-ons, prices, sizes and dates are test data, not policy.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = '2026-06-01T15:00:00Z';
/** Monday of the camp week, 09:00 at the facility. */
const WEEK_START = Date.parse('2026-06-15T16:00:00Z');

type Body = Record<string, unknown>;
type Line = Body & { lineKind: string; sourceId: string | null; basketLineId: string };

let campCounter = 0;

async function camp(
  t: TestApp,
  options: { cancellationContent?: Record<string, unknown>; seats?: number } = {},
): Promise<{ camp: OfferingFixture & { name: string }; sessionIds: string[] }> {
  const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
  const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } });
  const cancellationPolicyVersionId = options.cancellationContent
    ? await createPolicyVersionFixture(t, {
        kind: 'cancellation',
        content: options.cancellationContent,
      })
    : undefined;
  campCounter += 1;
  const name = `Summer camp week ${campCounter}`;
  const fixture = await createOfferingFixture(t, {
    responsibleManagerPersonId: manager.personId,
    programId,
    name,
    kind: 'camp',
    capacityUnits: [{ unit: 'seats', limit: options.seats ?? 20 }],
    basePriceMinor: null,
    cancellationPolicyVersionId,
  });
  const sessionIds: string[] = [];
  for (let day = 0; day < 5; day += 1) {
    sessionIds.push(
      await createOfferingSessionFixture(t, {
        offeringId: fixture.offeringId,
        scheduledStart: new Date(WEEK_START + day * DAY),
        scheduledEnd: new Date(WEEK_START + day * DAY + 7 * HOUR),
      }),
    );
  }
  return { camp: { ...fixture, name }, sessionIds };
}

/** A basket of `parent` with one line per entry, each participant's form acknowledged. */
async function basketWith(
  t: TestApp,
  parent: Actor,
  setup: OfferingFixture,
  lines: Array<{ participantPersonId: string } & Body>,
): Promise<{ basketId: string; body: Body }> {
  const created = await ok<Body>(
    post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId }),
    201,
  );
  let body = created;
  for (const line of lines) {
    await createAcknowledgmentFixture(t, {
      subjectPersonId: line.participantPersonId,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: parent.personId,
    });
    body = await ok<Body>(
      post(t, `/v1/baskets/${created['id'] as string}/lines`, parent.header, {
        offeringId: setup.offeringId,
        intent: 'youth',
        ...line,
      }),
      201,
    );
  }
  return { basketId: created['id'] as string, body };
}

const hold = (t: TestApp, parent: Actor, basketId: string, revision: unknown) =>
  post(t, `/v1/baskets/${basketId}/hold`, parent.header, { expectedRevision: revision });

async function pay(t: TestApp, parent: Actor, quoteId: string): Promise<Body> {
  const checkout = await ok<Body>(
    post(t, '/v1/registration-checkouts', parent.header, {
      quoteId,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    }),
    201,
  );
  expect(checkout['status']).toBe('completed');
  await drain(t);
  return checkout;
}

describe('Facility camp scenarios: price tiers, add-ons and uniforms (assembled application)', () => {
  it('SPK-PAY-014: a camp sold by tier (full week, three days, single day) with lunch and early care per day: each is its own quote line with a reproducible basis, the order and the cancellation follow the lines bought, and each day lists only the children who chose it, with their add-ons', async () => {
    const t = await journeyApp({ clockStart: NOW });
    try {
      const admin = await staff(t, ['system_administrator']);
      const finance = await staff(t, ['finance_operator']);
      const desk = await staff(t, ['front_desk']);
      const parent = await adult(t);
      const ana = await child(t, [parent]);
      const ben = await child(t, [parent]);
      const { camp: week, sessionIds } = await camp(t, {
        cancellationContent: { refundBasisPoints: 5_000 },
      });
      const [mon, tue, wed, , fri] = sessionIds as [string, string, string, string, string];
      const tieredRule = {
        effectiveFrom: NOW,
        basePriceMinor: 30_000,
        currency: 'USD',
        tiers: [
          { code: 'full_week', name: 'Full week', attendance: 'all_sessions', priceMinor: 30_000 },
          {
            code: 'three_day',
            name: 'Three days',
            attendance: 'chosen_sessions',
            minSessions: 3,
            maxSessions: 3,
            priceMinor: 19_000,
          },
          {
            code: 'single_day',
            name: 'Single day',
            attendance: 'chosen_sessions',
            minSessions: 1,
            maxSessions: 1,
            priceMinor: 7_000,
          },
        ],
      };
      const lunchBody = {
        code: 'lunch',
        name: 'Lunch',
        priceMinor: 900,
        currency: 'USD',
        selection: 'per_session',
      };

      // Off for a new organization: tiers and add-ons are refused on write (DEC-016, DEC-097).
      for (const refused of [
        await post(t, `/v1/offerings/${week.offeringId}/price-rules`, finance.header, tieredRule),
        await post(t, `/v1/offerings/${week.offeringId}/addons`, finance.header, lunchBody),
      ]) {
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body.details).toMatchObject({
          code: 'CAPABILITY_DISABLED',
          capability: 'price_tiers_addons',
        });
      }

      await enableCapability(t, admin, 'price_tiers_addons', 'DEC-097');
      const rule = await ok<{ id: string; tiers: Array<{ id: string; code: string }> }>(
        post(t, `/v1/offerings/${week.offeringId}/price-rules`, finance.header, tieredRule),
        201,
      );
      const tier = (code: string) => rule.tiers.find((x) => x.code === code)?.id as string;
      expect(rule.tiers.map((x) => x.code)).toEqual(['full_week', 'three_day', 'single_day']);
      const lunch = await ok<{ id: string }>(
        post(t, `/v1/offerings/${week.offeringId}/addons`, finance.header, lunchBody),
        201,
      );
      const earlyCare = await ok<{ id: string }>(
        post(t, `/v1/offerings/${week.offeringId}/addons`, finance.header, {
          code: 'early_care',
          name: 'Early care',
          priceMinor: 1_200,
          currency: 'USD',
          selection: 'per_session',
          capacity: 1,
        }),
        201,
      );

      // What the customer chooses from.
      const options = await ok<Body>(
        get(t, `/v1/offerings/${week.offeringId}/purchase-options`, parent.header),
      );
      expect((options['tiers'] as Body[]).map((x) => x['name'])).toEqual([
        'Full week',
        'Three days',
        'Single day',
      ]);
      expect((options['addons'] as Body[]).map((x) => x['code'])).toEqual(['lunch', 'early_care']);

      // Exactly one tier applies: a line without one, or with the wrong number of days, is refused.
      const noTier = await post(
        t,
        `/v1/baskets/${(await ok<Body>(post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId }), 201))['id'] as string}/lines`,
        parent.header,
        { participantPersonId: ana, offeringId: week.offeringId, intent: 'youth' },
      );
      expect(noTier.status).toBe(400);
      expect(noTier.body.details).toMatchObject({ code: 'TIER_REQUIRED' });

      const { basketId, body: open } = await basketWith(t, parent, week, [
        {
          participantPersonId: ana,
          priceTierId: tier('full_week'),
          addons: [
            { addonId: lunch.id, sessionIds: [mon, tue] },
            { addonId: earlyCare.id, sessionIds: [mon] },
          ],
        },
        {
          participantPersonId: ben,
          priceTierId: tier('three_day'),
          selectedSessionIds: [fri, mon, wed],
          addons: [{ addonId: lunch.id, sessionIds: [wed] }],
        },
      ]);
      const openLines = open['lines'] as Body[];
      // The line records the tier, the days (in session order) and the add-ons.
      expect(openLines[0]).toMatchObject({
        priceTierId: tier('full_week'),
        selectedSessionIds: null,
        addons: [
          {
            addonId: lunch.id,
            name: 'Lunch',
            sessionIds: [mon, tue].sort(),
            quantity: 2,
            priceMinor: 900,
          },
          { addonId: earlyCare.id, sessionIds: [mon], quantity: 1, priceMinor: 1_200 },
        ],
      });
      expect(openLines[1]).toMatchObject({
        priceTierId: tier('three_day'),
        selectedSessionIds: [mon, wed, fri],
      });
      // The basket estimate uses the tier's price, not the rule's base price.
      expect((openLines[1]?.['price'] as Body)['estimate']).toMatchObject({
        tier: { code: 'three_day', name: 'Three days' },
        unitPriceMinor: 19_000,
      });
      expect(open['subtotalMinor']).toBe(30_000 + 1_800 + 1_200 + 19_000 + 900);

      const held = await ok<Body>(hold(t, parent, basketId, open['revision']));
      const quote = await ok<Body & { id: string }>(
        post(t, '/v1/registration-quotes', parent.header, { basketId }),
        201,
      );
      const lines = quote['lines'] as Line[];
      expect(
        lines.map((l) => [
          l.lineKind,
          l['description'],
          l['unitPriceMinor'],
          l['quantity'],
          l['totalMinor'],
        ]),
      ).toEqual([
        ['registration', `${week.name}: Full week`, 30_000, 1, 30_000],
        ['addon', 'Lunch', 900, 2, 1_800],
        ['addon', 'Early care', 1_200, 1, 1_200],
        ['registration', `${week.name}: Three days`, 19_000, 1, 19_000],
        ['addon', 'Lunch', 900, 1, 900],
      ]);
      expect(quote['totalMinor']).toBe(52_900);
      // The quote names the tier that applied, with the facts that selected it.
      expect(lines[3]?.['priceBasis']).toMatchObject({
        pricingBasis: 'term',
        standardPriceMinor: 19_000,
        tier: {
          tierId: tier('three_day'),
          code: 'three_day',
          attendance: 'chosen_sessions',
          priceMinor: 19_000,
          purchasedAt: '2026-06-01T15:00:00.000Z',
          selectedSessionIds: [mon, wed, fri],
        },
        unitPriceMinor: 19_000,
      });
      // An add-on line belongs to the same basket line as its place and stores its own basis.
      expect(lines[1]).toMatchObject({
        basketLineId: lines[0]?.basketLineId,
        sourceId: lunch.id,
        priceBasis: null,
        addon: {
          addonId: lunch.id,
          code: 'lunch',
          selection: 'per_session',
          sessionIds: [mon, tue].sort(),
          quantity: 2,
          unitPriceMinor: 900,
        },
      });

      await pay(t, parent, quote.id);
      // The order follows the lines bought, each tied to the enrollment of its place.
      const enrollmentOf = (line: Body) => line['enrollmentId'] as string;
      const heldLines = held['lines'] as Body[];
      const order = await ok<Body>(
        get(
          t,
          `/v1/orders/${(await t.db.selectFrom('orders').select('id').where('quote_id', '=', quote.id).executeTakeFirstOrThrow()).id}`,
          parent.header,
        ),
      );
      expect(
        (order['lines'] as Body[]).map((l) => [l['lineKind'], l['enrollmentId'], l['totalMinor']]),
      ).toEqual([
        ['registration', enrollmentOf(heldLines[0] as Body), 30_000],
        ['addon', enrollmentOf(heldLines[0] as Body), 1_800],
        ['addon', enrollmentOf(heldLines[0] as Body), 1_200],
        ['registration', enrollmentOf(heldLines[1] as Body), 19_000],
        ['addon', enrollmentOf(heldLines[1] as Body), 900],
      ]);

      // SPK-PAY-002: retiring the add-on afterwards changes nothing that was quoted.
      await ok(post(t, `/v1/offering-addons/${lunch.id}/retire`, finance.header, {}));
      const reread = await ok<Body>(get(t, `/v1/registration-quotes/${quote.id}`, parent.header));
      expect((reread['lines'] as Line[])[1]?.['addon']).toEqual(lines[1]?.['addon']);

      // Attendance for a day lists only the children whose selection includes it, with their
      // add-ons for that day.
      const expectedOn = async (sessionId: string) =>
        (
          (
            await ok<Body>(
              get(
                t,
                `/v1/attendance?activityType=session&activityId=${sessionId}&offeringId=${week.offeringId}`,
                desk.header,
              ),
            )
          )['expected'] as Array<{ personId: string; addons: Array<{ code: string }> }>
        )
          .map((p) => [p.personId, p.addons.map((a) => a.code)])
          .sort();
      expect(await expectedOn(mon)).toEqual(
        [
          [ana, ['lunch', 'early_care']],
          [ben, []],
        ].sort(),
      );
      expect(await expectedOn(tue)).toEqual([[ana, ['lunch']]]);
      expect(await expectedOn(wed)).toEqual(
        [
          [ana, []],
          [ben, ['lunch']],
        ].sort(),
      );

      // Capacity counts a participant only on the sessions selected: Tuesday holds one seat,
      // Monday two; add-on capacity is its own pool (early care on Monday: one place, taken).
      const pools = await t.db
        .selectFrom('capacity_pools')
        .select(['scope_type', 'scope_id', 'scope_session_id', 'capacity', 'committed'])
        .where('organization_id', '=', t.organizationId)
        .execute();
      const seatsOn = (sessionId: string) =>
        pools.find((p) => p.scope_type === 'session' && p.scope_id === sessionId)?.committed;
      expect([seatsOn(mon), seatsOn(tue), seatsOn(wed)]).toEqual([2, 1, 2]);
      expect(pools.find((p) => p.scope_type === 'offering')?.committed).toBe(1);
      expect(
        pools.find((p) => p.scope_type === 'addon' && p.scope_session_id === mon),
      ).toMatchObject({ scope_id: earlyCare.id, capacity: 1, committed: 1 });

      const other = await adult(t);
      const cal = await child(t, [other]);
      const full = await basketWith(t, other, week, [
        {
          participantPersonId: cal,
          priceTierId: tier('single_day'),
          selectedSessionIds: [mon],
          addons: [{ addonId: earlyCare.id, sessionIds: [mon] }],
        },
      ]);
      const refusedHold = await hold(t, other, full.basketId, full.body['revision']);
      expect(refusedHold.status).toBe(409);
      expect(refusedHold.body.code).toBe('CAPACITY_UNAVAILABLE');

      // A cancellation follows the lines bought: the policy's 50% applies to the place and its
      // add-ons together (30000 + 1800 + 1200), and the add-on place is given back.
      const anaEnrollment = enrollmentOf(heldLines[0] as Body);
      const preview = await ok<Body>(
        get(t, `/v1/enrollments/${anaEnrollment}/cancellation-preview`, parent.header),
      );
      expect(preview['financialConsequence']).toMatchObject({
        kind: 'refund',
        amountMinor: 16_500,
        currency: 'USD',
      });
      const consequence = preview['financialConsequence'] as Body;
      const anaRecord = await ok<Body>(get(t, `/v1/enrollments/${anaEnrollment}`, parent.header));
      await ok(
        post(t, `/v1/enrollments/${anaEnrollment}/cancel`, parent.header, {
          expectedRevision: anaRecord['revision'],
          reason: 'Family plans changed',
          acceptedConsequence: {
            kind: consequence['kind'],
            amountMinor: consequence['amountMinor'],
            currency: consequence['currency'],
          },
        }),
      );
      await drain(t);
      expect(await expectedOn(tue)).toEqual([]);
      const afterCancel = await t.db
        .selectFrom('capacity_pools')
        .select(['committed'])
        .where('scope_type', '=', 'addon')
        .where('scope_session_id', '=', mon)
        .executeTakeFirstOrThrow();
      expect(afterCancel.committed).toBe(0);

      // Turned off again: nothing new is shown or accepted; what was bought stays readable.
      await disableCapability(t, admin, 'price_tiers_addons', 'DEC-097');
      const off = await ok<Body>(
        get(t, `/v1/offerings/${week.offeringId}/purchase-options`, parent.header),
      );
      expect(off).toMatchObject({ tiers: [], addons: [] });
      const attendanceOff = await ok<Body>(
        get(
          t,
          `/v1/attendance?activityType=session&activityId=${mon}&offeringId=${week.offeringId}`,
          desk.header,
        ),
      );
      expect(attendanceOff['expected']).toBeNull();
      const offBasket = await ok<Body>(
        post(t, '/v1/baskets', other.header, { ownerPersonId: other.personId }),
        201,
      );
      const offLine = await post(
        t,
        `/v1/baskets/${offBasket['id'] as string}/lines`,
        other.header,
        {
          participantPersonId: cal,
          offeringId: week.offeringId,
          intent: 'youth',
          priceTierId: tier('single_day'),
          selectedSessionIds: [tue],
        },
      );
      expect(offLine.status).toBe(403);
      expect(offLine.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      const stillThere = await ok<Body>(
        get(t, `/v1/registration-quotes/${quote.id}`, parent.header),
      );
      expect((stillThere['lines'] as Line[]).map((l) => l.lineKind)).toEqual(
        lines.map((l) => l.lineKind),
      );
    } finally {
      await t.close();
    }
  });

  it('SPK-PAY-014: with price tiers and add-ons off, a camp registration is quoted exactly as before: one line per place at the base price, no basis, no day selection', async () => {
    const t = await journeyApp({ clockStart: NOW });
    try {
      const desk = await staff(t, ['front_desk']);
      const finance = await staff(t, ['finance_operator']);
      const parent = await adult(t);
      const kid = await child(t, [parent]);
      const { camp: week, sessionIds } = await camp(t);
      await ok(
        post(t, `/v1/offerings/${week.offeringId}/price-rules`, finance.header, {
          effectiveFrom: NOW,
          basePriceMinor: 30_000,
          currency: 'USD',
        }),
        201,
      );
      const { basketId, body } = await basketWith(t, parent, week, [{ participantPersonId: kid }]);
      const [line] = body['lines'] as Body[];
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
      await ok(hold(t, parent, basketId, body['revision']));
      const quote = await ok<Body & { id: string }>(
        post(t, '/v1/registration-quotes', parent.header, { basketId }),
        201,
      );
      expect(quote['lines']).toEqual([
        expect.objectContaining({
          lineKind: 'registration',
          sourceId: null,
          addon: null,
          uniform: null,
          priceBasis: null,
          description: week.name,
          unitPriceMinor: 30_000,
          totalMinor: 30_000,
        }),
      ]);
      await pay(t, parent, quote.id);
      // Only the offering-wide place is counted; no session or add-on pool was made.
      const pools = await t.db
        .selectFrom('capacity_pools')
        .select(['scope_type', 'committed'])
        .where('organization_id', '=', t.organizationId)
        .execute();
      expect(pools).toEqual([{ scope_type: 'offering', committed: 1 }]);
      const attendance = await ok<Body>(
        get(
          t,
          `/v1/attendance?activityType=session&activityId=${sessionIds[0] as string}&offeringId=${week.offeringId}`,
          desk.header,
        ),
      );
      expect(attendance).toMatchObject({ people: [], expected: null });
      const offering = await ok<{ price: Body }>(
        get(t, `/v1/offerings/${week.offeringId}`, parent.header),
      );
      expect(offering.price['tiers']).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it('SPK-REG-012: a class requires a kit: the customer chooses a size, the uniform is its own quote line, staff see what is ordered, paid and handed over, hand it over and undo that only by a recorded correction; a returning holder is not charged again where the offering says so', async () => {
    const t = await journeyApp({ clockStart: NOW });
    try {
      const admin = await staff(t, ['system_administrator']);
      const finance = await staff(t, ['finance_operator']);
      const desk = await staff(t, ['front_desk']);
      const parent = await adult(t);
      const kid = await child(t, [parent]);
      const { camp: spring } = await camp(t, {
        cancellationContent: { refundBasisPoints: 10_000 },
      });
      const { camp: summer } = await camp(t);
      for (const setup of [spring, summer]) {
        await ok(
          post(t, `/v1/offerings/${setup.offeringId}/price-rules`, finance.header, {
            effectiveFrom: NOW,
            basePriceMinor: 12_000,
            currency: 'USD',
          }),
          201,
        );
      }
      const kit = {
        itemKey: 'club-kit-2026',
        name: 'Club kit',
        sizes: ['YS', 'YM', 'YL'],
        requirement: 'required',
        priceMinor: 2_500,
        currency: 'USD',
        returningHolderFree: true,
      };

      // Off for a new organization: refused on write, nothing asked of the customer.
      const refused = await post(
        t,
        `/v1/offerings/${spring.offeringId}/uniforms`,
        finance.header,
        kit,
      );
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'uniforms',
      });

      await enableCapability(t, admin, 'uniforms', 'DEC-101');
      const springKit = await ok<{ id: string }>(
        post(t, `/v1/offerings/${spring.offeringId}/uniforms`, finance.header, kit),
        201,
      );
      const summerKit = await ok<{ id: string }>(
        post(t, `/v1/offerings/${summer.offeringId}/uniforms`, finance.header, kit),
        201,
      );
      const options = await ok<Body>(
        get(t, `/v1/offerings/${spring.offeringId}/purchase-options`, parent.header),
      );
      expect(options['uniform']).toMatchObject({ id: springKit.id, sizes: ['YS', 'YM', 'YL'] });

      // A required uniform must be chosen, in a size it comes in.
      const empty = await ok<Body>(
        post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId }),
        201,
      );
      for (const [uniform, code] of [
        [undefined, 'UNIFORM_REQUIRED'],
        [{ offeringUniformId: springKit.id, size: 'XXL' }, 'UNIFORM_SIZE_NOT_OFFERED'],
      ] as const) {
        const res = await post(t, `/v1/baskets/${empty['id'] as string}/lines`, parent.header, {
          participantPersonId: kid,
          offeringId: spring.offeringId,
          intent: 'youth',
          ...(uniform ? { uniform } : {}),
        });
        expect(res.status).toBe(400);
        expect(res.body.details).toMatchObject({ code });
      }

      const { basketId, body } = await basketWith(t, parent, spring, [
        { participantPersonId: kid, uniform: { offeringUniformId: springKit.id, size: 'YM' } },
      ]);
      expect((body['lines'] as Body[])[0]?.['uniform']).toMatchObject({
        offeringUniformId: springKit.id,
        size: 'YM',
        priceMinor: 2_500,
        heldUniformOrderId: null,
      });
      const held = await ok<Body>(hold(t, parent, basketId, body['revision']));
      const enrollmentId = (held['lines'] as Body[])[0]?.['enrollmentId'] as string;
      const quote = await ok<Body & { id: string }>(
        post(t, '/v1/registration-quotes', parent.header, { basketId }),
        201,
      );
      expect(
        (quote['lines'] as Line[]).map((l) => [l.lineKind, l['description'], l['totalMinor']]),
      ).toEqual([
        ['registration', spring.name, 12_000],
        ['uniform', 'Club kit (YM)', 2_500],
      ]);
      expect((quote['lines'] as Line[])[1]).toMatchObject({
        sourceId: springKit.id,
        uniform: {
          offeringUniformId: springKit.id,
          itemKey: 'club-kit-2026',
          size: 'YM',
          priceMinor: 2_500,
          charged: true,
          reason: 'standard',
          unitPriceMinor: 2_500,
        },
      });

      // Staff see it ordered before payment, paid after, and hand it over.
      const list = async () =>
        ok<Array<Body & { id: string; revision: number }>>(
          get(t, `/v1/uniform-orders?offeringId=${spring.offeringId}`, desk.header),
        );
      expect(await list()).toEqual([
        expect.objectContaining({
          enrollmentId,
          participantPersonId: kid,
          size: 'YM',
          status: 'ordered',
          paidAt: null,
          handedOverAt: null,
        }),
      ]);
      // A parent may not read the staff list.
      expect(
        (await get(t, `/v1/uniform-orders?offeringId=${spring.offeringId}`, parent.header)).status,
      ).toBe(403);
      const [ordered] = await list();
      const early = await post(t, `/v1/uniform-orders/${ordered?.id}/hand-over`, desk.header, {});
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('INVALID_TRANSITION');

      await pay(t, parent, quote.id);
      const [paid] = await list();
      expect(paid).toMatchObject({ status: 'paid', paidAt: '2026-06-01T15:00:00.000Z' });

      t.clock.advance(2 * DAY);
      const handed = await ok<Body & { revision: number }>(
        post(t, `/v1/uniform-orders/${paid?.id}/hand-over`, desk.header, {
          expectedRevision: paid?.revision,
        }),
      );
      expect(handed).toMatchObject({
        status: 'handed_over',
        handedOverAt: '2026-06-03T15:00:00.000Z',
        handedOverBy: expect.any(String),
      });
      // Handing over twice is refused; undoing it needs a reason and leaves a record.
      expect(
        (await post(t, `/v1/uniform-orders/${paid?.id}/hand-over`, desk.header, {})).status,
      ).toBe(409);
      expect(
        (await post(t, `/v1/uniform-orders/${paid?.id}/hand-over-corrections`, desk.header, {}))
          .status,
      ).toBe(400);
      const corrected = await ok<Body>(
        post(t, `/v1/uniform-orders/${paid?.id}/hand-over-corrections`, desk.header, {
          reason: 'Recorded against the wrong child',
        }),
      );
      expect(corrected).toMatchObject({ status: 'paid', handedOverAt: null, handedOverBy: null });
      const events = await t.db
        .selectFrom('uniform_handover_events')
        .select(['kind', 'reason', 'actor_person_id', 'corrects_event_id'])
        .where('uniform_order_id', '=', paid?.id as string)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      expect(events).toEqual([
        {
          kind: 'handed_over',
          reason: null,
          actor_person_id: desk.personId,
          corrects_event_id: null,
        },
        {
          kind: 'correction',
          reason: 'Recorded against the wrong child',
          actor_person_id: desk.personId,
          corrects_event_id: expect.any(String),
        },
      ]);
      await ok(post(t, `/v1/uniform-orders/${paid?.id}/hand-over`, desk.header, {}));

      // A returning participant who holds the current kit is not charged again (this offering
      // says so); the quote keeps the line at zero and says why.
      const again = await basketWith(t, parent, summer, [
        { participantPersonId: kid, uniform: { offeringUniformId: summerKit.id, size: 'YL' } },
      ]);
      expect((again.body['lines'] as Body[])[0]?.['uniform']).toMatchObject({
        heldUniformOrderId: paid?.id,
        returningHolderFree: true,
      });
      await ok(hold(t, parent, again.basketId, again.body['revision']));
      const secondQuote = await ok<Body>(
        post(t, '/v1/registration-quotes', parent.header, { basketId: again.basketId }),
        201,
      );
      expect((secondQuote['lines'] as Line[])[1]).toMatchObject({
        lineKind: 'uniform',
        unitPriceMinor: 0,
        totalMinor: 0,
        uniform: {
          charged: false,
          reason: 'returning_holder',
          heldUniformOrderId: paid?.id,
          priceMinor: 2_500,
        },
      });
      expect(secondQuote['totalMinor']).toBe(12_000);
      // The order of that uniform records no price, so the staff list never reads it as paid for.
      const summerOrders = await ok<Body[]>(
        get(t, `/v1/uniform-orders?offeringId=${summer.offeringId}`, desk.header),
      );
      expect(summerOrders).toEqual([
        expect.objectContaining({
          size: 'YL',
          status: 'ordered',
          priceMinor: null,
          currency: null,
        }),
      ]);

      // Cancelling the first registration: the place is refunded by the policy; the uniform, now
      // handed over, is not part of that amount and stays with the participant.
      const preview = await ok<Body>(
        get(t, `/v1/enrollments/${enrollmentId}/cancellation-preview`, parent.header),
      );
      expect(preview['financialConsequence']).toMatchObject({
        kind: 'refund',
        amountMinor: 12_000,
      });
      expect((preview['financialConsequence'] as Body)['explanation']).toMatch(
        /uniform is not part/,
      );

      // Turned off: hand-over is refused, the list stays readable.
      await disableCapability(t, admin, 'uniforms', 'DEC-101');
      const [current] = await list();
      expect(current).toMatchObject({ status: 'handed_over' });
      const offCorrection = await post(
        t,
        `/v1/uniform-orders/${paid?.id}/hand-over-corrections`,
        desk.header,
        { reason: 'Attempt while the capability is off' },
      );
      expect(offCorrection.status).toBe(403);
      expect(offCorrection.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      expect(
        (
          await ok<Body>(
            get(t, `/v1/offerings/${summer.offeringId}/purchase-options`, parent.header),
          )
        )['uniform'],
      ).toBeNull();
    } finally {
      await t.close();
    }
  });
});
