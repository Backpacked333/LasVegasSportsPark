import { newId, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  CatalogEvents,
  createOfferingSessionFixture,
  SESSION_CANCELED_EVENT_REASON,
} from '../../catalog';
import { CapacityService } from '../services/capacity.service';
import { EXPIRE_PACKAGES_JOB } from '../services/enrollment-jobs';
import { MakeupsService } from '../services/makeups.service';
import { SessionCanceledFollowUp } from '../services/session-canceled-follow-up';
import { SessionParticipants } from '../services/session-participants';
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

  /** The notices enrollment composed about a session booking. */
  const bookingNotices = (bookingId: string) =>
    t.db
      .selectFrom('notifications')
      .select(['id', 'kind', 'title', 'body', 'protected'])
      .where('subject_type', '=', 'session_booking')
      .where('subject_id', '=', bookingId)
      .execute();

  /** A free package purchase confirmed through the basket, with its issued entitlement. */
  async function buyPackage(
    buyer: Actor,
    cancellationPolicyVersionId?: string,
    options: { credits?: number; expiry?: Record<string, unknown> } = {},
  ) {
    const pack = await packageOffering(t, {
      credits: options.credits ?? 3,
      appliesTo: { offeringIds: [target.offeringId] },
      cancellationPolicyVersionId,
      expiry: options.expiry,
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
      await cancelSession(saturday, 'Pitch flooded; Coach Lee suspended');
      expect(await bookingRow(near.body.id as string)).toEqual({
        status: 'canceled',
        credit_disposition: 'retained_pending_policy',
        cancel_reason: SESSION_CANCELED_EVENT_REASON,
      });
      // §4.14: the catalog's staff-only reason never reaches the family's booking view.
      const familyView = await t.http
        .get(`/v1/session-bookings/${near.body.id as string}`)
        .set(member.header);
      expect(familyView.status).toBe(200);
      expect(familyView.body.cancelReason).toBe(SESSION_CANCELED_EVENT_REASON);
      expect(JSON.stringify(familyView.body)).not.toContain('Coach Lee');
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
      // The family is told, and what happens to the credit (stage-6 rework, SPK-COMMS-002).
      expect(await bookingNotices(near.body.id as string)).toEqual([
        expect.objectContaining({
          kind: 'cancellation',
          title: 'Session canceled',
          protected: true,
          body: expect.stringContaining('Staff review what happens to the package credit.'),
        }),
      ]);
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
        cancel_reason: SESSION_CANCELED_EVENT_REASON,
      });
      expect(await raisedFor(far.body.id as string)).toEqual([]);
      expect(await redeemedCount(entitlementId)).toBe(0);
      expect(await bookingNotices(far.body.id as string)).toEqual([
        expect.objectContaining({
          kind: 'cancellation',
          body: expect.stringContaining('The package credit was given back.'),
        }),
      ]);
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
    // The booked family is told too: a catalog cancellation emits no scheduling change, so
    // enrollment composes the notice (stage-6 rework of R2-JOURNEYS-01, SPK-COMMS-002).
    const bookerNotices = await bookingNotices(booked.body.id as string);
    expect(bookerNotices).toEqual([
      expect.objectContaining({
        kind: 'cancellation',
        title: 'Session canceled',
        protected: true,
        body: expect.stringContaining('was canceled by the facility, so the booking is canceled.'),
      }),
    ]);
    // A free pickup booking used nothing, so nothing more is said.
    expect(bookerNotices[0]!.body).not.toMatch(/Staff review|given back|makeup/);
    const inbox = await t.http.get('/v1/me/inbox').set(booker.header);
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((i: { notificationId: string }) => i.notificationId)).toContain(
      bookerNotices[0]!.id,
    );
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
    // The catalog reads the session as canceled, so eligibility refuses the booking before any
    // seat is looked at.
    expect(rebook.status, JSON.stringify(rebook.body)).toBe(422);
    expect(rebook.body.code).toBe('ELIGIBILITY_FAILED');
    expect(rebook.body.details.reasons.map((r: { code: string }) => r.code)).toContain(
      'session_not_bookable',
    );
    const rejoin = await post(t, '/v1/waitlist-entries', late.header, {
      offeringId: pickup.offeringId,
      participantPersonId: late.personId,
      intent: 'pickup',
      sessionId: seat,
    });
    expect(rejoin.status, JSON.stringify(rejoin.body)).toBe(409);
    expect(rejoin.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'SESSION_CANCELED' },
    });
  });

  it('R2-JOURNEYS-01 / §4.7 invariant 3: a booking whose session was read as scheduled after its pools were closed is refused by the closed-pool guard (409 CAPACITY_UNAVAILABLE SESSION_CANCELED)', async () => {
    const pickup = await offering(t, {
      kind: 'pickup',
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 5 }],
      ageBand: { minAgeYears: 18 },
    });
    const seat = await sessionAt(pickup, '2026-11-21T02:00:00Z');
    const [first, second] = [await adult(t), await adult(t)];
    for (const actor of [first, second]) {
      await acknowledge(t, pickup, actor.personId, actor.personId);
    }
    const booked = await post(t, '/v1/session-bookings', first.header, {
      offeringId: pickup.offeringId,
      sessionId: seat,
      participantPersonId: first.personId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    // enrollment.follow_session_canceled closed the session's pools, while the booking below still
    // reads the catalog session as scheduled (the read that happens before its transaction).
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get(CapacityService)
          .closeSessionPools(trx, t.organizationId, pickup.offeringId, seat, 'Gym flooded', null),
      );
    const refused = await post(t, '/v1/session-bookings', second.header, {
      offeringId: pickup.offeringId,
      sessionId: seat,
      participantPersonId: second.personId,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { code: 'SESSION_CANCELED', sessionId: seat },
    });
    const live = await t.db
      .selectFrom('session_bookings')
      .select('participant_person_id')
      .where('session_id', '=', seat)
      .execute();
    expect(live.map((b) => b.participant_person_id)).toEqual([first.personId]);
  });

  it('stage-6 R2-LIFECYCLES-06 / SPK-YOUTH-004: an exhausted makeup past its expiry gets nothing back when its session is canceled; the decision is raised naming no reversal and the database refuses one', async () => {
    const owner = await adult(t);
    await acknowledge(t, target, owner.personId, owner.personId);
    const makeupId = await createMakeupEntitlementFixture(t, {
      participantPersonId: owner.personId,
      eligibleOfferingIds: [target.offeringId],
      redemptionLimit: 1,
      expiresAt: new Date('2026-11-07T00:00:00Z'),
    });
    const thursday = await sessionAt(target, '2026-11-12T18:00:00Z');
    const redeemed = await post(t, `/v1/makeup-entitlements/${makeupId}/redeem`, owner.header, {
      offeringId: target.offeringId,
      sessionId: thursday,
    });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    const entitlement = () =>
      t.db
        .selectFrom('makeup_entitlements')
        .select(['status', 'redeemed_count'])
        .where('id', '=', makeupId)
        .executeTakeFirstOrThrow();
    t.clock.set(new Date('2026-11-08T12:00:00Z'));
    try {
      // Its expiry has passed, but an exhausted makeup is never moved to `expired`.
      await t.app
        .get(UnitOfWork)
        .run(({ trx }) =>
          t.app.get(MakeupsService).expireIfDue(trx, t.organizationId, makeupId, null),
        );
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 1 });
      await cancelSession(thursday, 'Coach unavailable');
      const booking = await t.db
        .selectFrom('session_bookings')
        .select(['status', 'cancel_cause'])
        .where('id', '=', redeemed.body.id as string)
        .executeTakeFirstOrThrow();
      expect(booking).toEqual({ status: 'canceled', cancel_cause: 'session_canceled' });
      // Nothing comes back to it: it stays exhausted, never `active` with a past expiry.
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 1 });
      const redemptions = await t.db
        .selectFrom('makeup_redemptions')
        .select(['id', 'kind'])
        .where('makeup_entitlement_id', '=', makeupId)
        .execute();
      expect(redemptions.map((r) => r.kind)).toEqual(['redeem']);
      expect(await raisedFor(redeemed.body.id as string)).toEqual([
        expect.objectContaining({
          owner_queue: 'program_manager',
          details: expect.objectContaining({
            makeupEntitlementId: makeupId,
            makeupReversed: false,
            entitlementEnded: true,
            packageRedemptionId: null,
          }),
        }),
      ]);
      expect(await bookingNotices(redeemed.body.id as string)).toEqual([
        expect.objectContaining({
          kind: 'cancellation',
          body: expect.stringContaining('Staff review what happens to the makeup.'),
        }),
      ]);
      // The database refuses the reversal onto it from any writer (migration 0518).
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
              reverses_redemption_id: redemptions[0]!.id,
              actor: json({ kind: 'system' }),
              redeemed_at: t.clock.now(),
            })
            .execute(),
        ),
      ).toBe('23514');
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 1 });
    } finally {
      t.clock.set(new Date('2026-11-02T15:00:00Z'));
    }
  });

  it('stage-6 R2-LIFECYCLES-06 / SPK-COND-002 / POL-039: an exhausted package past its expiry gets nothing back from a family or a facility cancellation; the booking records retained_entitlement_ended, the decision names no reversal, and a staff reversal and a direct write are refused', async () => {
    const buyer = await adult(t);
    // Issued now (2026-11-02 15:00Z), it expires two days later; both credits are used first.
    const entitlementId = await buyPackage(buyer, undefined, {
      credits: 2,
      expiry: { kind: 'days_after_issue', days: 2 },
    });
    const first = await sessionAt(target, '2026-11-12T17:00:00Z');
    const second = await sessionAt(target, '2026-11-13T17:00:00Z');
    const book = (sessionId: string) =>
      post(t, '/v1/session-bookings', buyer.header, {
        offeringId: target.offeringId,
        sessionId,
        participantPersonId: buyer.personId,
        packageEntitlementId: entitlementId,
      });
    const familyCanceled = await book(first);
    expect(familyCanceled.status, JSON.stringify(familyCanceled.body)).toBe(201);
    const facilityCanceled = await book(second);
    expect(facilityCanceled.status, JSON.stringify(facilityCanceled.body)).toBe(201);
    const entitlement = () =>
      t.db
        .selectFrom('package_entitlements')
        .select(['status', 'redeemed_count'])
        .where('id', '=', entitlementId)
        .executeTakeFirstOrThrow();
    expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 2 });
    t.clock.set(new Date('2026-11-05T12:00:00Z'));
    try {
      // The expiry job expires active packages only: this one stays exhausted.
      await t.runPeriodicJobs([EXPIRE_PACKAGES_JOB]);
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 2 });

      const canceled = await post(
        t,
        `/v1/session-bookings/${familyCanceled.body.id as string}/cancel`,
        buyer.header,
        { reason: 'away that week', expectedRevision: familyCanceled.body.revision },
      );
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      expect(canceled.body.creditDisposition).toBe('retained_entitlement_ended');
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 2 });

      await cancelSession(second, 'Floodlights failed');
      expect(await bookingRow(facilityCanceled.body.id as string)).toEqual({
        status: 'canceled',
        credit_disposition: 'retained_entitlement_ended',
        cancel_reason: SESSION_CANCELED_EVENT_REASON,
      });
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 2 });
      // The loss is raised for a decision, without pointing staff at a reversal that cannot happen.
      expect(await raisedFor(facilityCanceled.body.id as string)).toEqual([
        expect.objectContaining({
          owner_queue: 'program_manager',
          details: expect.objectContaining({
            entitlementBasis: 'package',
            packageEntitlementId: entitlementId,
            packageRedemptionId: null,
            creditDisposition: 'retained_entitlement_ended',
            entitlementEnded: true,
          }),
        }),
      ]);
      expect(await bookingNotices(facilityCanceled.body.id as string)).toEqual([
        expect.objectContaining({
          body: expect.stringContaining('Staff review what happens to the package credit.'),
        }),
      ]);
      const redemption = await t.db
        .selectFrom('package_redemptions')
        .select('id')
        .where('session_booking_id', '=', facilityCanceled.body.id as string)
        .where('kind', '=', 'redeem')
        .executeTakeFirstOrThrow();
      const reversed = await post(
        t,
        `/v1/package-redemptions/${redemption.id}/reverse`,
        frontDesk.header,
        { reason: 'goodwill' },
      );
      expect(reversed.status, JSON.stringify(reversed.body)).toBe(409);
      expect(reversed.body.details).toMatchObject({ code: 'PACKAGE_ENDED', status: 'exhausted' });
      // The database refuses it from any writer (migration 0518).
      expect(
        await rejectsWith(
          t.db
            .insertInto('package_redemptions')
            .values({
              id: newId(),
              organization_id: t.organizationId,
              package_entitlement_id: entitlementId,
              session_booking_id: facilityCanceled.body.id as string,
              participant_person_id: buyer.personId,
              kind: 'reversal',
              reverses_redemption_id: redemption.id,
              reason: 'direct write',
              actor: json({ kind: 'system' }),
              redeemed_at: t.clock.now(),
            })
            .execute(),
        ),
      ).toBe('23514');
      expect(await entitlement()).toEqual({ status: 'exhausted', redeemed_count: 2 });
    } finally {
      t.clock.set(new Date('2026-11-02T15:00:00Z'));
    }
  });

  it('stage-6 R2-JOURNEYS-01 / SPK-AT-009 / SPK-COMMS-002: the session audience keeps the bookings canceled with the session whichever follow-up runs first, never a booking the family canceled itself; each booked family is told once', async () => {
    const pickup = await offering(t, {
      kind: 'pickup',
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 5 }],
      ageBand: { minAgeYears: 18 },
    });
    const schedulingEventId = newId();
    const seat = await createOfferingSessionFixture(t, {
      offeringId: pickup.offeringId,
      scheduledStart: new Date('2026-11-22T02:00:00Z'),
      scheduledEnd: new Date('2026-11-22T03:00:00Z'),
      schedulingEventId,
    });
    const [stayer, leaver] = [await adult(t), await adult(t)];
    const bookings: Record<string, { id: string; revision: number }> = {};
    for (const actor of [stayer, leaver]) {
      await acknowledge(t, pickup, actor.personId, actor.personId);
      const booked = await post(t, '/v1/session-bookings', actor.header, {
        offeringId: pickup.offeringId,
        sessionId: seat,
        participantPersonId: actor.personId,
      });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      bookings[actor.personId] = { id: booked.body.id, revision: booked.body.revision };
    }
    const left = bookings[leaver.personId]!;
    expect(
      (
        await post(t, `/v1/session-bookings/${left.id}/cancel`, leaver.header, {
          reason: 'cannot make it',
          expectedRevision: left.revision,
        })
      ).status,
    ).toBe(200);
    const audience = () =>
      t.app
        .get(SessionParticipants)
        .participantsOfSchedulingEvent(t.db, t.organizationId, schedulingEventId);
    // Before the session's cancellation is followed (communications reading first).
    expect(await audience()).toEqual([stayer.personId]);
    await cancelSession(seat, 'Hall closed');
    // After it (enrollment's follow-up committed first): the canceled booking is still in it.
    expect(await audience()).toEqual([stayer.personId]);
    const stayed = bookings[stayer.personId]!.id;
    const causes = await t.db
      .selectFrom('session_bookings')
      .select(['id', 'cancel_cause'])
      .where('session_id', '=', seat)
      .orderBy('id')
      .execute();
    expect(Object.fromEntries(causes.map((c) => [c.id, c.cancel_cause]))).toEqual({
      [stayed]: 'session_canceled',
      [left.id]: 'customer',
    });
    // Live participants only for a closure's impact: nobody is still booked.
    const impact = await t.app.get(SessionParticipants).closureImpact(t.db, t.organizationId, [
      {
        eventId: schedulingEventId,
        kind: 'session',
        scheduledStart: '2026-11-22T02:00:00.000Z',
        sourceType: null,
        sourceId: null,
        commitments: [],
      },
    ]);
    expect(impact.customers).toEqual([]);
    // Enrollment tells the family it canceled, once; the family that left is not told.
    const notices = await bookingNotices(stayed);
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'cancellation', title: 'Session canceled' }),
    ]);
    expect(await bookingNotices(left.id)).toEqual([]);
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('notification_id', '=', notices[0]!.id)
      .execute();
    expect(recipients.map((r) => r.person_id)).toEqual([stayer.personId]);
    // A redelivered change event composes nothing new.
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null, available_at: t.clock.now() })
      .where('event_type', '=', 'enrollment.session_booking_changed')
      .where('aggregate_id', '=', stayed)
      .execute();
    await drain(t);
    expect(await bookingNotices(stayed)).toHaveLength(1);
  });
});
