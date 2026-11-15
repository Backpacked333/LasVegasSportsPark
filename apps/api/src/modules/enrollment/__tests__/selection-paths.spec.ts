import { newId } from '@sportspark/contracts';
import { json, pgConstraintName } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCapability, type TestApp } from '../../../testing';
import {
  createOfferingAddonFixture,
  createOfferingSessionFixture,
  createOfferingUniformFixture,
  createPriceRuleFixture,
  createPriceRuleTierFixture,
  createProgramFixture,
} from '../../catalog';
import { createCapacityPoolFixture, createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  acknowledge,
  adult,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const ACTOR = json({ kind: 'system', actorLabel: 'test' });

type Body = Record<string, unknown>;
const details = (body: unknown) => (body as { details: Body }).details;

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
 * Quality review of 2026-11-14, findings M-1 to M-4 and M-8 in the enrollment module: what a tier,
 * a day selection, an add-on and a uniform mean on the paths into an enrollment that are not a
 * customer's basket line (the waiting list, a trial conversion, a transfer), and for capacity
 * counted per session. Proposed amendments PA-03 (SPK-PAY-014, capability `price_tiers_addons`)
 * and PA-07 (SPK-REG-012, capability `uniforms`); migrations 0524 and 0525. Tiers, prices, sizes
 * and seats are test data, not policy.
 */
describe('tiers, days and uniforms on every path into an enrollment (SPK-PAY-014, SPK-REG-012)', () => {
  let t: TestApp;
  let parent: Actor;

  /** A five-day camp, all days still to come, sold by the week or by the day. */
  async function camp(
    options: { seats?: number; tiers?: boolean; basePriceMinor?: number; rule?: boolean } = {},
  ) {
    const setup = await offering(t, {
      kind: 'camp',
      basePriceMinor: null,
      capacityUnits: [{ unit: 'seats', limit: options.seats ?? 20 }],
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
    if (options.rule === false)
      return { setup, sessionIds, tiers: { fullWeek: '', singleDay: '' } };
    const priceRuleId = await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: options.basePriceMinor ?? 30_000,
      effectiveFrom: new Date(NOW - DAY),
    });
    const tiers =
      options.tiers === false ? { fullWeek: '', singleDay: '' } : await tiersOf(setup, priceRuleId);
    return { setup, sessionIds, tiers };
  }

  async function tiersOf(setup: OfferingSetup, priceRuleId: string) {
    const base = { priceRuleId, offeringId: setup.offeringId };
    return {
      fullWeek: await createPriceRuleTierFixture(t, {
        ...base,
        code: 'full_week',
        name: 'Full week',
        priceMinor: 30_000,
      }),
      singleDay: await createPriceRuleTierFixture(t, {
        ...base,
        code: 'single_day',
        name: 'Single day',
        attendance: 'chosen_sessions',
        minSessions: 1,
        maxSessions: 1,
        priceMinor: 7_000,
      }),
    };
  }

  async function kidFor(setup: OfferingSetup, owner: Actor = parent): Promise<string> {
    const kid = await child(t, [owner]);
    await acknowledge(t, setup, kid, owner.personId);
    return kid;
  }

  /** A basket of `owner` with one line; the line is held unless `hold` is false. */
  async function basketLine(
    setup: OfferingSetup,
    line: Body,
    options: { owner?: Actor; hold?: boolean; kid?: string } = {},
  ) {
    const owner = options.owner ?? parent;
    const kid = options.kid ?? (await kidFor(setup, owner));
    const created = await post(t, '/v1/baskets', owner.header, { ownerPersonId: owner.personId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const basketId = created.body.id as string;
    const added = await post(t, `/v1/baskets/${basketId}/lines`, owner.header, {
      participantPersonId: kid,
      offeringId: setup.offeringId,
      intent: 'youth',
      ...line,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const held =
      options.hold === false ? null : await post(t, `/v1/baskets/${basketId}/hold`, owner.header);
    return { basketId, kid, held, owner };
  }

  const join = (setup: OfferingSetup, kid: string, body: Body = {}, owner: Actor = parent) =>
    post(t, '/v1/waitlist-entries', owner.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
      ...body,
    });

  const sessionPool = (sessionId: string) =>
    t.db
      .selectFrom('capacity_pools')
      .select(['id', 'capacity', 'committed', 'held'])
      .where('organization_id', '=', t.organizationId)
      .where('scope_type', '=', 'session')
      .where('scope_id', '=', sessionId)
      .executeTakeFirst();

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
  // M-2: the waiting list of an offering sold by tier
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014 (QA M-2): a full day is waited for under its tier although the offering has room, a free day is not; the entry records the tier, days, add-on and uniform, and its accepted offer opens a held basket line that carries them', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const [mon, tue] = sessionIds as [string, string];
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'lunch',
      name: 'Lunch',
      priceMinor: 900,
      selection: 'per_session',
    });
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'required',
      priceMinor: 2_500,
    });
    const uniform = { offeringUniformId: uniformId, size: 'YM' };
    const monday = { priceTierId: tiers.singleDay, selectedSessionIds: [mon], uniform };

    // Monday's one seat is held by another family; the offering-wide place is untouched (a line
    // of chosen days takes none), so the offering itself still "has room".
    const other = await adult(t);
    const first = await basketLine(setup, monday, { owner: other });
    expect(first.held?.status, JSON.stringify(first.held?.body)).toBe(200);
    const kid = await kidFor(setup);
    const refusedHold = await basketLine(setup, monday, { kid });
    expect(refusedHold.held?.status).toBe(409);
    expect(refusedHold.held?.body.code).toBe('CAPACITY_UNAVAILABLE');

    // An offering sold by tier is waited for under a tier; a required uniform is chosen now.
    const noTier = await join(setup, kid);
    expect(noTier.status).toBe(400);
    expect(details(noTier.body)).toMatchObject({ code: 'TIER_REQUIRED' });
    const noUniform = await join(setup, kid, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    expect(noUniform.status).toBe(400);
    expect(details(noUniform.body)).toMatchObject({
      code: 'UNIFORM_REQUIRED',
      sizes: ['YS', 'YM', 'YL'],
    });
    // Refused only when what was asked for is available: Tuesday has its seat.
    const free = await join(setup, kid, { ...monday, selectedSessionIds: [tue] });
    expect(free.status).toBe(409);
    expect(details(free.body)).toMatchObject({ code: 'CAPACITY_AVAILABLE' });

    const joined = await join(setup, kid, {
      ...monday,
      addons: [{ addonId: lunch, sessionIds: [mon] }],
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    const mondayPool = await sessionPool(mon);
    expect(joined.body).toMatchObject({
      status: 'waiting',
      position: 1,
      poolId: mondayPool?.id,
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
      addons: [{ addonId: lunch, sessionIds: [mon] }],
      uniform,
    });
    const again = await join(setup, kid, monday);
    expect(again.status).toBe(409);
    expect(details(again.body)).toMatchObject({ code: 'ALREADY_WAITLISTED' });

    // Waiting for Monday does not stop another family from buying Tuesday (waitlist first counts
    // who waits on the place asked for), and Tuesday is then full for the next one.
    const tuesday = await basketLine(
      setup,
      { ...monday, selectedSessionIds: [tue] },
      { owner: other },
    );
    expect(tuesday.held?.status, JSON.stringify(tuesday.held?.body)).toBe(200);

    // Monday's seat comes back: it is offered to who waits for Monday, and held for them.
    const released = await post(t, `/v1/baskets/${first.basketId}/release`, other.header, {
      reason: 'changed plans',
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    await drain(t);
    const entry = await t.http.get(`/v1/waitlist-entries/${joined.body.id}`).set(parent.header);
    expect(entry.body).toMatchObject({ status: 'offered' });
    const offerId = (entry.body.offers as Body[])[0]?.['id'] as string;
    expect(await sessionPool(mon)).toMatchObject({ capacity: 1, held: 1, committed: 0 });
    const late = await basketLine(setup, monday, { owner: other });
    expect(late.held?.status).toBe(409);

    const accepted = await post(t, `/v1/waitlist-offers/${offerId}/accept`, parent.header);
    expect(accepted.status, accepted.body.message).toBe(200);
    const basket = accepted.body.basket as Body;
    const line = (basket['lines'] as Body[])[0] as Body;
    expect(basket['status']).toBe('held');
    expect(line).toMatchObject({
      outcome: 'held',
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
      addons: [{ addonId: lunch, sessionIds: [mon], quantity: 1 }],
      uniform: { offeringUniformId: uniformId, size: 'YM' },
      price: { estimate: { tier: { code: 'single_day' }, unitPriceMinor: 7_000 } },
    });
    // The enrollment attends Monday only, its uniform is on order, and the seat is the offer's.
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['status', 'price_tier_id', 'selected_session_ids'])
      .where('id', '=', line['enrollmentId'] as string)
      .executeTakeFirstOrThrow();
    expect(enrollment).toEqual({
      status: 'pending',
      price_tier_id: tiers.singleDay,
      selected_session_ids: [mon],
    });
    expect(
      await t.db
        .selectFrom('uniform_orders')
        .select(['size', 'status'])
        .where('enrollment_id', '=', line['enrollmentId'] as string)
        .execute(),
    ).toEqual([{ size: 'YM', status: 'ordered' }]);
    expect(await sessionPool(mon)).toMatchObject({ capacity: 1, held: 1, committed: 0 });
  });

  it('SPK-PAY-014 (QA M-2): an entry behind one that waits for another day is offered its own day; an entry that names no tier, once the offering is sold by tier, leaves the queue with the reason', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const [mon, tue] = sessionIds as [string, string];
    // An entry recorded while the offering had one price: it waits for a place of the offering
    // and names no tier.
    const legacyId = newId();
    await t.db
      .insertInto('waitlist_entries')
      .values({
        id: legacyId,
        organization_id: t.organizationId,
        offering_id: setup.offeringId,
        pool_id: await createCapacityPoolFixture(t, { offeringId: setup.offeringId, capacity: 1 }),
        session_id: null,
        participant_person_id: await kidFor(setup),
        intent: 'youth',
        joined_at: new Date(NOW - DAY),
        queued_at: new Date(NOW - DAY),
        requested_by: ACTOR,
        requested_by_person_id: parent.personId,
        payer_person_id: parent.personId,
        accepted_enrollment_id: null,
        withdrawn_at: null,
        removed_at: null,
        removal_reason: null,
      })
      .execute();
    const legacy = { body: { id: legacyId } };
    const other = await adult(t);
    const day = (sessionId: string) => ({
      priceTierId: tiers.singleDay,
      selectedSessionIds: [sessionId],
    });
    const heldMon = await basketLine(setup, day(mon), { owner: other });
    const heldTue = await basketLine(setup, day(tue), { owner: other });
    // Waitlist first: the entry that waits for a place of the offering is ahead of nobody's day.
    expect(heldMon.held?.status, JSON.stringify(heldMon.held?.body)).toBe(200);
    expect(heldTue.held?.status, JSON.stringify(heldTue.held?.body)).toBe(200);
    const monKid = await kidFor(setup);
    const tueKid = await kidFor(setup);
    const waitsMon = await join(setup, monKid, day(mon));
    const waitsTue = await join(setup, tueKid, day(tue));
    expect(waitsMon.status, JSON.stringify(waitsMon.body)).toBe(201);
    expect(waitsTue.status, JSON.stringify(waitsTue.body)).toBe(201);

    // Tuesday's seat comes back. Monday's waiter is ahead in the queue and is passed over.
    await post(t, `/v1/baskets/${heldTue.basketId}/release`, other.header, { reason: 'no' });
    await drain(t);
    const statusOf = async (id: string) =>
      (await t.http.get(`/v1/waitlist-entries/${id}`).set(parent.header)).body as Body;
    expect(await statusOf(waitsTue.body.id as string)).toMatchObject({ status: 'offered' });
    expect(await statusOf(waitsMon.body.id as string)).toMatchObject({ status: 'waiting' });
    // The entry without a tier could never be accepted any more: it left with the reason.
    expect(await statusOf(legacy.body.id as string)).toMatchObject({ status: 'removed' });
    expect(
      await t.db
        .selectFrom('waitlist_entries')
        .select('removal_reason')
        .where('id', '=', legacy.body.id as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ removal_reason: 'tier_required' });
  });

  it('SPK-PAY-014, SPK-REG-012 (QA M-2, M-4): a trial converts into an offering sold by tier only with a tier, and into one that requires a uniform only with a size; the follow-up line carries both', async () => {
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 5, maxAgeYears: 12 } });
    const trial = await offering(t, { kind: 'trial', programId: program, basePriceMinor: 0 });
    const trialSession = await createOfferingSessionFixture(t, {
      offeringId: trial.offeringId,
      scheduledStart: new Date(t.clock.now().getTime() + 2 * DAY),
      scheduledEnd: new Date(t.clock.now().getTime() + 2 * DAY + HOUR),
    });
    const { setup, sessionIds, tiers } = await camp();
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'required',
      priceMinor: 2_500,
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    await acknowledge(t, setup, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId: trialSession,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const convert = (body: Body) =>
      post(t, `/v1/trial-participations/${created.body.id}/convert`, parent.header, {
        targetOfferingId: setup.offeringId,
        expectedRevision: created.body.revision,
        ...body,
      });

    const noTier = await convert({});
    expect(noTier.status).toBe(400);
    expect(details(noTier.body)).toMatchObject({
      code: 'TIER_REQUIRED',
      nextAction: 'choose_price_tier',
      tiers: [
        { id: tiers.fullWeek, code: 'full_week', name: 'Full week' },
        { id: tiers.singleDay, code: 'single_day', name: 'Single day' },
      ],
    });
    const noUniform = await convert({ priceTierId: tiers.fullWeek });
    expect(noUniform.status).toBe(400);
    expect(details(noUniform.body)).toMatchObject({
      code: 'UNIFORM_REQUIRED',
      nextAction: 'choose_uniform_size',
      offeringUniformId: uniformId,
      sizes: ['YS', 'YM', 'YL'],
    });
    // Nothing was written by the refusals: the trial still converts.
    const converted = await convert({
      priceTierId: tiers.singleDay,
      selectedSessionIds: [sessionIds[2]],
      uniform: { offeringUniformId: uniformId, size: 'YL' },
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    const basket = converted.body.basket as Body;
    expect((basket['lines'] as Body[])[0]).toMatchObject({
      trialParticipationId: created.body.id,
      priceTierId: tiers.singleDay,
      selectedSessionIds: [sessionIds[2]],
      uniform: { offeringUniformId: uniformId, size: 'YL' },
      price: { estimate: { tier: { code: 'single_day' }, unitPriceMinor: 7_000 } },
    });
    // The family holds it like any basket: the day's seat and the uniform order follow.
    const held = await post(t, `/v1/baskets/${basket['id'] as string}/hold`, parent.header);
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(await sessionPool(sessionIds[2] as string)).toMatchObject({ held: 1 });
  });

  // ---------------------------------------------------------------------------------------------
  // M-4: the required uniform where an enrollment is created
  // ---------------------------------------------------------------------------------------------

  it('SPK-REG-012, SPK-PAY-014 (QA M-4, M-2): a line added before the offering required a uniform or was sold by tier is refused at the hold with what is missing and what to do', async () => {
    const plain = await camp({ tiers: false });
    const before = await basketLine(plain.setup, {}, { hold: false });
    await createOfferingUniformFixture(t, {
      offeringId: plain.setup.offeringId,
      name: 'Camp kit',
      requirement: 'required',
      priceMinor: 2_500,
    });
    const hold = await post(t, `/v1/baskets/${before.basketId}/hold`, parent.header);
    expect(hold.status).toBe(400);
    expect(hold.body.message).toBe(
      'This offering requires the uniform "Camp kit": remove the line and add it again, choosing a size (YS, YM, YL).',
    );
    expect(details(hold.body)).toMatchObject({
      code: 'UNIFORM_REQUIRED',
      nextAction: 'remove_line_and_choose_uniform_size',
      sizes: ['YS', 'YM', 'YL'],
    });
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('offering_id', '=', plain.setup.offeringId)
        .execute(),
    ).toEqual([]);

    const tiered = await camp({ tiers: false });
    const early = await basketLine(tiered.setup, {}, { hold: false });
    const rule = await t.db
      .selectFrom('price_rules')
      .select('id')
      .where('offering_id', '=', tiered.setup.offeringId)
      .executeTakeFirstOrThrow();
    await tiersOf(tiered.setup, rule.id);
    const refused = await post(t, `/v1/baskets/${early.basketId}/hold`, parent.header);
    expect(refused.status).toBe(400);
    expect(details(refused.body)).toMatchObject({
      code: 'TIER_REQUIRED',
      nextAction: 'remove_line_and_choose_tier',
    });
  });

  // ---------------------------------------------------------------------------------------------
  // M-8, M-3, M-4: a transfer
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014, SPK-REG-012 (QA M-8, M-3, M-4): a transfer into an offering sold by tier names the tier and days, sits on the seat pool of each day attended, stores the price it was moved in at, and is refused where the target requires a uniform', async () => {
    const source = await offering(t, { basePriceMinor: 0 });
    const from = await basketLine(source, {});
    expect(from.held?.status, JSON.stringify(from.held?.body)).toBe(200);
    const done = await post(t, `/v1/baskets/${from.basketId}/complete`, parent.header);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const enrollmentId = ((done.body.lines as Body[])[0] as Body)['enrollmentId'] as string;
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const wed = sessionIds[2] as string;
    await acknowledge(t, setup, from.kid, parent.personId);
    const current = async () =>
      (await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header)).body as Body;
    const transfer = async (body: Body) =>
      post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
        targetOfferingId: setup.offeringId,
        commit: true,
        expectedRevision: (await current())['revision'],
        ...body,
      });

    const noTier = await transfer({});
    expect(noTier.status).toBe(400);
    expect(details(noTier.body)).toMatchObject({ code: 'TIER_REQUIRED', nextAction: 'name_tier' });
    expect(noTier.body.message).toBe(
      'This offering is sold by price option. To move into it, choose the option, and the days where days are chosen. Where that cannot be chosen here, register for it in a basket and then cancel the current registration.',
    );
    // The preview prices the tier named, never the rule's base price.
    const preview = await t.http
      .get(
        `/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${setup.offeringId}` +
          `&priceTierId=${tiers.singleDay}&selectedSessionIds=${wed}`,
      )
      .set(parent.header);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.proposed.price).toMatchObject({
      estimate: { tier: { code: 'single_day' }, unitPriceMinor: 7_000 },
    });

    const moved = await transfer({ priceTierId: tiers.singleDay, selectedSessionIds: [wed] });
    expect(moved.status, moved.body.message).toBe(200);
    const created = moved.body.newEnrollment as Body;
    expect(created).toMatchObject({
      status: 'confirmed',
      priceTierId: tiers.singleDay,
      selectedSessionIds: [wed],
      // What a later cancellation is worked out on: the tier's price, stored with the enrollment.
      price: { estimate: { tier: { code: 'single_day' }, unitPriceMinor: 7_000 } },
    });
    // The transferred participant takes Wednesday's seat, and only Wednesday's.
    expect(await sessionPool(wed)).toMatchObject({ capacity: 1, committed: 1, held: 0 });
    const allocations = await t.db
      .selectFrom('allocations')
      .innerJoin('capacity_pools', 'capacity_pools.id', 'allocations.pool_id')
      .select(['capacity_pools.scope_type', 'capacity_pools.scope_id'])
      .where('allocations.enrollment_id', '=', created['id'] as string)
      .where('allocations.status', '=', 'active')
      .execute();
    expect(allocations).toEqual([{ scope_type: 'session', scope_id: wed }]);
    const full = await basketLine(setup, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [wed],
    });
    expect(full.held?.status).toBe(409);
    expect(full.held?.body.code).toBe('CAPACITY_UNAVAILABLE');

    // A target that requires a uniform: a transfer cannot order one, and says what to do.
    const kitted = await camp();
    await createOfferingUniformFixture(t, {
      offeringId: kitted.setup.offeringId,
      name: 'Camp kit',
      requirement: 'required',
      priceMinor: 2_500,
    });
    await acknowledge(t, kitted.setup, from.kid, parent.personId);
    const newId_ = created['id'] as string;
    const refused = await post(t, `/v1/enrollments/${newId_}/transfer`, parent.header, {
      targetOfferingId: kitted.setup.offeringId,
      commit: true,
      expectedRevision: created['revision'],
      priceTierId: kitted.tiers.fullWeek,
    });
    expect(refused.status).toBe(400);
    expect(details(refused.body)).toMatchObject({
      code: 'UNIFORM_REQUIRED',
      nextAction: 'register_in_basket',
    });
    expect(refused.body.message).toContain('register for this offering in a basket');
    // Nothing moved: the place is still Wednesday's.
    expect((await t.http.get(`/v1/enrollments/${newId_}`).set(parent.header)).body).toMatchObject({
      status: 'confirmed',
      offeringId: setup.offeringId,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // M-3: session capacity counts everyone who attends
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014 (QA M-3): add a single-day tier to a half-sold camp: each day can only be sold up to what is left', async () => {
    // A camp of three, sold at one free price until an hour from now.
    const { setup, sessionIds } = await camp({ seats: 3, rule: false });
    const [mon, tue] = sessionIds as [string, string];
    const start = t.clock.now().getTime();
    await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: 0,
      effectiveFrom: new Date(start - DAY),
      effectiveTo: new Date(start + HOUR),
    });
    const sold: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const line = await basketLine(setup, {});
      expect(line.held?.status, JSON.stringify(line.held?.body)).toBe(200);
      const done = await post(t, `/v1/baskets/${line.basketId}/complete`, parent.header);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      sold.push(((done.body.lines as Body[])[0] as Body)['enrollmentId'] as string);
    }
    // Bought before the tier existed: the offering-wide places only, no session seat.
    expect(await sessionPool(mon)).toBeUndefined();

    // Staff add a new price version with a single-day tier.
    t.clock.advance(2 * HOUR);
    const ruleId = await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: 30_000,
      effectiveFrom: new Date(start + HOUR),
    });
    const tiers = await tiersOf(setup, ruleId);
    const day = (sessionId: string) => ({
      priceTierId: tiers.singleDay,
      selectedSessionIds: [sessionId],
    });

    // Monday: two full-week children are already there, so one seat is left, not three.
    const third = await basketLine(setup, day(mon));
    expect(third.held?.status, JSON.stringify(third.held?.body)).toBe(200);
    expect(await sessionPool(mon)).toMatchObject({ capacity: 3, committed: 2, held: 1 });
    const fourth = await basketLine(setup, day(mon));
    expect(fourth.held?.status).toBe(409);
    expect(fourth.held?.body.code).toBe('CAPACITY_UNAVAILABLE');
    // Each earlier registration is on Monday's seats exactly once, however often that is read.
    const seated = await t.db
      .selectFrom('allocations')
      .select('enrollment_id')
      .where('pool_id', '=', (await sessionPool(mon))?.id as string)
      .where('status', '=', 'active')
      .orderBy('enrollment_id')
      .execute();
    expect(seated.map((row) => row.enrollment_id)).toEqual([...sold].sort());
    // Tuesday counts them too, from its first sale; so does a place for the whole week.
    expect((await basketLine(setup, day(tue))).held?.status).toBe(200);
    expect(await sessionPool(tue)).toMatchObject({ capacity: 3, committed: 2, held: 1 });
    expect((await basketLine(setup, day(tue))).held?.status).toBe(409);
    const week = await basketLine(setup, { priceTierId: tiers.fullWeek });
    expect(week.held?.status).toBe(409);
    expect(week.held?.body.code).toBe('CAPACITY_UNAVAILABLE');

    // A full-week child who cancels gives the seat back on every day.
    const canceled = await post(t, `/v1/enrollments/${sold[0]}/cancel`, parent.header, {
      reason: 'moved away',
      expectedRevision: (
        await t.db
          .selectFrom('enrollments')
          .select('revision')
          .where('id', '=', sold[0] as string)
          .executeTakeFirstOrThrow()
      ).revision,
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    expect(await sessionPool(mon)).toMatchObject({ capacity: 3, committed: 1, held: 1 });
  });

  it('SPK-PAY-014 (QA M-3): eight concurrent holds for the last seat of a day in a half-sold camp yield exactly one, and the earlier registrations are counted once', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 3 });
    const mon = sessionIds[0] as string;
    // Two registrations from before the offering was sold by day: no tier, no session seat.
    const earlier: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      earlier.push(
        await createEnrollmentFixture(t, {
          offeringId: setup.offeringId,
          participantPersonId: await child(t, [parent]),
        }),
      );
    }
    const contenders: Array<{ owner: Actor; basketId: string }> = [];
    for (let i = 0; i < 8; i += 1) {
      const owner = await adult(t);
      const { basketId } = await basketLine(
        setup,
        { priceTierId: tiers.singleDay, selectedSessionIds: [mon] },
        { owner, hold: false },
      );
      contenders.push({ owner, basketId });
    }
    // Under TEST_DATABASE_URL these overlap; under PGlite they run one after another.
    const results = await Promise.all(
      contenders.map(({ owner, basketId }) =>
        post(t, `/v1/baskets/${basketId}/hold`, owner.header),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'CAPACITY_UNAVAILABLE'),
    ).toBe(true);
    const pool = await sessionPool(mon);
    expect(pool).toMatchObject({ capacity: 3, committed: 2, held: 1 });
    const seated = await t.db
      .selectFrom('allocations')
      .select('enrollment_id')
      .where('pool_id', '=', pool?.id as string)
      .where('status', '=', 'active')
      .orderBy('enrollment_id')
      .execute();
    expect(seated.map((row) => row.enrollment_id)).toEqual([...earlier].sort());
  });

  it('SPK-PAY-014 (QA M-3): a session that is already over its seats when days start to be sold keeps everyone who attends on its pool and tells program staff', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const mon = sessionIds[0] as string;
    for (let i = 0; i < 2; i += 1) {
      await createEnrollmentFixture(t, {
        offeringId: setup.offeringId,
        participantPersonId: await child(t, [parent]),
      });
    }
    const line = await basketLine(setup, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    expect(line.held?.status).toBe(409);
    // The refused hold rolled its reconciliation back with it; the next read still finds two.
    const waiting = await join(setup, line.kid, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    const pool = await sessionPool(mon);
    expect(pool).toMatchObject({ capacity: 2, committed: 2, held: 0 });
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select(['category', 'owner_queue'])
        .where('affected_id', '=', pool?.id as string)
        .execute(),
    ).toEqual([
      { category: 'enrollment.capacity_below_commitments', owner_queue: 'program_manager' },
    ]);
  });

  it('SPK-PAY-014 (QA M-3): the database refuses a second active allocation of one enrollment in one pool (migration 0525)', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 5 });
    const mon = sessionIds[0] as string;
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: await child(t, [parent]),
    });
    const line = await basketLine(setup, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    expect(line.held?.status).toBe(200);
    const pool = await sessionPool(mon);
    const insert = () =>
      t.db
        .insertInto('allocations')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          pool_id: pool?.id as string,
          hold_id: null,
          enrollment_id: enrollmentId,
          session_booking_id: null,
          placement_request_id: null,
          quantity: 1,
          allocated_at: t.clock.now(),
        })
        .execute();
    expect(await refusedBy(insert())).toBe('allocations_one_per_enrollment_idx');
  });

  // ---------------------------------------------------------------------------------------------
  // Migration 0524: what the database refuses by itself
  // ---------------------------------------------------------------------------------------------

  it("SPK-PAY-014 (QA M-2): the database refuses a waitlist entry whose tier is another offering's, whose days have no tier, are not sessions of its offering or are listed for a session queue, whose extras are not a list, and any change to what an entry waits for (migration 0524)", async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const elsewhere = await camp();
    const mon = sessionIds[0] as string;
    const blocker = await basketLine(
      setup,
      { priceTierId: tiers.singleDay, selectedSessionIds: [mon] },
      { owner: await adult(t) },
    );
    expect(blocker.held?.status).toBe(200);
    const pool = await sessionPool(mon);
    const entry = (over: Body) =>
      t.db
        .insertInto('waitlist_entries')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: setup.offeringId,
          pool_id: pool?.id as string,
          session_id: null,
          participant_person_id: parent.personId,
          intent: 'youth',
          joined_at: t.clock.now(),
          queued_at: t.clock.now(),
          requested_by: ACTOR,
          requested_by_person_id: null,
          payer_person_id: null,
          accepted_enrollment_id: null,
          withdrawn_at: null,
          removed_at: null,
          removal_reason: null,
          ...over,
        } as never)
        .execute();
    expect(await refusedBy(entry({ price_tier_id: elsewhere.tiers.singleDay }))).toBe(
      'waitlist_entries_price_tier_fk',
    );
    expect(await refusedBy(entry({ selected_session_ids: [mon] }))).toBe(
      'waitlist_entries_selection_needs_tier',
    );
    expect(
      await refusedBy(
        entry({
          price_tier_id: tiers.singleDay,
          selected_session_ids: [elsewhere.sessionIds[0]],
        }),
      ),
    ).toBe('registration_selection_sessions_of_offering');
    expect(
      await refusedBy(
        entry({ session_id: mon, price_tier_id: tiers.singleDay, selected_session_ids: [mon] }),
      ),
    ).toBe('waitlist_entries_selection_offering_queue');
    expect(
      await refusedBy(
        entry({ price_tier_id: tiers.singleDay, requested_extras: json({ uniform: null }) }),
      ),
    ).toBe('waitlist_entries_requested_extras_shape');

    const kid = await kidFor(setup);
    const joined = await join(setup, kid, {
      priceTierId: tiers.singleDay,
      selectedSessionIds: [mon],
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    const change = (set: Body) =>
      t.db
        .updateTable('waitlist_entries')
        .set(set as never)
        .where('id', '=', joined.body.id as string)
        .execute();
    for (const set of [
      { selected_session_ids: [sessionIds[1]] },
      { price_tier_id: tiers.fullWeek, selected_session_ids: null },
      { requested_extras: json({ addons: [], uniform: null }) },
    ]) {
      expect(await refusedBy(change(set))).toBe('waitlist_entries_request_immutable');
    }
  });

  // ---------------------------------------------------------------------------------------------
  // M-1: the sessions an enrollment attends, wherever they are read
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014 (QA M-1): the enrollment states its tier and days, and the family calendar shows only the sessions the participant attends', async () => {
    // A free camp, so its baskets complete without a checkout.
    const { setup, sessionIds } = await camp({ basePriceMinor: 0, tiers: false });
    const chosen = [sessionIds[0], sessionIds[3]] as [string, string];
    const twoDayTier = await createPriceRuleTierFixture(t, {
      priceRuleId: (
        await t.db
          .selectFrom('price_rules')
          .select('id')
          .where('offering_id', '=', setup.offeringId)
          .executeTakeFirstOrThrow()
      ).id,
      offeringId: setup.offeringId,
      code: 'two_free_days',
      name: 'Two days',
      attendance: 'chosen_sessions',
      minSessions: 2,
      maxSessions: 2,
      priceMinor: 0,
    });
    const days = await basketLine(setup, { priceTierId: twoDayTier, selectedSessionIds: chosen });
    expect(days.held?.status, JSON.stringify(days.held?.body)).toBe(200);
    const done = await post(t, `/v1/baskets/${days.basketId}/complete`, parent.header);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const enrollmentId = ((done.body.lines as Body[])[0] as Body)['enrollmentId'] as string;
    const enrollment = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(enrollment.body).toMatchObject({
      status: 'confirmed',
      priceTierId: twoDayTier,
      selectedSessionIds: chosen,
    });
    // A sibling without a day selection attends every day.
    const everyDay = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: await child(t, [parent]),
    });

    const calendar = await t.http
      .get(
        `/v1/me/family-calendar?from=${new Date(NOW).toISOString()}&to=${new Date(
          NOW + 30 * DAY,
        ).toISOString()}`,
      )
      .set(parent.header);
    expect(calendar.status, JSON.stringify(calendar.body)).toBe(200);
    const items = (calendar.body.items as Body[]).filter(
      (item) => item['offeringId'] === setup.offeringId,
    );
    const sessionsOf = (id: string) =>
      items.filter((item) => item['enrollmentId'] === id).map((item) => item['sessionId']);
    expect(sessionsOf(enrollmentId)).toEqual(chosen);
    expect(sessionsOf(everyDay)).toEqual(sessionIds);
  });

  // ---------------------------------------------------------------------------------------------
  // Capability off
  // ---------------------------------------------------------------------------------------------

  it('SPK-PAY-014, SPK-REG-012: with the capabilities off the new fields are refused on every path, and a waitlist, a conversion and a transfer behave exactly as before', async () => {
    const { setup, sessionIds, tiers } = await camp({ seats: 1 });
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'required',
      priceMinor: 2_500,
    });
    const source = await offering(t, { basePriceMinor: 0 });
    const from = await basketLine(source, {});
    const done = await post(t, `/v1/baskets/${from.basketId}/complete`, parent.header);
    const enrollmentId = ((done.body.lines as Body[])[0] as Body)['enrollmentId'] as string;
    await acknowledge(t, setup, from.kid, parent.personId);
    await setCapability(t.db, t.organizationId, 'price_tiers_addons', false);
    await setCapability(t.db, t.organizationId, 'uniforms', false);
    try {
      // The offering-wide place is the only constraint again, and a line names no tier.
      const taken = await basketLine(setup, {}, { owner: await adult(t) });
      expect(taken.held?.status, JSON.stringify(taken.held?.body)).toBe(200);
      expect(await sessionPool(sessionIds[0] as string)).toBeUndefined();
      const kid = await kidFor(setup);
      for (const [body, capability] of [
        [{ priceTierId: tiers.fullWeek }, 'price_tiers_addons'],
        [{ selectedSessionIds: [sessionIds[0]] }, 'price_tiers_addons'],
        [{ uniform: { offeringUniformId: uniformId, size: 'YM' } }, 'uniforms'],
      ] as const) {
        const refused = await join(setup, kid, body);
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(details(refused.body)).toMatchObject({ code: 'CAPABILITY_DISABLED', capability });
      }
      const joined = await join(setup, kid);
      expect(joined.status, JSON.stringify(joined.body)).toBe(201);
      expect(joined.body).toMatchObject({
        status: 'waiting',
        priceTierId: null,
        selectedSessionIds: null,
        addons: [],
        uniform: null,
      });
      const refusedTransfer = await post(
        t,
        `/v1/enrollments/${enrollmentId}/transfer`,
        parent.header,
        {
          targetOfferingId: setup.offeringId,
          commit: false,
          expectedRevision: 2,
          priceTierId: tiers.fullWeek,
        },
      );
      expect(refusedTransfer.status).toBe(403);
      expect(details(refusedTransfer.body)).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      // A preview names no tier and reads the base price, the offering-wide place and no uniform.
      const preview = await t.http
        .get(
          `/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${setup.offeringId}`,
        )
        .set(parent.header);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.proposed.price).toEqual({
        priceRuleId: expect.any(String),
        basePriceMinor: 30_000,
        currency: 'USD',
        chargeLines: [],
      });
      expect(preview.body.capacity.required).toEqual([
        expect.objectContaining({ unit: 'seats', constraintKind: 'commercial', available: 0 }),
      ]);
    } finally {
      await setCapability(t.db, t.organizationId, 'price_tiers_addons', true);
      await setCapability(t.db, t.organizationId, 'uniforms', true);
    }
  });
});
