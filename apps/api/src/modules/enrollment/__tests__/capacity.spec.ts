import { systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { CatalogEvents, createProgramFixture } from '../../catalog';
import {
  BASKET_PORT,
  CAPACITY_PORT,
  ENROLLMENT_PORT,
  WAITLIST_PORT,
  type BasketPort,
  type CapacityPort,
  type EnrollmentPort,
  type WaitlistPort,
} from '../enrollment.ports';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
} from './support';

const MINUTE = 60_000;

describe('capacity, holds, waitlists and transfers (SPK-REG-005/006/008/010, SPK-AT-005/006, SPK-YOUTH-002)', () => {
  let t: TestApp;
  let parent: Actor;
  let programManager: Actor;
  let uow: UnitOfWork;
  let enrollmentPort: EnrollmentPort;
  let basketPort: BasketPort;
  const finance = () => systemPrincipal(t.organizationId, 'finance.checkout');
  const programManagerPrincipal = () => systemPrincipal(t.organizationId, 'staff.desk');

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    programManager = await staff(t, ['program_manager']);
    uow = t.app.get(UnitOfWork);
    enrollmentPort = t.app.get(ENROLLMENT_PORT);
    basketPort = t.app.get(BASKET_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  const pool = (offeringId: string) =>
    t.db
      .selectFrom('capacity_pools')
      .selectAll()
      .where('offering_id', '=', offeringId)
      .where('scope_type', '=', 'offering')
      .orderBy('constraint_kind')
      .execute();

  async function heldBasketFor(
    owner: Actor,
    offeringId: string,
    setup: Parameters<typeof acknowledge>[1],
  ) {
    const kid = await child(t, [owner]);
    await acknowledge(t, setup, kid, owner.personId);
    const basket = await basketWith(t, owner, [{ participantPersonId: kid, offeringId }]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, owner.header, {});
    return { kid, basket, held };
  }

  it('SPK-AT-005: fifty concurrent holds on the final place yield exactly one active hold', async () => {
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const setup = await offering(t, {
      programId: program,
      kind: 'season',
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const contenders: Array<{ actor: Actor; basketId: string }> = [];
    for (let i = 0; i < 50; i += 1) {
      const actor = await adult(t);
      await acknowledge(t, setup, actor.personId, actor.personId);
      const basket = await basketWith(t, actor, [
        {
          participantPersonId: actor.personId,
          offeringId: setup.offeringId,
          intent: 'individual_league',
        },
      ]);
      contenders.push({ actor, basketId: basket.id });
    }
    const results = await Promise.all(
      contenders.map(({ actor, basketId }) =>
        post(t, `/v1/baskets/${basketId}/hold`, actor.header, {}),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'CAPACITY_UNAVAILABLE'),
    ).toBe(true);
    const [seats] = await pool(setup.offeringId);
    expect(seats).toMatchObject({ capacity: 1, held: 1, committed: 0 });
    const active = await t.db
      .selectFrom('holds')
      .select('id')
      .where('pool_id', '=', seats!.id)
      .where('status', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('offering_id', '=', setup.offeringId)
        .execute(),
    ).toHaveLength(1);
  });

  it('SPK-REG-006: the server-owned hold expires through the outbox timer with one terminal outcome', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const { basket, held } = await heldBasketFor(parent, setup.offeringId, setup);
    expect(held.status).toBe(200);
    const holdId = held.body.holds[0].id as string;
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    // The client countdown is informational: nothing happens before the server-owned expiry.
    t.clock.advance(9 * MINUTE);
    await drain(t);
    expect(
      (
        await t.db
          .selectFrom('holds')
          .select('status')
          .where('id', '=', holdId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
    t.clock.advance(MINUTE + 1000);
    await drain(t);
    const hold = await t.db
      .selectFrom('holds')
      .selectAll()
      .where('id', '=', holdId)
      .executeTakeFirstOrThrow();
    expect(hold).toMatchObject({ status: 'expired', committed_at: null, released_at: null });
    expect(hold.expired_at).not.toBeNull();
    const [seats] = await pool(setup.offeringId);
    expect(seats).toMatchObject({ held: 0, committed: 0 });
    expect((await t.http.get(`/v1/baskets/${basket.id}`).set(parent.header)).body.status).toBe(
      'expired',
    );
    expect(
      (await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header)).body.status,
    ).toBe('canceled');
    // A late commit finds no active hold and writes nothing.
    await expect(
      uow.run(({ trx }) => enrollmentPort.commitHolds(trx, t.organizationId, [holdId])),
    ).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
    });
    // Replaying the timer changes nothing (one terminal outcome).
    await drain(t);
    expect(
      (
        await t.db
          .selectFrom('holds')
          .select('revision')
          .where('id', '=', holdId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(hold.revision);
  });

  it('EnrollmentPort.commitHolds converts active holds to allocations atomically, once', async () => {
    const setup = await offering(t);
    const { held } = await heldBasketFor(parent, setup.offeringId, setup);
    const holdId = held.body.holds[0].id as string;
    const committed = await uow.run(({ trx }) =>
      enrollmentPort.commitHolds(trx, t.organizationId, [holdId]),
    );
    expect(committed).toEqual([expect.objectContaining({ id: holdId, status: 'committed' })]);
    const allocation = await t.db
      .selectFrom('allocations')
      .selectAll()
      .where('hold_id', '=', holdId)
      .executeTakeFirstOrThrow();
    expect(allocation).toMatchObject({
      enrollment_id: held.body.lines[0].enrollmentId,
      status: 'active',
      quantity: 1,
    });
    const [seats] = await pool(setup.offeringId);
    expect(seats).toMatchObject({ held: 0, committed: 1 });
    await expect(
      uow.run(({ trx }) => enrollmentPort.commitHolds(trx, t.organizationId, [holdId])),
    ).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
    });
    expect(
      await t.db.selectFrom('allocations').select('id').where('hold_id', '=', holdId).execute(),
    ).toHaveLength(1);
  });

  it('§4.11 ports: finance reads the basket with price and policy basis; capacity and waitlist ports answer per organization', async () => {
    const capacityPort = t.app.get<CapacityPort>(CAPACITY_PORT);
    const waitlistPort = t.app.get<WaitlistPort>(WAITLIST_PORT);
    const setup = await offering(t, {
      basePriceMinor: 18_000,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const { basket, held } = await heldBasketFor(parent, setup.offeringId, setup);
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    const forFinance = await basketPort.getBasket(t.organizationId, basket.id);
    expect(forFinance).toMatchObject({
      status: 'held',
      payerPersonId: parent.personId,
      currency: 'USD',
      subtotalMinor: 18_000,
      approvalPending: false,
    });
    expect(forFinance!.lines[0]).toMatchObject({
      enrollmentId,
      price: { basePriceMinor: 18_000, currency: 'USD' },
      policies: { requiredFormPolicyVersionIds: [setup.formPolicyVersionId] },
    });
    const holds = await enrollmentPort.holdsForBasket(t.organizationId, basket.id);
    expect(holds).toEqual([expect.objectContaining({ status: 'active', basketId: basket.id })]);
    expect(await enrollmentPort.getEnrollment(t.organizationId, enrollmentId)).toMatchObject({
      status: 'pending',
      basketId: basket.id,
    });
    // Organization scope: another organization's id answers nothing.
    const other = await seedOrganization(t.db);
    expect(await enrollmentPort.getEnrollment(other.organizationId, enrollmentId)).toBeNull();
    expect(await basketPort.getBasket(other.organizationId, basket.id)).toBeNull();
    const [seats] = await capacityPort.poolsForOffering(t.organizationId, setup.offeringId);
    expect(seats).toMatchObject({ capacity: 1, held: 1, committed: 0, available: 0 });
    expect(await capacityPort.getPool(other.organizationId, seats!.id)).toBeNull();
    // A full pool refuses a hold through the port too (§4.7 invariant 3), writing nothing.
    await expect(
      uow.run(({ trx }) =>
        capacityPort.acquireHolds(trx, t.organizationId, {
          pools: [{ poolId: seats!.id, quantity: 1 }],
          ownerKind: 'staff',
          ownerId: null,
          actor: programManagerPrincipal(),
          expiresAt: new Date(t.clock.now().getTime() + 5 * MINUTE),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE', details: { available: 0 } });
    // Releasing through the port frees the place exactly once.
    const released = await uow.run(({ trx }) =>
      capacityPort.releaseHold(trx, t.organizationId, holds[0]!.id, 'desk', finance()),
    );
    expect(released).toMatchObject({ status: 'released', releaseReason: 'desk' });
    const again = await uow.run(({ trx }) =>
      capacityPort.releaseHold(trx, t.organizationId, holds[0]!.id, 'desk', finance()),
    );
    expect(again.revision).toBe(released.revision);
    expect((await capacityPort.getPool(t.organizationId, seats!.id))!.available).toBe(1);
    // No one waits: offering from the pool makes nothing, and repeating it is harmless.
    expect(
      await uow.run(({ trx }) =>
        waitlistPort.offerFromPool(trx, t.organizationId, seats!.id, null),
      ),
    ).toEqual([]);
    expect(await waitlistPort.entriesForPool(t.organizationId, seats!.id)).toEqual([]);
  });

  it('SPK-AT-006: a payment after hold expiry never displaces a valid waitlist offer', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const late = await heldBasketFor(parent, setup.offeringId, setup);
    expect(late.held.status).toBe(200);
    const lateEnrollmentId = late.held.body.lines[0].enrollmentId as string;
    await uow.run(({ trx }) =>
      basketPort.startCheckout(trx, t.organizationId, late.basket.id, 'order-late', finance()),
    );
    // Another family waits for the place.
    const waiting = await adult(t);
    const waitingKid = await child(t, [waiting]);
    await acknowledge(t, setup, waitingKid, waiting.personId);
    const joined = await post(t, '/v1/waitlist-entries', waiting.header, {
      offeringId: setup.offeringId,
      participantPersonId: waitingKid,
      intent: 'youth',
    });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({
      status: 'waiting',
      position: 1,
      priorityBasis: 'joined_at',
    });
    // The checkout's hold expires; the freed place is offered to the waitlist with its own hold.
    t.clock.advance(11 * MINUTE);
    await drain(t);
    const entry = await t.http
      .get(`/v1/waitlist-entries/${joined.body.id as string}`)
      .set(waiting.header);
    expect(entry.body.status).toBe('offered');
    const offer = entry.body.offers[0];
    expect(offer).toMatchObject({ status: 'offered' });
    const [seats] = await pool(setup.offeringId);
    expect(seats).toMatchObject({ held: 1, committed: 0 });
    // The late payment arrives: the enrollment cannot take the place the offer reserves.
    await expect(
      uow.run(({ trx }) =>
        enrollmentPort.confirmEnrollment(trx, t.organizationId, lateEnrollmentId, {
          actor: finance(),
          orderRef: 'order-late',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', lateEnrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('pending');
    // Finance compensates (received money + incomplete fulfillment stays visible on its side).
    await uow.run(({ trx }) =>
      enrollmentPort.failConfirmation(
        trx,
        t.organizationId,
        lateEnrollmentId,
        'payment_after_expiry',
        finance(),
      ),
    );
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', lateEnrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('canceled');
    // The waiting family accepts: the offer is consumed exactly once.
    const accepted = await post(
      t,
      `/v1/waitlist-offers/${offer.id as string}/accept`,
      waiting.header,
      {},
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.offer.status).toBe('accepted');
    expect(accepted.body.entry.status).toBe('accepted');
    expect(accepted.body.basket).toMatchObject({ status: 'held', ownerPersonId: waiting.personId });
    expect(accepted.body.basket.holds.map((h: { id: string }) => h.id)).toEqual([offer.holdId]);
    const twice = await post(
      t,
      `/v1/waitlist-offers/${offer.id as string}/accept`,
      waiting.header,
      {},
    );
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
    expect(await pool(setup.offeringId)).toEqual([
      expect.objectContaining({ held: 1, committed: 0 }),
    ]);
  });

  it('SPK-AT-006: with no waitlist the late payment is a tracked valid fulfillment (place re-acquired)', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const late = await heldBasketFor(parent, setup.offeringId, setup);
    const enrollmentId = late.held.body.lines[0].enrollmentId as string;
    await uow.run(({ trx }) =>
      basketPort.startCheckout(trx, t.organizationId, late.basket.id, 'order-ok', finance()),
    );
    t.clock.advance(11 * MINUTE);
    await drain(t);
    const confirmed = await uow.run(({ trx }) =>
      enrollmentPort.confirmEnrollment(trx, t.organizationId, enrollmentId, {
        actor: finance(),
        orderRef: 'order-ok',
      }),
    );
    expect(confirmed).toMatchObject({ status: 'confirmed', orderRef: 'order-ok' });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', enrollmentId)
      .where('action', '=', 'enrollment.confirm')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ reacquired: true });
    expect(await pool(setup.offeringId)).toEqual([
      expect.objectContaining({ held: 0, committed: 1 }),
    ]);
  });

  it('SPK-AT-006 / SPK-REG-006: a lapsed hold never commits, even before its timer runs, and the waitlist comes first', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const late = await heldBasketFor(parent, setup.offeringId, setup);
    const holdId = late.held.body.holds[0].id as string;
    const enrollmentId = late.held.body.lines[0].enrollmentId as string;
    await uow.run(({ trx }) =>
      basketPort.startCheckout(trx, t.organizationId, late.basket.id, 'order-lapsed', finance()),
    );
    const waiting = await adult(t);
    const waitingKid = await child(t, [waiting]);
    await acknowledge(t, setup, waitingKid, waiting.personId);
    const joined = await post(t, '/v1/waitlist-entries', waiting.header, {
      offeringId: setup.offeringId,
      participantPersonId: waitingKid,
      intent: 'youth',
    });
    expect(joined.status).toBe(201);
    // The server-owned expiry passes; the worker has not run the timer yet.
    t.clock.advance(10 * MINUTE + 1000);
    await expect(
      uow.run(({ trx }) => enrollmentPort.commitHolds(trx, t.organizationId, [holdId])),
    ).rejects.toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { holdId, status: 'expired' },
    });
    // The late payment cannot take the freed place while a family waits (no offer exists yet).
    await expect(
      uow.run(({ trx }) =>
        enrollmentPort.confirmEnrollment(trx, t.organizationId, enrollmentId, {
          actor: finance(),
          orderRef: 'order-lapsed',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE', details: { waitlistFirst: true } });
    // Nothing was written by the refused commands.
    const hold = await t.db
      .selectFrom('holds')
      .select(['status', 'revision'])
      .where('id', '=', holdId)
      .executeTakeFirstOrThrow();
    expect(hold).toEqual({ status: 'active', revision: 1 });
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', enrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('pending');
    // The timer runs: the hold expires (its one terminal outcome) and the waiting family is offered.
    await drain(t);
    expect(
      (
        await t.db
          .selectFrom('holds')
          .select('status')
          .where('id', '=', holdId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('expired');
    const entry = await t.http
      .get(`/v1/waitlist-entries/${joined.body.id as string}`)
      .set(waiting.header);
    expect(entry.body.status).toBe('offered');
  });

  it('SPK-REG-008: staff remove a waitlist entry with a reason; its offer is declined and the place moves on', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const holder = await heldBasketFor(parent, setup.offeringId, setup);
    const families = [await adult(t), await adult(t)];
    const entries: string[] = [];
    for (const family of families) {
      const kid = await child(t, [family]);
      await acknowledge(t, setup, kid, family.personId);
      const joined = await post(t, '/v1/waitlist-entries', family.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
      });
      expect(joined.status).toBe(201);
      entries.push(joined.body.id as string);
      t.clock.advance(1000);
    }
    await post(t, `/v1/baskets/${holder.basket.id}/release`, parent.header, { reason: 'moved' });
    await drain(t);
    const first = entries[0]!;
    expect(
      (await t.http.get(`/v1/waitlist-entries/${first}`).set(families[0]!.header)).body.status,
    ).toBe('offered');
    // Another household learns nothing; the family itself may read but not remove (staff only).
    const stranger = await adult(t);
    expect(
      (await post(t, `/v1/waitlist-entries/${first}/remove`, stranger.header, { reason: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (
        await post(t, `/v1/waitlist-entries/${first}/remove`, families[0]!.header, {
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    expect(
      (await post(t, `/v1/waitlist-entries/${first}/remove`, programManager.header, {})).status,
    ).toBe(400);
    const removed = await post(t, `/v1/waitlist-entries/${first}/remove`, programManager.header, {
      reason: 'Registered in another group',
    });
    expect(removed.status).toBe(200);
    expect(removed.body.status).toBe('removed');
    expect(removed.body.offers.map((o: { status: string }) => o.status)).toEqual(['declined']);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('reason')
      .where('target_id', '=', first)
      .where('action', '=', 'enrollment.remove_waitlist_entry')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Registered in another group');
    await drain(t);
    expect(
      (await t.http.get(`/v1/waitlist-entries/${entries[1]!}`).set(families[1]!.header)).body
        .status,
    ).toBe('offered');
  });

  it('SPK-REG-010 / DEC-006: a transfer preview shows the waitlist ahead and the commit never skips it', async () => {
    const from = await offering(t, { basePriceMinor: 0 });
    const to = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, from, kid, parent.personId);
    await acknowledge(t, to, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: from.offeringId },
    ]);
    await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    // The target is full; another family joins its waitlist, then the place frees up (the offer
    // handler has not run yet).
    const occupant = await adult(t);
    const occupied = await heldBasketFor(occupant, to.offeringId, to);
    const waiting = await adult(t);
    const waitingKid = await child(t, [waiting]);
    await acknowledge(t, to, waitingKid, waiting.personId);
    expect(
      (
        await post(t, '/v1/waitlist-entries', waiting.header, {
          offeringId: to.offeringId,
          participantPersonId: waitingKid,
          intent: 'youth',
        })
      ).status,
    ).toBe(201);
    await post(t, `/v1/baskets/${occupied.basket.id}/release`, occupant.header, {
      reason: 'changed plans',
    });
    const preview = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: 2,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.capacity).toMatchObject({ waitlistAhead: 1, sufficient: false });
    expect(preview.body.capacity.required).toEqual([expect.objectContaining({ available: 1 })]);
    const commit = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: 2,
      commit: true,
    });
    expect(commit.status).toBe(409);
    expect(commit.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { waitlistFirst: true, waitlistAhead: 1 },
    });
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('status')
          .where('id', '=', enrollmentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed');
  });

  it('SPK-REG-008: offers follow priority; an expired offer requeues, a decline leaves the queue', async () => {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const holder = await heldBasketFor(parent, setup.offeringId, setup);
    const families = [await adult(t), await adult(t)];
    const entries: string[] = [];
    for (const family of families) {
      const kid = await child(t, [family]);
      await acknowledge(t, setup, kid, family.personId);
      const joined = await post(t, '/v1/waitlist-entries', family.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
        preferences: { note: 'weekday evenings' },
      });
      expect(joined.status).toBe(201);
      entries.push(joined.body.id as string);
      t.clock.advance(1000);
    }
    // While families wait, a newcomer cannot jump the queue with a direct hold (DEC-006 default).
    const newcomer = await adult(t);
    const newKid = await child(t, [newcomer]);
    await acknowledge(t, setup, newKid, newcomer.personId);
    // Free the place: the first-come family receives the offer.
    await post(t, `/v1/baskets/${holder.basket.id}/release`, parent.header, {
      reason: 'changed plans',
    });
    await drain(t);
    const firstView = await t.http
      .get(`/v1/waitlist-entries/${entries[0]!}`)
      .set(families[0]!.header);
    expect(firstView.body.status).toBe('offered');
    expect(firstView.body.preferences).toEqual({ note: 'weekday evenings' });
    const secondView = await t.http
      .get(`/v1/waitlist-entries/${entries[1]!}`)
      .set(families[1]!.header);
    expect(secondView.body).toMatchObject({ status: 'waiting', position: 1 });
    const newBasket = await basketWith(t, newcomer, [
      { participantPersonId: newKid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${newBasket.id}/hold`, newcomer.header, {})).status).toBe(
      409,
    );
    // The offer lapses unanswered: the place goes to the next family and the first requeues at the end.
    t.clock.advance(48 * 60 * MINUTE + 1000);
    await drain(t);
    const lapsed = await t.http.get(`/v1/waitlist-entries/${entries[0]!}`).set(families[0]!.header);
    expect(lapsed.body.status).toBe('waiting');
    expect(lapsed.body.offers.map((o: { status: string }) => o.status)).toEqual(['expired']);
    const next = await t.http.get(`/v1/waitlist-entries/${entries[1]!}`).set(families[1]!.header);
    expect(next.body.status).toBe('offered');
    // The second family declines: the entry leaves the queue and the place returns to the first.
    const declined = await post(
      t,
      `/v1/waitlist-offers/${next.body.offers[0].id as string}/decline`,
      families[1]!.header,
      {},
    );
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');
    await drain(t);
    const again = await t.http.get(`/v1/waitlist-entries/${entries[0]!}`).set(families[0]!.header);
    expect(again.body.status).toBe('offered');
    expect(again.body.offerCount).toBe(2);
    const gone = await t.http.get(`/v1/waitlist-entries/${entries[1]!}`).set(families[1]!.header);
    expect(gone.body.status).toBe('withdrawn');
    // Staff see the whole queue; a customer does not.
    expect(
      (
        await t.http
          .get(`/v1/waitlist-entries?offeringId=${setup.offeringId}`)
          .set(programManager.header)
      ).body,
    ).toHaveLength(2);
    expect(
      (await t.http.get(`/v1/waitlist-entries?offeringId=${setup.offeringId}`).set(parent.header))
        .status,
    ).toBe(403);
  });

  it('SPK-REG-010 / §4.8: a transfer previews, then commits, linking both enrollments and keeping history', async () => {
    const from = await offering(t, { basePriceMinor: 0 });
    const to = await offering(t, {
      basePriceMinor: 0,
      startsOn: '2027-02-01',
      endsOn: '2027-04-30',
    });
    const kid = await child(t, [parent]);
    await acknowledge(t, from, kid, parent.personId);
    await acknowledge(t, to, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: from.offeringId },
    ]);
    await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    const before = await t.db
      .selectFrom('enrollments')
      .selectAll()
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    const preview = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: before.revision,
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      committed: false,
      existing: { offeringId: from.offeringId, startsOn: '2027-01-10' },
      proposed: { offeringId: to.offeringId, startsOn: '2027-02-01' },
      affectedDates: { overlapping: true },
      capacity: { sufficient: true },
      financialConsequence: { kind: 'none' },
      requiredApproval: false,
      newEnrollment: null,
    });
    expect(preview.body.capacity.released).toEqual([expect.objectContaining({ unit: 'seats' })]);
    // A preview changes nothing.
    expect(
      (
        await t.db
          .selectFrom('enrollments')
          .select('revision')
          .where('id', '=', enrollmentId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(before.revision);
    const committed = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: before.revision,
      commit: true,
    });
    expect(committed.status).toBe(200);
    expect(committed.body.previousEnrollment).toMatchObject({
      id: enrollmentId,
      status: 'transferred',
      confirmedAt: new Date(before.confirmed_at as Date).toISOString(),
      transferredToEnrollmentId: committed.body.newEnrollment.id,
    });
    expect(committed.body.newEnrollment).toMatchObject({
      status: 'confirmed',
      offeringId: to.offeringId,
      transferredFromEnrollmentId: enrollmentId,
    });
    expect(await pool(from.offeringId)).toEqual([expect.objectContaining({ committed: 0 })]);
    expect(await pool(to.offeringId)).toEqual([expect.objectContaining({ committed: 1 })]);
    // History stays: the old allocation is released (not deleted) and the participant has both records.
    const allocations = await t.db
      .selectFrom('allocations')
      .select(['status', 'enrollment_id'])
      .where('enrollment_id', '=', enrollmentId)
      .execute();
    expect(allocations).toEqual([{ status: 'released', enrollment_id: enrollmentId }]);
    const history = await t.http
      .get(`/v1/enrollments?participantPersonId=${kid}`)
      .set(parent.header);
    expect(history.body.items.map((e: { status: string }) => e.status).sort()).toEqual([
      'confirmed',
      'transferred',
    ]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'enrollment.enrollment_transferred')
      .where('aggregate_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      fromEnrollmentId: enrollmentId,
      toEnrollmentId: committed.body.newEnrollment.id,
    });
    const again = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
      targetOfferingId: to.offeringId,
      expectedRevision: before.revision + 1,
      commit: true,
    });
    expect(again.status).toBe(409);
  });

  it('SPK-YOUTH-002: capacity respects the staffing pool; raising commercial capacity never bypasses it', async () => {
    const setup = await offering(t, {
      kind: 'camp',
      basePriceMinor: 0,
      capacityUnits: [
        {
          unit: 'camp_group_places',
          limit: 8,
          groupSize: 8,
          staffingRatio: { participantsPerStaff: 4 },
        },
      ],
    });
    const kids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const kid = await child(t, [parent]);
      await acknowledge(t, setup, kid, parent.personId);
      kids.push(kid);
    }
    const sync = await post(
      t,
      `/v1/offerings/${setup.offeringId}/capacity-pools/sync`,
      programManager.header,
      {},
    );
    expect(sync.status).toBe(200);
    expect(
      sync.body
        .map((p: { constraintKind: string; capacity: number }) => [p.constraintKind, p.capacity])
        .sort(),
    ).toEqual([
      ['commercial', 8],
      ['staffing', 8],
    ]);
    // Catalog raises the commercial limit; the staffing pool keeps its staff count (2 staff × 4).
    await uow.run(async ({ trx }) => {
      await t.app.get(Outbox).enqueue(trx, CatalogEvents.offeringUpdated, {
        organizationId: t.organizationId,
        aggregateType: 'offering',
        aggregateId: setup.offeringId,
        payload: {
          offeringId: setup.offeringId,
          programId: setup.programId,
          facilityId: setup.facilityId,
          kind: 'camp',
          revision: 2,
          publicationState: 'registration_open',
          capacityChange: {
            before: [
              {
                unit: 'camp_group_places',
                limit: 8,
                groupSize: 8,
                staffingRatio: { participantsPerStaff: 4 },
              },
            ],
            after: [
              {
                unit: 'camp_group_places',
                limit: 20,
                groupSize: 8,
                staffingRatio: { participantsPerStaff: 4 },
              },
            ],
            requiredStaffBefore: 2,
            requiredStaffAfter: 5,
            reason: 'More demand',
          },
        },
      });
    });
    await drain(t);
    const pools = await pool(setup.offeringId);
    expect(pools.map((p) => [p.constraint_kind, p.capacity, p.staff_count])).toEqual([
      ['commercial', 20, null],
      ['staffing', 8, 2],
    ]);
    const big = await basketWith(t, parent, [
      { participantPersonId: kids[0]!, offeringId: setup.offeringId },
    ]);
    await t.db
      .updateTable('basket_lines')
      .set({ quantity: 8 })
      .where('basket_id', '=', big.id)
      .execute();
    expect((await post(t, `/v1/baskets/${big.id}/hold`, parent.header, {})).status).toBe(200);
    const extra = await basketWith(t, parent, [
      { participantPersonId: kids[1]!, offeringId: setup.offeringId },
    ]);
    const refused = await post(t, `/v1/baskets/${extra.id}/hold`, parent.header, {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { constraintKind: 'staffing' },
    });
    // Staffing grows only explicitly: a staff count with a reason.
    const staffing = pools.find((p) => p.constraint_kind === 'staffing')!;
    const noReason = await post(
      t,
      `/v1/capacity-pools/${staffing.id}/adjust`,
      programManager.header,
      {
        staffCount: 3,
        expectedRevision: staffing.revision,
      },
    );
    expect(noReason.status).toBe(400);
    const raised = await post(
      t,
      `/v1/capacity-pools/${staffing.id}/adjust`,
      programManager.header,
      {
        staffCount: 3,
        reason: 'Third coach confirmed',
        expectedRevision: staffing.revision,
      },
    );
    expect(raised.status).toBe(200);
    expect(raised.body).toMatchObject({ capacity: 12, staffCount: 3, available: 4 });
    expect((await post(t, `/v1/baskets/${extra.id}/hold`, parent.header, {})).status).toBe(200);
    const shrink = await post(
      t,
      `/v1/capacity-pools/${staffing.id}/adjust`,
      programManager.header,
      {
        staffCount: 1,
        reason: 'Coach out',
        expectedRevision: raised.body.revision,
      },
    );
    expect(shrink.status).toBe(409);
    expect(shrink.body.details.code).toBe('CAPACITY_BELOW_COMMITMENTS');
  });
});
