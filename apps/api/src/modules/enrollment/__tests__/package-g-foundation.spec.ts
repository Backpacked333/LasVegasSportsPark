import { DomainError, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { BASKET_PORT, type BasketPort } from '../enrollment.ports';
import { BasketsService } from '../services/baskets.service';
import { RegistrationEvaluator } from '../services/registration-evaluator';
import {
  AssessmentMachine,
  BookingMachine,
  PackageEntitlementMachine,
} from '../enrollment.state-machines';
import { definitionWithScope, membershipOffering, packageOffering } from './package-g-support';
import {
  acknowledge,
  adult,
  drain,
  enrollmentTestApp,
  offering,
  post,
  type Actor,
} from './support';

/** ENR-10: Package G intents, module-local machines and capability gates (DEC-016). */
describe('Package G enrollment foundation (ENR-10)', () => {
  let t: TestApp;
  let buyer: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: [] });
    buyer = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function openBasket(actor: Actor) {
    const created = await post(t, '/v1/baskets', actor.header, {
      ownerPersonId: actor.personId,
      fulfillmentMode: 'all_or_nothing',
      acceptPartialFulfillment: false,
    });
    expect(created.status).toBe(201);
    return created.body as { id: string; revision: number };
  }

  it('SPK-COND-003: a plain rental_request or party_request basket line is refused with BOOKING_REQUIRED', async () => {
    await t.enableCapability('rentals');
    await t.enableCapability('parties');
    const rental = await offering(t, {
      kind: 'rental',
      basePriceMinor: 5_000,
      ageBand: { minAgeYears: 18 },
    });
    const basket = await openBasket(buyer);
    for (const intent of ['rental_request', 'party_request']) {
      const refused = await post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
        participantPersonId: buyer.personId,
        offeringId: rental.offeringId,
        intent,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.details.code).toBe('BOOKING_REQUIRED');
    }
    const lines = await t.db
      .selectFrom('basket_lines')
      .select('id')
      .where('basket_id', '=', basket.id)
      .execute();
    expect(lines).toEqual([]);
    await t.disableCapability('rentals');
    await t.disableCapability('parties');
  });

  it('DEC-016: adding a membership line while memberships is disabled answers CAPABILITY_DISABLED; releasing an existing line still works', async () => {
    const membership = await membershipOffering(t, {
      attendance: { mode: 'none' },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: null },
    });
    await acknowledge(t, membership, buyer.personId, buyer.personId);
    const basket = await openBasket(buyer);
    const refused = await post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
      participantPersonId: buyer.personId,
      offeringId: membership.offeringId,
      intent: 'membership',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'memberships',
    });

    await t.enableCapability('memberships');
    const twice = await post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
      participantPersonId: buyer.personId,
      offeringId: membership.offeringId,
      intent: 'membership',
      quantity: 2,
    });
    expect(twice.status).toBe(400);
    expect(twice.body.details.code).toBe('QUANTITY_ONE');
    const added = await post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
      participantPersonId: buyer.personId,
      offeringId: membership.offeringId,
      intent: 'membership',
    });
    expect(added.status).toBe(201);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, buyer.header, {
      expectedRevision: added.body.revision,
    });
    expect(held.status).toBe(200);

    // Disabling stops new sales; releasing what is already held never checks the switch.
    await t.disableCapability('memberships');
    const released = await post(t, `/v1/baskets/${basket.id}/release`, buyer.header, {
      reason: 'changed my mind',
    });
    expect(released.status).toBe(200);
    expect(released.body.status).toBe('released');
  });

  it('DEC-016: checkout of a held package line after session_packages was disabled is refused before any payment attempt', async () => {
    await t.enableCapability('session_packages');
    const pack = await packageOffering(t, {
      credits: 5,
      appliesTo: { programIds: [] as string[], offeringIds: [crypto.randomUUID()] },
      basePriceMinor: 8_000,
    });
    await acknowledge(t, pack, buyer.personId, buyer.personId);
    const basket = await openBasket(buyer);
    const added = await post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
      participantPersonId: buyer.personId,
      offeringId: pack.offeringId,
      intent: 'package_purchase',
    });
    expect(added.status).toBe(201);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, buyer.header, {
      expectedRevision: added.body.revision,
    });
    expect(held.status).toBe(200);
    expect(held.body.status).toBe('held');

    await t.disableCapability('session_packages');
    const port = t.app.get<BasketPort>(BASKET_PORT);
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    const uow = t.app.get(UnitOfWork);
    const refusal = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return error;
      }
      throw new Error('expected a refusal');
    };
    for (const attempt of [
      () => uow.run(({ trx }) => port.assertPaymentPermitted(trx, t.organizationId, basket.id)),
      () =>
        uow.run(({ trx }) =>
          port.startCheckout(trx, t.organizationId, basket.id, 'order-pkg', finance),
        ),
    ]) {
      const error = await refusal(attempt);
      expect(DomainError.is(error)).toBe(true);
      expect((error as DomainError).code).toBe('ACCESS_DENIED');
      expect((error as DomainError).details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'session_packages',
      });
    }
    // Nothing moved toward payment: the basket is still held and its enrollment pending.
    const basketRow = await t.db
      .selectFrom('baskets')
      .select(['status', 'order_ref'])
      .where('id', '=', basket.id)
      .executeTakeFirstOrThrow();
    expect(basketRow).toEqual({ status: 'held', order_ref: null });
    // The customer may still release it.
    const released = await post(t, `/v1/baskets/${basket.id}/release`, buyer.header, {
      reason: 'no longer sold',
    });
    expect(released.status).toBe(200);
  });

  it('DEC-016, DEC-082: booking a pickup session needs pickup_sessions; cancelling it never does', async () => {
    const pickup = await offering(t, {
      kind: 'pickup',
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 4 }],
      ageBand: { minAgeYears: 18 },
    });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: pickup.offeringId,
      scheduledStart: new Date('2026-11-20T02:00:00Z'),
      scheduledEnd: new Date('2026-11-20T03:00:00Z'),
    });
    await acknowledge(t, pickup, buyer.personId, buyer.personId);
    const book = () =>
      post(t, '/v1/session-bookings', buyer.header, {
        offeringId: pickup.offeringId,
        sessionId,
        participantPersonId: buyer.personId,
      });
    const refused = await book();
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'pickup_sessions',
    });
    await t.enableCapability('pickup_sessions');
    const booked = await book();
    expect(booked.status).toBe(201);
    await t.disableCapability('pickup_sessions');
    const canceled = await post(
      t,
      `/v1/session-bookings/${booked.body.id as string}/cancel`,
      buyer.header,
      { expectedRevision: booked.body.revision, reason: 'cannot come' },
    );
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
  });

  it('CAPABILITIES-03 / DEC-072: a membership waitlist is not joined, and its offer opens and holds no line, while memberships is off', async () => {
    await t.enableCapability('memberships');
    const membership = await offering(t, {
      kind: 'membership',
      entitlementDefinitionId: await definitionWithScope(t, 'membership_benefit', {
        attendance: { mode: 'none' },
        term: { kind: 'offering_dates' },
        renewal: { noticeLeadDays: null },
      }),
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
      ageBand: { minAgeYears: 18 },
    });
    const holder = await adult(t);
    const waiter = await adult(t);
    const late = await adult(t);
    for (const actor of [holder, waiter, late]) {
      await acknowledge(t, membership, actor.personId, actor.personId);
    }
    // The only place is held in the holder's basket; the waiter queues for it.
    const basket = await openBasket(holder);
    const line = await post(t, `/v1/baskets/${basket.id}/lines`, holder.header, {
      participantPersonId: holder.personId,
      offeringId: membership.offeringId,
      intent: 'membership',
    });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, holder.header, {})).status).toBe(200);
    const join = (actor: Actor) =>
      post(t, '/v1/waitlist-entries', actor.header, {
        offeringId: membership.offeringId,
        participantPersonId: actor.personId,
        intent: 'membership',
      });
    const entry = await join(waiter);
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    // The place comes back and is offered while the switch is on.
    expect(
      (await post(t, `/v1/baskets/${basket.id}/release`, holder.header, { reason: 'changed mind' }))
        .status,
    ).toBe(200);
    await drain(t);
    const offered = await t.http
      .get(`/v1/waitlist-entries/${entry.body.id as string}`)
      .set(waiter.header);
    expect(offered.body.status).toBe('offered');
    const offer = offered.body.offers[0] as { id: string; revision: number };

    await t.disableCapability('memberships');
    try {
      const refusedJoin = await join(late);
      expect(refusedJoin.status).toBe(403);
      expect(refusedJoin.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'memberships',
      });
      const refused = await post(t, `/v1/waitlist-offers/${offer.id}/accept`, waiter.header, {
        expectedRevision: offer.revision,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'memberships',
      });
      // No basket, line or application was opened for the waiter, and the offer keeps its place.
      expect(
        await t.db
          .selectFrom('baskets')
          .select('id')
          .where('owner_person_id', '=', waiter.personId)
          .execute(),
      ).toEqual([]);
      expect(
        await t.db
          .selectFrom('applications')
          .select('id')
          .where('participant_person_id', '=', waiter.personId)
          .execute(),
      ).toEqual([]);
      const still = await t.http.get(`/v1/waitlist-offers/${offer.id}`).set(waiter.header);
      expect(still.body.status).toBe('offered');
      // Declining (never gated) still works.
      const declined = await post(t, `/v1/waitlist-offers/${offer.id}/decline`, waiter.header, {
        expectedRevision: offer.revision,
      });
      expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    } finally {
      await t.disableCapability('memberships');
    }
  });

  it('CAPABILITIES-03 / CAPABILITIES-04: every caller of openForLine and holdOpenedBasket gets the line checks', async () => {
    const baskets = t.app.get(BasketsService);
    const evaluator = t.app.get(RegistrationEvaluator);
    const uow = t.app.get(UnitOfWork);
    const actor = systemPrincipal(t.organizationId, 'test.caller');
    const membership = await membershipOffering(t, {
      attendance: { mode: 'none' },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: null },
    });
    const rental = await offering(t, { kind: 'rental', basePriceMinor: 5_000 });
    const open = (offeringId: string, intent: 'membership' | 'rental_request' | 'pickup') =>
      uow.run(async ({ trx }) => {
        const person = await evaluator.participant(trx, t.organizationId, buyer.personId);
        const snapshot = await evaluator.snapshot(trx, t.organizationId, offeringId);
        const evaluation = await evaluator.evaluate(trx, t.organizationId, {
          snapshot,
          person,
          intent,
        });
        return baskets.openForLine(trx, t.organizationId, {
          owner: person,
          payerPersonId: person.id,
          actor,
          participant: person,
          snapshot,
          intent,
          sessionId: null,
          evaluation,
          applicationId: null,
          correlationId: null,
        });
      });
    const codeOf = async (work: Promise<unknown>) => {
      try {
        await work;
        return 'opened';
      } catch (error) {
        if (!DomainError.is(error)) throw error;
        return (error.details as { code?: string } | undefined)?.code ?? error.code;
      }
    };
    // A rental line exists only with its booking, whichever switch is on.
    await t.enableCapability('rentals');
    expect(await codeOf(open(rental.offeringId, 'rental_request'))).toBe('BOOKING_REQUIRED');
    await t.disableCapability('rentals');
    // A session intent is never a basket line.
    expect(await codeOf(open(membership.offeringId, 'pickup'))).toBe('VALIDATION_FAILED');
    // A membership line is opened only while memberships is on ...
    expect(await codeOf(open(membership.offeringId, 'membership'))).toBe('CAPABILITY_DISABLED');
    await t.enableCapability('memberships');
    const opened = await open(membership.offeringId, 'membership');
    // ... and held only while it still is.
    await t.disableCapability('memberships');
    const hold = uow.run(({ trx }) =>
      baskets.holdOpenedBasket(
        trx,
        t.organizationId,
        opened.basket,
        opened.lineId,
        actor,
        [],
        new Date(t.clock.now().getTime() + 600_000),
        null,
      ),
    );
    expect(await codeOf(hold)).toBe('CAPABILITY_DISABLED');
    const line = await t.db
      .selectFrom('basket_lines')
      .select(['outcome', 'enrollment_id'])
      .where('id', '=', opened.lineId)
      .executeTakeFirstOrThrow();
    expect(line).toEqual({ outcome: 'pending', enrollment_id: null });
  });

  it('§4.6: the module-local Package G machines refuse transitions they do not define', () => {
    expect(PackageEntitlementMachine.next('active', 'redeem_last')).toBe('exhausted');
    expect(PackageEntitlementMachine.next('exhausted', 'reverse')).toBe('active');
    expect(() => PackageEntitlementMachine.next('expired', 'reverse')).toThrow();
    expect(BookingMachine.next('held', 'pay_uncovered')).toBe('awaiting_staff');
    expect(BookingMachine.next('awaiting_staff', 'cover')).toBe('confirmed');
    // Never confirmed straight from requested: approval reserves first (DEC-029, POL-005).
    expect(BookingMachine.can('requested', 'pay_covered')).toBe(false);
    expect(AssessmentMachine.next('submitted', 'approve_family')).toBe('published');
    expect(AssessmentMachine.can('published', 'withdraw')).toBe(false);
  });
});
