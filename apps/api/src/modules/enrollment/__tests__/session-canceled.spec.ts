import { newId, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { CatalogEvents, createOfferingSessionFixture } from '../../catalog';
import { SessionCanceledFollowUp } from '../services/session-canceled-follow-up';
import { createMakeupEntitlementFixture } from '../testing/enrollment-fixtures';
import {
  adultOffering,
  cancellationPolicy,
  membershipOffering,
  packageOffering,
} from './package-g-support';
import {
  acknowledge,
  adult,
  basketWith,
  drain,
  enrollmentTestApp,
  offering,
  post,
  rejectsWith,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * R2-JOURNEYS-01 (SPK-AT-009 consistent publication after the approved resolution, SPK-COND-001,
 * SPK-COND-002, SPK-YOUTH-004, SPK-REG-008, §4.12): a session the facility cancels, directly in
 * the catalog (`POST /v1/sessions/{id}/cancel`) or through a closure (both emit
 * catalog.session_canceled), takes its live session bookings and waiters with it. A credit,
 * membership session or makeup the customer notice window would have kept is not lost to a
 * cancellation the family did not make.
 */
describe('a canceled session ends its bookings and waiters (R2-JOURNEYS-01, SPK-AT-009)', () => {
  let t: TestApp;
  let manager: Actor;
  let frontDesk: Actor;
  let target: OfferingSetup;

  beforeAll(async () => {
    t = await enrollmentTestApp({
      capabilities: ['session_packages', 'memberships', 'pickup_sessions'],
    });
    manager = await staff(t, ['program_manager']);
    frontDesk = await staff(t, ['front_desk']);
    target = await adultOffering(t, 'session');
  });
  afterAll(async () => {
    await t.close();
  });

  const sessionAt = (setup: OfferingSetup, start: string) =>
    createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date(start),
      scheduledEnd: new Date(Date.parse(start) + HOUR),
    });

  const cancelSession = async (sessionId: string, reason = 'Pitch flooded') => {
    const canceled = await post(t, `/v1/sessions/${sessionId}/cancel`, manager.header, { reason });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drain(t);
  };

  const bookingRow = (id: string) =>
    t.db
      .selectFrom('session_bookings')
      .select(['status', 'credit_disposition', 'cancel_reason'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const raisedFor = (bookingId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status', 'details'])
      .where('category', '=', 'enrollment.canceled_session_entitlement_pending')
      .where('affected_id', '=', bookingId)
      .execute();

  /** A free package purchase confirmed through the basket, with its issued entitlement. */
  async function buyPackage(buyer: Actor, cancellationPolicyVersionId?: string) {
    const pack = await packageOffering(t, {
      credits: 3,
      appliesTo: { offeringIds: [target.offeringId] },
      cancellationPolicyVersionId,
    });
    await acknowledge(t, pack, buyer.personId, buyer.personId);
    await acknowledge(t, target, buyer.personId, buyer.personId);
    const basket = await basketWith(t, buyer, [
      {
        participantPersonId: buyer.personId,
        offeringId: pack.offeringId,
        intent: 'package_purchase',
      },
    ]);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, buyer.header, {})).status).toBe(200);
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, buyer.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await drain(t);
    return t.db
      .selectFrom('package_entitlements')
      .select(['id'])
      .where('enrollment_id', '=', done.body.lines[0].enrollmentId as string)
      .executeTakeFirstOrThrow()
      .then((row) => row.id);
  }

  const redeemedCount = (entitlementId: string) =>
    t.db
      .selectFrom('package_entitlements')
      .select('redeemed_count')
      .where('id', '=', entitlementId)
      .executeTakeFirstOrThrow()
      .then((row) => row.redeemed_count);

  it('R2-JOURNEYS-01 / SPK-COND-002 / SPK-AT-009: a session canceled in the catalog ends its package-paid booking; inside the notice window the credit is raised for a decision, never kept as a customer cancellation; the seat, the calendar and the queue follow', async () => {
    const policyId = await cancellationPolicy(t, {
      text: 'Credits return until a day before the session.',
      packageCreditReturn: { untilMinutesBeforeStart: 24 * 60 },
    });
    const member = await adult(t);
    const entitlementId = await buyPackage(member, policyId);
    const saturday = await sessionAt(target, '2026-11-21T17:00:00Z');
    const later = await sessionAt(target, '2026-11-28T17:00:00Z');
    const book = (sessionId: string) =>
      post(t, '/v1/session-bookings', member.header, {
        offeringId: target.offeringId,
        sessionId,
        participantPersonId: member.personId,
        packageEntitlementId: entitlementId,
      });
    const near = await book(saturday);
    expect(near.status, JSON.stringify(near.body)).toBe(201);
    const far = await book(later);
    expect(far.status, JSON.stringify(far.body)).toBe(201);
    expect(await redeemedCount(entitlementId)).toBe(2);

    // Saturday morning: inside the customer's notice window, the facility cancels the session.
    t.clock.set(new Date(Date.parse('2026-11-21T17:00:00Z') - 3 * HOUR));
    try {
      await cancelSession(saturday, 'Pitch flooded');
      expect(await bookingRow(near.body.id as string)).toEqual({
        status: 'canceled',
        credit_disposition: 'retained_pending_policy',
        cancel_reason: 'Pitch flooded',
      });
      // The credit is not silently kept: one owned decision names the redemption to reverse.
      const redemption = await t.db
        .selectFrom('package_redemptions')
        .select('id')
        .where('session_booking_id', '=', near.body.id as string)
        .where('kind', '=', 'redeem')
        .executeTakeFirstOrThrow();
      expect(await raisedFor(near.body.id as string)).toEqual([
        {
          owner_queue: 'program_manager',
          status: 'open',
          details: expect.objectContaining({
            sessionId: saturday,
            entitlementBasis: 'package',
            packageEntitlementId: entitlementId,
            packageRedemptionId: redemption.id,
            creditDisposition: 'retained_pending_policy',
          }),
        },
      ]);
      // The seat is gone with the session: its pools are closed and nobody books it again.
      const pools = await t.db
        .selectFrom('capacity_pools')
        .select(['status', 'committed', 'held'])
        .where('scope_type', '=', 'session')
        .where('scope_id', '=', saturday)
        .execute();
      expect(pools.length).toBeGreaterThan(0);
      expect(pools.every((p) => p.status === 'closed' && p.committed === 0 && p.held === 0)).toBe(
        true,
      );
      // Staff return the credit through the redemption the exception names.
      const reversed = await post(
        t,
        `/v1/package-redemptions/${redemption.id}/reverse`,
        frontDesk.header,
        { reason: 'The facility canceled the session' },
      );
      expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
      expect((await bookingRow(near.body.id as string)).credit_disposition).toBe('returned');
      expect(await redeemedCount(entitlementId)).toBe(1);
      // The family calendar no longer lists the canceled session.
      const calendar = await t.http
        .get('/v1/me/family-calendar')
        .query({
          from: new Date(t.clock.now().getTime() - DAY).toISOString(),
          to: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
        })
        .set(member.header);
      expect(calendar.status).toBe(200);
      const sessions = calendar.body.items.map((i: { sessionId: string }) => i.sessionId);
      expect(sessions).not.toContain(saturday);
      expect(sessions).toContain(later);

      // Well before the notice deadline, the approved policy returns the credit at once.
      await cancelSession(later, 'Tournament moved');
      expect(await bookingRow(far.body.id as string)).toEqual({
        status: 'canceled',
        credit_disposition: 'returned',
        cancel_reason: 'Tournament moved',
      });
      expect(await raisedFor(far.body.id as string)).toEqual([]);
      expect(await redeemedCount(entitlementId)).toBe(0);
    } finally {
      t.clock.set(new Date('2026-11-02T15:00:00Z'));
    }
  });

  it('R2-JOURNEYS-01 / SPK-COND-001 / SPK-YOUTH-004: a membership session comes back, a makeup is restored even after the start, and a replayed cancellation changes nothing', async () => {
    const member = await adult(t);
    const membership = await membershipOffering(
      t,
      {
        attendance: {
          mode: 'included_sessions',
          appliesTo: { offeringIds: [target.offeringId] },
          limit: { count: 1, period: 'week', weekStartsOn: 1 },
        },
        term: { kind: 'offering_dates' },
        renewal: { noticeLeadDays: null },
      },
      { startsOn: '2026-11-01', endsOn: '2027-01-31' },
    );
    await acknowledge(t, membership, member.personId, member.personId);
    await acknowledge(t, target, member.personId, member.personId);
    const basket = await basketWith(t, member, [
      {
        participantPersonId: member.personId,
        offeringId: membership.offeringId,
        intent: 'membership',
      },
    ]);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, member.header, {})).status).toBe(200);
    const joined = await post(t, `/v1/baskets/${basket.id}/complete`, member.header, {});
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    await drain(t);
    const membershipEnrollmentId = joined.body.lines[0].enrollmentId as string;
    const tuesday = await sessionAt(target, '2026-12-01T18:00:00Z');
    const nextWeek = await sessionAt(target, '2026-12-08T18:00:00Z');
    const bookWithMembership = (sessionId: string) =>
      post(t, '/v1/session-bookings', member.header, {
        offeringId: target.offeringId,
        sessionId,
        participantPersonId: member.personId,
        membershipEnrollmentId,
      });
    const viaMembership = await bookWithMembership(tuesday);
    expect(viaMembership.status, JSON.stringify(viaMembership.body)).toBe(201);
    const nextWeekBooking = await bookWithMembership(nextWeek);
    expect(nextWeekBooking.status, JSON.stringify(nextWeekBooking.body)).toBe(201);
    // A makeup redeemed for the same session.
    const kidOwner = await adult(t);
    await acknowledge(t, target, kidOwner.personId, kidOwner.personId);
    const makeupId = await createMakeupEntitlementFixture(t, {
      participantPersonId: kidOwner.personId,
      eligibleOfferingIds: [target.offeringId],
    });
    const viaMakeup = await post(t, `/v1/makeup-entitlements/${makeupId}/redeem`, kidOwner.header, {
      offeringId: target.offeringId,
      sessionId: tuesday,
    });
    expect(viaMakeup.status, JSON.stringify(viaMakeup.body)).toBe(201);

    // The session has started when the facility cancels it (a customer cancellation now would
    // keep the makeup; the facility's does not).
    t.clock.set(new Date(Date.parse('2026-12-01T18:00:00Z') + 10 * 60_000));
    try {
      await cancelSession(tuesday, 'Lights failed');
    } finally {
      t.clock.set(new Date('2026-11-02T15:00:00Z'));
    }
    expect(await bookingRow(viaMembership.body.id as string)).toMatchObject({
      status: 'canceled',
      credit_disposition: 'retained_pending_policy',
    });
    expect(await raisedFor(viaMembership.body.id as string)).toEqual([
      expect.objectContaining({
        owner_queue: 'program_manager',
        details: expect.objectContaining({
          entitlementBasis: 'membership',
          membershipEnrollmentId,
        }),
      }),
    ]);
    expect((await bookingRow(viaMakeup.body.id as string)).status).toBe('canceled');
    const makeup = await t.http.get(`/v1/makeup-entitlements/${makeupId}`).set(kidOwner.header);
    expect(makeup.body).toMatchObject({ status: 'active', redeemedCount: 0 });
    expect(makeup.body.redemptions.map((r: { kind: string }) => r.kind)).toEqual([
      'redeem',
      'reversal',
    ]);
    expect(await raisedFor(viaMakeup.body.id as string)).toEqual([]);

    // Canceled by the facility before its start, a membership session comes back at once.
    await cancelSession(nextWeek, 'Lights failed');
    expect(await bookingRow(nextWeekBooking.body.id as string)).toMatchObject({
      status: 'canceled',
      credit_disposition: 'returned',
    });
    expect(await raisedFor(nextWeekBooking.body.id as string)).toEqual([]);
    const uses = await t.db
      .selectFrom('membership_benefit_uses')
      .select(['period_key', 'used_count'])
      .where('enrollment_id', '=', membershipEnrollmentId)
      .orderBy('period_key')
      .execute();
    // Tuesday's week stays counted until staff decide; the next week's use was given back.
    expect(uses).toEqual([
      { period_key: 'week:2026-11-30', used_count: 1 },
      { period_key: 'week:2026-12-07', used_count: 0 },
    ]);

    // A replayed catalog.session_canceled finds nothing live and raises nothing new.
    const event = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', CatalogEvents.sessionCanceled.type)
      .where(sql<boolean>`payload->>'sessionId' = ${tuesday}`)
      .executeTakeFirstOrThrow();
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(SessionCanceledFollowUp).onSessionCanceled(trx, {
        id: event.id,
        type: event.event_type,
        organizationId: event.organization_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        occurredAt: new Date(event.occurred_at).toISOString(),
        payload: event.payload as EventPayload<typeof CatalogEvents.sessionCanceled>,
        correlationId: event.correlation_id,
        causationId: null,
        operationId: null,
      } as DomainEvent<EventPayload<typeof CatalogEvents.sessionCanceled>>),
    );
    await drain(t);
    expect(await raisedFor(viaMembership.body.id as string)).toHaveLength(1);
    const after = await t.http.get(`/v1/makeup-entitlements/${makeupId}`).set(kidOwner.header);
    expect(after.body.redemptions).toHaveLength(2);
  });

  it('R2-LIFECYCLES-06 / SPK-YOUTH-004: a revoked makeup gets nothing back when its session is canceled; the decision is raised and the database refuses the reversal', async () => {
    const owner = await adult(t);
    await acknowledge(t, target, owner.personId, owner.personId);
    const makeupId = await createMakeupEntitlementFixture(t, {
      participantPersonId: owner.personId,
      eligibleOfferingIds: [target.offeringId],
      redemptionLimit: 2,
    });
    const friday = await sessionAt(target, '2026-12-04T18:00:00Z');
    const redeemed = await post(t, `/v1/makeup-entitlements/${makeupId}/redeem`, owner.header, {
      offeringId: target.offeringId,
      sessionId: friday,
    });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    const current = await t.http.get(`/v1/makeup-entitlements/${makeupId}`).set(frontDesk.header);
    expect(
      (
        await post(t, `/v1/makeup-entitlements/${makeupId}/revoke`, frontDesk.header, {
          reason: 'Issued in error',
          expectedRevision: current.body.revision,
        })
      ).status,
    ).toBe(200);
    await cancelSession(friday, 'Pool closed');
    expect((await bookingRow(redeemed.body.id as string)).status).toBe('canceled');
    const after = await t.db
      .selectFrom('makeup_entitlements')
      .select(['status', 'redeemed_count'])
      .where('id', '=', makeupId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'revoked', redeemed_count: 1 });
    expect(await raisedFor(redeemed.body.id as string)).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ makeupEntitlementId: makeupId, makeupReversed: false }),
      }),
    ]);
    const redemption = await t.db
      .selectFrom('makeup_redemptions')
      .select(['id', 'kind'])
      .where('makeup_entitlement_id', '=', makeupId)
      .execute();
    expect(redemption.map((r) => r.kind)).toEqual(['redeem']);
    expect(
      await rejectsWith(
        t.db
          .insertInto('makeup_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            makeup_entitlement_id: makeupId,
            session_booking_id: redeemed.body.id as string,
            participant_person_id: owner.personId,
            kind: 'reversal',
            reverses_redemption_id: redemption[0]!.id,
            actor: json({ kind: 'system' }),
            redeemed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe('23514');
  });

  it('R2-JOURNEYS-01 / SPK-REG-008: the waiters of a canceled session leave the queue with a notice, no offer is made for the freed seat, and nobody books or joins it again', async () => {
    const pickup = await offering(t, {
      kind: 'pickup',
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
      ageBand: { minAgeYears: 18 },
    });
    const seat = await sessionAt(pickup, '2026-11-18T02:00:00Z');
    const players: Actor[] = [];
    for (let i = 0; i < 3; i += 1) {
      const actor = await adult(t);
      await acknowledge(t, pickup, actor.personId, actor.personId);
      players.push(actor);
    }
    const [booker, waiter, late] = players as [Actor, Actor, Actor];
    const booked = await post(t, '/v1/session-bookings', booker.header, {
      offeringId: pickup.offeringId,
      sessionId: seat,
      participantPersonId: booker.personId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const joined = await post(t, '/v1/waitlist-entries', waiter.header, {
      offeringId: pickup.offeringId,
      participantPersonId: waiter.personId,
      intent: 'pickup',
      sessionId: seat,
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);

    await cancelSession(seat, 'Gym double-booked');

    expect((await bookingRow(booked.body.id as string)).status).toBe('canceled');
    const entry = await t.db
      .selectFrom('waitlist_entries')
      .select(['status', 'removal_reason', 'offer_count'])
      .where('id', '=', joined.body.id as string)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      status: 'removed',
      removal_reason: 'session_canceled',
      offer_count: 0,
    });
    const notices = await t.db
      .selectFrom('notifications')
      .select(['kind', 'title', 'body'])
      .where('subject_id', '=', joined.body.id as string)
      .execute();
    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'registration_outcome',
        title: 'No longer on the waitlist',
        body: expect.stringContaining('was canceled by the facility'),
      }),
    ]);
    const offers = await t.db
      .selectFrom('waitlist_offers')
      .select('id')
      .where('waitlist_entry_id', '=', joined.body.id as string)
      .execute();
    expect(offers).toEqual([]);
    // Nobody books or waits for the canceled session again.
    const rebook = await post(t, '/v1/session-bookings', late.header, {
      offeringId: pickup.offeringId,
      sessionId: seat,
      participantPersonId: late.personId,
    });
    expect(rebook.status).not.toBe(201);
    const rejoin = await post(t, '/v1/waitlist-entries', late.header, {
      offeringId: pickup.offeringId,
      participantPersonId: late.personId,
      intent: 'pickup',
      sessionId: seat,
    });
    expect(rejoin.status).not.toBe(201);
  });
});
