import { systemPrincipal, type FinancialConsequence } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsService, UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { createOfferingFixture, createPriceRuleFixture, createProgramFixture } from '../../catalog';
import { createSeasonFixture } from '../../competition';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { EnrollmentModule } from '../enrollment.module';
import {
  BASKET_PORT,
  ENROLLMENT_PORT,
  FINANCE_POLICY_IMPL,
  type BasketPort,
  type EnrollmentPort,
  type FinancePolicyPort,
} from '../enrollment.ports';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  CLOCK_START,
  acknowledge,
  adult,
  basketWith,
  child,
  key,
  offering,
  post,
  staff,
  type Actor,
} from './support';
import { withStage3Doubles } from './stage3-doubles';

/** A stub finance policy (stands in for DEC-009): the refund the test sets, else none. */
let refundMinor: number | null = null;
const stubPolicy: FinancePolicyPort = {
  transferConsequence: async (_organizationId, input) => {
    const diff = (input.toPrice?.amountMinor ?? 0) - (input.fromPrice?.amountMinor ?? 0);
    const consequence: FinancialConsequence = {
      kind: diff > 0 ? 'charge' : diff < 0 ? 'credit' : 'none',
      amountMinor: diff === 0 ? null : Math.abs(diff),
      currency: diff === 0 ? null : 'USD',
      explanation: 'The price difference between the offerings.',
      policyVersionId: null,
    };
    return consequence;
  },
  cancellationConsequence: async () =>
    refundMinor === null
      ? {
          kind: 'none',
          amountMinor: null,
          currency: null,
          explanation: 'No consequence.',
          policyVersionId: null,
        }
      : {
          kind: 'refund',
          amountMinor: refundMinor,
          currency: 'USD',
          explanation: 'Refund under the stub cancellation policy.',
          policyVersionId: null,
        },
};

/** ENR-03 to ENR-06: consequence binding, staff waitlist offers, registration options, checkout. */
describe('registration commands of stage 3 (ENR-03, ENR-04, ENR-05, ENR-06)', () => {
  let t: TestApp;
  let parent: Actor;
  let programManager: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EnrollmentModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      providers: [{ provide: FINANCE_POLICY_IMPL, useValue: stubPolicy }],
      configure: withStage3Doubles,
    });
    parent = await adult(t);
    programManager = await staff(t, ['program_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function confirmedEnrollment(price = 10_000) {
    const setup = await offering(t, { basePriceMinor: price });
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, enrollmentId, {
          orderRef: `order-${enrollmentId}`,
          actor: systemPrincipal(t.organizationId, 'finance.checkout'),
          correlationId: null,
        }),
    );
    return { setup, kid, enrollmentId };
  }

  // -------------------------------------------------------------------------------------------
  // ENR-03
  // -------------------------------------------------------------------------------------------

  it('SPK-REG-010: a cancellation whose refund changed after preview is refused until the new consequence is accepted (stub policy)', async () => {
    const { enrollmentId } = await confirmedEnrollment();
    refundMinor = 5_000;
    const preview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/cancellation-preview`)
      .set(parent.header);
    expect(preview.body.financialConsequence).toMatchObject({ kind: 'refund', amountMinor: 5_000 });
    const accepted = { kind: 'refund', amountMinor: 5_000, currency: 'USD' };
    // Without an acceptance nothing is committed.
    const unaccepted = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'schedule conflict',
      expectedRevision: 2,
    });
    expect(unaccepted.status).toBe(409);
    expect(unaccepted.body.details).toMatchObject({
      code: 'CONSEQUENCE_ACCEPTANCE_REQUIRED',
      consequence: { kind: 'refund', amountMinor: 5_000 },
    });
    // The policy answer changes between preview and commit.
    refundMinor = 4_000;
    const stale = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'schedule conflict',
      expectedRevision: 2,
      acceptedConsequence: accepted,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({
      code: 'CONSEQUENCE_CHANGED',
      consequence: { kind: 'refund', amountMinor: 4_000, currency: 'USD' },
    });
    const still = await t.db
      .selectFrom('enrollments')
      .select(['status', 'revision'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(still).toEqual({ status: 'confirmed', revision: 2 });
    // Accepting the new consequence commits it, recorded as a fact.
    const done = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'schedule conflict',
      expectedRevision: 2,
      acceptedConsequence: { ...accepted, amountMinor: 4_000 },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({
      status: 'canceled',
      cancellationConsequence: { kind: 'refund', amountMinor: 4_000 },
    });
    refundMinor = null;
  });

  it('SPK-REG-010: a cancellation with no consequence needs no acceptance', async () => {
    const { enrollmentId } = await confirmedEnrollment();
    const done = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      reason: 'changed plans',
      expectedRevision: 2,
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('canceled');
  });

  it('a transfer preview by GET reflects the current offering, never a replayed one', async () => {
    const { kid, enrollmentId } = await confirmedEnrollment(10_000);
    const to = await offering(t, {
      basePriceMinor: 12_000,
      startsOn: '2027-02-01',
      endsOn: '2027-04-30',
    });
    await acknowledge(t, to, kid, parent.personId);
    const pools = () =>
      t.db
        .selectFrom('capacity_pools')
        .select('id')
        .where('offering_id', '=', to.offeringId)
        .execute();
    const get = () =>
      t.http
        .get(`/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${to.offeringId}`)
        .set(parent.header);
    const first = await get();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      committed: false,
      proposed: { offeringId: to.offeringId, price: { basePriceMinor: 12_000 } },
      financialConsequence: { kind: 'charge', amountMinor: 2_000 },
      capacity: { required: [expect.objectContaining({ poolId: null, available: 20 })] },
    });
    // Read-only: the target's pools are not created by a preview.
    expect(await pools()).toEqual([]);
    // The deprecated POST preview replays its first answer for the same key.
    const idempotencyKey = key();
    const postPreview = () =>
      t.http
        .post(`/v1/enrollments/${enrollmentId}/transfer`)
        .set(parent.header)
        .set('Idempotency-Key', idempotencyKey)
        .send({ targetOfferingId: to.offeringId, expectedRevision: 2 });
    expect((await postPreview()).body.financialConsequence.amountMinor).toBe(2_000);
    // The target's price changes: the current rule ends and a new one takes effect.
    const changeAt = new Date(t.clock.now().getTime() - 60_000);
    await t.db
      .updateTable('price_rules')
      .set({ effective_to: changeAt })
      .where('id', '=', to.priceRuleId as string)
      .execute();
    await createPriceRuleFixture(t, {
      offeringId: to.offeringId,
      basePriceMinor: 13_500,
      effectiveFrom: changeAt,
    });
    const replayed = await postPreview();
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.body.financialConsequence.amountMinor).toBe(2_000);
    const fresh = await get();
    expect(fresh.body.proposed.price.basePriceMinor).toBe(13_500);
    expect(fresh.body.financialConsequence).toMatchObject({ kind: 'charge', amountMinor: 3_500 });
    // Committing binds to the consequence as it is now.
    const stale = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: 2,
      commit: true,
      acceptedConsequence: { kind: 'charge', amountMinor: 2_000, currency: 'USD' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.code).toBe('CONSEQUENCE_CHANGED');
    // Another family may not preview it (the transfer's own authority, §4.10).
    const outsider = await adult(t);
    const hidden = await t.http
      .get(`/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${to.offeringId}`)
      .set(outsider.header);
    expect(hidden.status).toBe(404);
  });

  it('§4.10 / §4.14: a customer previewing or committing a transfer to an unpublished offering gets NOT_FOUND; staff get the preview', async () => {
    const { enrollmentId } = await confirmedEnrollment(10_000);
    const draft = await createOfferingFixture(t, {
      responsibleManagerPersonId: programManager.personId,
      programId: await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } }),
      kind: 'term',
      capacityUnits: [{ unit: 'seats', limit: 20 }],
      basePriceMinor: 9_000,
      publicationState: 'draft',
    });
    const preview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${draft.offeringId}`)
      .set(parent.header);
    expect(preview.status).toBe(404);
    expect(preview.body.code).toBe('NOT_FOUND');
    // Nothing about the draft (its name, dates, price or capacity) is in the answer.
    expect(JSON.stringify(preview.body)).not.toContain('9000');
    expect(JSON.stringify(preview.body)).not.toContain(draft.offeringId);
    const committed = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: draft.offeringId,
      expectedRevision: 2,
      commit: true,
    });
    expect(committed.status).toBe(404);
    expect(committed.body.code).toBe('NOT_FOUND');
    // The same for an offering that does not exist.
    const unknown = await t.http
      .get(
        `/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=00000000-0000-7000-8000-000000000000`,
      )
      .set(parent.header);
    expect(unknown.status).toBe(404);
    // Staff who transfer registrations see the draft target.
    const desk = await staff(t, ['front_desk']);
    const staffPreview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${draft.offeringId}`)
      .set(desk.header);
    expect(staffPreview.status, JSON.stringify(staffPreview.body)).toBe(200);
    expect(staffPreview.body.proposed).toMatchObject({
      offeringId: draft.offeringId,
      price: { basePriceMinor: 9_000 },
    });
  });

  // -------------------------------------------------------------------------------------------
  // ENR-04
  // -------------------------------------------------------------------------------------------

  async function fullOfferingWithQueue() {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const holder = await adult(t);
    const seated = await child(t, [holder]);
    await acknowledge(t, setup, seated, holder.personId);
    const basket = await basketWith(t, holder, [
      { participantPersonId: seated, offeringId: setup.offeringId },
    ]);
    await post(t, `/v1/baskets/${basket.id}/hold`, holder.header);
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, holder.header);
    const queue: Array<{ id: string; family: Actor; kid: string }> = [];
    for (let i = 0; i < 2; i += 1) {
      const family = await adult(t);
      const kid = await child(t, [family]);
      await acknowledge(t, setup, kid, family.personId);
      const joined = await post(t, '/v1/waitlist-entries', family.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
      });
      expect(joined.status, JSON.stringify(joined.body)).toBe(201);
      queue.push({ id: joined.body.id as string, family, kid });
    }
    return {
      setup,
      holder,
      seatedEnrollmentId: completed.body.lines[0].enrollmentId as string,
      queue,
    };
  }

  it('SPK-REG-008: staff offer the next waiting entry; a later entry is refused', async () => {
    const { setup, holder, seatedEnrollmentId, queue } = await fullOfferingWithQueue();
    // The place comes free; offer generation has not run yet (its event is still queued).
    const cancel = await post(t, `/v1/enrollments/${seatedEnrollmentId}/cancel`, holder.header, {
      reason: 'moved',
      expectedRevision: 2,
    });
    expect(cancel.status).toBe(200);
    const [first, second] = queue as [(typeof queue)[number], (typeof queue)[number]];
    const later = await post(t, `/v1/waitlist-entries/${second.id}/offer`, programManager.header, {
      reason: 'front of the queue left',
    });
    expect(later.status).toBe(400);
    expect(later.body.details).toMatchObject({
      code: 'NOT_NEXT_IN_QUEUE',
      nextWaitlistEntryId: first.id,
    });
    const offered = await post(t, `/v1/waitlist-entries/${first.id}/offer`, programManager.header, {
      reason: 'front of the queue',
      expectedRevision: 1,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    expect(offered.body).toMatchObject({ status: 'offered', offerCount: 1 });
    expect(offered.body.offers).toEqual([expect.objectContaining({ status: 'offered' })]);
    // The offer holds the place: the pool counts it, and the queued generator finds nothing free.
    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['capacity', 'committed', 'held'])
      .where('offering_id', '=', setup.offeringId)
      .executeTakeFirstOrThrow();
    expect(pool).toEqual({ capacity: 1, committed: 0, held: 1 });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'details'])
      .where('action', '=', 'enrollment.make_waitlist_offer')
      .where('target_id', '=', offered.body.offers[0].id as string)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ reason: 'front of the queue', details: { issuedBy: 'staff' } });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'enrollment.waitlist_offer_made')
      .where('aggregate_id', '=', offered.body.offers[0].id as string)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      waitlistEntryId: first.id,
      participantPersonId: first.kid,
    });
    // An offered entry cannot be offered again; a customer cannot offer at all.
    const again = await post(t, `/v1/waitlist-entries/${first.id}/offer`, programManager.header, {
      reason: 'again',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const byParent = await post(
      t,
      `/v1/waitlist-entries/${second.id}/offer`,
      second.family.header,
      {
        reason: 'me please',
      },
    );
    expect(byParent.status).toBe(403);
  });

  it('SPK-REG-008 / §4.7 invariant 3: no free capacity answers CAPACITY_UNAVAILABLE', async () => {
    const { setup, queue } = await fullOfferingWithQueue();
    const first = queue[0] as (typeof queue)[number];
    const refused = await post(t, `/v1/waitlist-entries/${first.id}/offer`, programManager.header, {
      reason: 'try',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CAPACITY_UNAVAILABLE');
    const offers = await t.db
      .selectFrom('waitlist_offers')
      .select('id')
      .where('waitlist_entry_id', '=', first.id)
      .execute();
    expect(offers).toEqual([]);
    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['committed', 'held'])
      .where('offering_id', '=', setup.offeringId)
      .executeTakeFirstOrThrow();
    expect(pool).toEqual({ committed: 1, held: 0 });
  });

  // -------------------------------------------------------------------------------------------
  // ENR-05
  // -------------------------------------------------------------------------------------------

  it('SPK-REG-002 / SCR-C-08: eligibility is previewed per authorized participant and nothing is held', async () => {
    const family = await adult(t);
    const eligible = await child(t, [family], { dateOfBirth: '2018-04-01' });
    const tooOld = await child(t, [family], { dateOfBirth: '2005-04-01' });
    const unknownAge = await createPersonFixture(t, { kind: 'child', dateOfBirth: null });
    await createRelationshipFixture(t, {
      actorPersonId: family.personId,
      subjectPersonId: unknownAge,
    });
    const stranger = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2018-04-01' });
    const setup = await offering(t, { basePriceMinor: 9_000 });
    await acknowledge(t, setup, eligible, family.personId);
    const counts = async () => ({
      applications: (await t.db.selectFrom('applications').select('id').execute()).length,
      baskets: (await t.db.selectFrom('baskets').select('id').execute()).length,
      holds: (await t.db.selectFrom('holds').select('id').execute()).length,
    });
    const before = await counts();
    const ids = [eligible, tooOld, unknownAge, stranger].join(',');
    const res = await t.http
      .get(`/v1/offerings/${setup.offeringId}/registration-options?participantPersonIds=${ids}`)
      .set(family.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.availableIntents).toEqual(['individual_league', 'youth', 'makeup']);
    const byPerson = new Map(
      (
        res.body.participants as Array<{
          personId: string;
          intents: Array<{
            intent: string;
            eligibility: { eligible: boolean; reasons: Array<{ code: string; severity: string }> };
          }>;
        }>
      ).map((p) => [p.personId, p.intents]),
    );
    // The stranger is omitted, never reported.
    expect([...byPerson.keys()].sort()).toEqual([eligible, tooOld, unknownAge].sort());
    const youth = (id: string) => byPerson.get(id)?.find((i) => i.intent === 'youth')?.eligibility;
    expect(youth(eligible)).toMatchObject({ eligible: true });
    expect(youth(tooOld)?.eligible).toBe(false);
    expect(youth(tooOld)?.reasons.map((r) => r.code)).toContain('above_maximum_age');
    // Unknown evidence stays unknown, never a pass.
    expect(youth(unknownAge)?.eligible).toBe(false);
    expect(youth(unknownAge)?.reasons).toContainEqual(
      expect.objectContaining({ code: 'date_of_birth_unknown', severity: 'unknown' }),
    );
    expect(await counts()).toEqual(before);
    // Staff with the apply roles may name anyone.
    const desk = await staff(t, ['front_desk']);
    const assisted = await t.http
      .get(
        `/v1/offerings/${setup.offeringId}/registration-options?participantPersonIds=${stranger}`,
      )
      .set(desk.header);
    expect(assisted.body.participants.map((p: { personId: string }) => p.personId)).toEqual([
      stranger,
    ]);
  });

  it('SPK-REG-001 / SPK-PLACE-001: availableIntents match INTENT_OFFERING_KINDS for the offering kind, with the season link', async () => {
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const league = await offering(t, { kind: 'season', programId: program });
    const season = await createSeasonFixture(t, { registrationOfferingRef: league.offeringId });
    const res = await t.http
      .get(`/v1/offerings/${league.offeringId}/registration-options`)
      .set(parent.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      offeringId: league.offeringId,
      availableIntents: ['individual_league', 'join_team', 'create_team_entry', 'youth'],
      seasonId: season.seasonId,
      participants: [],
    });
    const pickup = await offering(t, { kind: 'pickup', programId: program });
    const pickupOptions = await t.http
      .get(`/v1/offerings/${pickup.offeringId}/registration-options`)
      .set(parent.header);
    expect(pickupOptions.body).toMatchObject({ availableIntents: ['pickup'], seasonId: null });
    // A draft offering is not shown to customers (protected NOT_FOUND); staff see it.
    const managerId = (await staff(t, ['program_manager'])).personId;
    const draft = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      programId: program,
      publicationState: 'draft',
    });
    expect(
      (
        await t.http
          .get(`/v1/offerings/${draft.offeringId}/registration-options`)
          .set(parent.header)
      ).status,
    ).toBe(404);
    expect(
      (
        await t.http
          .get(`/v1/offerings/${draft.offeringId}/registration-options`)
          .set(programManager.header)
      ).status,
    ).toBe(200);
  });

  // -------------------------------------------------------------------------------------------
  // ENR-06
  // -------------------------------------------------------------------------------------------

  it('SPK-UX-001: an enrollment pending payment names the checkout operation', async () => {
    const setup = await offering(t, { basePriceMinor: 11_000 });
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header);
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    const operations = t.app.get(OperationsService);
    const baskets = t.app.get<BasketPort>(BASKET_PORT);
    const checkoutOperation = await t.app.get(UnitOfWork).run(async ({ trx }) => {
      const operationId = await operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'finance.registration_checkout',
        requestedBy: finance,
        status: 'running',
      });
      await baskets.startCheckout(
        trx,
        t.organizationId,
        basket.id,
        'order-1',
        finance,
        operationId,
      );
      return operationId;
    });
    const pending = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(pending.body).toMatchObject({
      status: 'pending',
      pendingReason: 'payment',
      lastOperationId: checkoutOperation,
    });
    // Compensation names its own operation on the enrollment it cancels.
    const compensation = await t.app.get(UnitOfWork).run(async ({ trx }) => {
      const operationId = await operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'finance.compensate_checkout',
        requestedBy: finance,
        status: 'running',
      });
      await baskets.finishCheckout(
        trx,
        t.organizationId,
        basket.id,
        'abandoned',
        finance,
        operationId,
      );
      return operationId;
    });
    const ended = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(ended.body).toMatchObject({ status: 'canceled', lastOperationId: compensation });
    // A caller that passes no operation keeps the earlier behaviour.
    const other = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: await child(t, [parent]),
      status: 'pending',
    });
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get<EnrollmentPort>(ENROLLMENT_PORT)
          .failConfirmation(trx, t.organizationId, other, 'payment_failed', finance),
      );
    const failed = await t.db
      .selectFrom('enrollments')
      .select(['status', 'last_operation_id'])
      .where('id', '=', other)
      .executeTakeFirstOrThrow();
    expect(failed).toEqual({ status: 'canceled', last_operation_id: null });
  });
});
