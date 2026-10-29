import { DomainError, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { BASKET_PORT, type BasketPort } from '../enrollment.ports';
import {
  AssessmentMachine,
  BookingMachine,
  PackageEntitlementMachine,
} from '../enrollment.state-machines';
import { membershipOffering, packageOffering } from './package-g-support';
import { acknowledge, adult, enrollmentTestApp, offering, post, type Actor } from './support';

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
