import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { EXPIRE_PACKAGES_JOB } from '../services/enrollment-jobs';
import { adultOffering, cancellationPolicy, packageOffering } from './package-g-support';
import {
  acknowledge,
  adult,
  basketWith,
  drain,
  enrollmentTestApp,
  isRestrictViolation,
  post,
  rejectsWith,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ENR-11: session packages (capability session_packages; DEC-016, DEC-074). */
describe('session packages (ENR-11, SPK-COND-002)', () => {
  let t: TestApp;
  let frontDesk: Actor;
  let target: OfferingSetup;
  let sessions: string[];

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['session_packages'] });
    frontDesk = await staff(t, ['front_desk']);
    target = await adultOffering(t, 'session');
    sessions = [];
    for (let i = 0; i < 6; i += 1) {
      sessions.push(
        await createOfferingSessionFixture(t, {
          offeringId: target.offeringId,
          scheduledStart: new Date(Date.parse('2026-11-20T02:00:00Z') + i * DAY),
          scheduledEnd: new Date(Date.parse('2026-11-20T03:00:00Z') + i * DAY),
        }),
      );
    }
  });
  afterAll(async () => {
    await t.close();
  });

  /** A free package purchase, confirmed through the basket, with its issued entitlement. */
  async function buy(
    buyer: Actor,
    credits: number,
    options: { expiry?: Record<string, unknown>; cancellationPolicyVersionId?: string } = {},
  ) {
    const pack = await packageOffering(t, {
      credits,
      appliesTo: { offeringIds: [target.offeringId] },
      expiry: options.expiry,
      cancellationPolicyVersionId: options.cancellationPolicyVersionId,
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
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, buyer.header, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, buyer.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await drain(t);
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    const entitlement = await t.db
      .selectFrom('package_entitlements')
      .selectAll()
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    return { pack, enrollmentId, entitlementId: entitlement.id };
  }

  const book = (actor: Actor, sessionId: string, packageEntitlementId: string) =>
    post(t, '/v1/session-bookings', actor.header, {
      offeringId: target.offeringId,
      sessionId,
      participantPersonId: actor.personId,
      packageEntitlementId,
    });

  it('SPK-COND-002: a confirmed package purchase issues its credits once and each booking redeems one', async () => {
    const buyer = await adult(t);
    const { entitlementId } = await buy(buyer, 3);
    const mine = await t.http.get('/v1/me/package-entitlements').set(buyer.header);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        id: entitlementId,
        credits: 3,
        remainingCredits: 3,
        status: 'active',
        expiresAt: null,
        appliesTo: { offeringIds: [target.offeringId], programIds: [] },
      }),
    ]);
    const booked = await book(buyer, sessions[0]!, entitlementId);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body).toMatchObject({
      status: 'confirmed',
      kind: 'session',
      entitlementBasis: 'package',
      packageEntitlementId: entitlementId,
      price: null,
    });
    // A replayed confirmation issues nothing new.
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending' })
      .where('event_type', '=', 'enrollment.enrollment_confirmed')
      .execute();
    await drain(t);
    const rows = await t.db
      .selectFrom('package_entitlements')
      .select(['id', 'redeemed_count'])
      .where('participant_person_id', '=', buyer.personId)
      .execute();
    expect(rows).toEqual([{ id: entitlementId, redeemed_count: 1 }]);
    const after = await t.http.get('/v1/me/package-entitlements').set(buyer.header);
    expect(after.body.items[0]).toMatchObject({
      remainingCredits: 2,
      redemptions: [expect.objectContaining({ kind: 'redeem', sessionBookingId: booked.body.id })],
    });
    // Another household never sees the package and cannot spend it.
    const stranger = await adult(t);
    await acknowledge(t, target, stranger.personId, stranger.personId);
    const theirs = await book(stranger, sessions[1]!, entitlementId);
    expect(theirs.status).toBe(404);
  });

  it('SPK-AT-020 / SPK-COND-002: two concurrent redemptions of the last credit yield exactly one booking (PGlite and TEST_DATABASE_URL)', async () => {
    const buyer = await adult(t);
    const { entitlementId } = await buy(buyer, 1);
    const results = await Promise.all([
      book(buyer, sessions[2]!, entitlementId),
      book(buyer, sessions[3]!, entitlementId),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.details.code).toBe('PACKAGE_CREDITS_EXHAUSTED');
    const bookings = await t.db
      .selectFrom('session_bookings')
      .select('id')
      .where('package_entitlement_id', '=', entitlementId)
      .execute();
    expect(bookings).toHaveLength(1);
    const row = await t.db
      .selectFrom('package_entitlements')
      .select(['redeemed_count', 'status'])
      .where('id', '=', entitlementId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ redeemed_count: 1, status: 'exhausted' });
  });

  it('the database rejects a redemption beyond the credits, an update of a redemption row and a package booking without its entitlement', async () => {
    const buyer = await adult(t);
    const { entitlementId } = await buy(buyer, 1);
    const booked = await book(buyer, sessions[4]!, entitlementId);
    expect(booked.status).toBe(201);
    // One redemption per booking: a second one of the same booking is refused by uniqueness.
    expect(
      await rejectsWith(
        t.db
          .insertInto('package_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            package_entitlement_id: entitlementId,
            session_booking_id: booked.body.id,
            participant_person_id: buyer.personId,
            kind: 'redeem',
            reverses_redemption_id: null,
            reason: null,
            actor: json({ kind: 'system' }),
            redeemed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe('23505');
    const other = await t.db
      .insertInto('session_bookings')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        offering_id: target.offeringId,
        session_id: sessions[5]!,
        participant_person_id: buyer.personId,
        kind: 'session',
        status: 'confirmed',
        entitlement_basis: 'package',
        package_entitlement_id: entitlementId,
        scheduled_start: new Date('2026-11-25T02:00:00Z'),
        scheduled_end: new Date('2026-11-25T03:00:00Z'),
        booked_by: json({ kind: 'system' }),
        confirmed_at: t.clock.now(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(
      await rejectsWith(
        t.db
          .insertInto('package_redemptions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            package_entitlement_id: entitlementId,
            session_booking_id: other.id,
            participant_person_id: buyer.personId,
            kind: 'redeem',
            reverses_redemption_id: null,
            reason: null,
            actor: json({ kind: 'system' }),
            redeemed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe('23514');
    // Redemption history is append-only.
    let mutation: unknown;
    try {
      await t.db
        .updateTable('package_redemptions')
        .set({ reason: 'rewritten' })
        .where('package_entitlement_id', '=', entitlementId)
        .execute();
    } catch (error) {
      mutation = error;
    }
    expect(isRestrictViolation(mutation)).toBe(true);
    // A package booking always names its entitlement.
    expect(
      await rejectsWith(
        t.db
          .insertInto('session_bookings')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            offering_id: target.offeringId,
            session_id: sessions[5]!,
            participant_person_id: (await adult(t)).personId,
            kind: 'session',
            status: 'confirmed',
            entitlement_basis: 'package',
            package_entitlement_id: null,
            scheduled_start: new Date('2026-11-25T02:00:00Z'),
            scheduled_end: new Date('2026-11-25T03:00:00Z'),
            booked_by: json({ kind: 'system' }),
            confirmed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe('23514');
    // The entitlement's own checks refuse a count beyond its credits.
    expect(
      await rejectsWith(
        t.db
          .updateTable('package_entitlements')
          .set({ redeemed_count: 2 })
          .where('id', '=', entitlementId)
          .execute(),
      ),
    ).toBe('23514');
  });

  it('DEC-016: redeeming while session_packages is disabled answers CAPABILITY_DISABLED; staff reversal still works', async () => {
    const buyer = await adult(t);
    const { entitlementId } = await buy(buyer, 2);
    const booked = await book(buyer, sessions[0]!, entitlementId);
    expect(booked.status).toBe(201);
    await t.disableCapability('session_packages');
    try {
      const refused = await book(buyer, sessions[1]!, entitlementId);
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'session_packages',
      });
      const redemption = await t.db
        .selectFrom('package_redemptions')
        .select('id')
        .where('package_entitlement_id', '=', entitlementId)
        .executeTakeFirstOrThrow();
      // The customer cannot reverse a redemption; staff can, switch or no switch.
      const denied = await post(
        t,
        `/v1/package-redemptions/${redemption.id}/reverse`,
        buyer.header,
        { reason: 'please' },
      );
      expect([403, 404]).toContain(denied.status);
      const reversed = await post(
        t,
        `/v1/package-redemptions/${redemption.id}/reverse`,
        frontDesk.header,
        { reason: 'Session was moved by the facility' },
      );
      expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
      expect(reversed.body).toMatchObject({ remainingCredits: 2, redeemedCount: 0 });
      const twice = await post(
        t,
        `/v1/package-redemptions/${redemption.id}/reverse`,
        frontDesk.header,
        { reason: 'again' },
      );
      expect(twice.status).toBe(409);
    } finally {
      await t.enableCapability('session_packages');
    }
  });

  it('POL-007, POL-039: a canceled package booking returns its credit only as the approved cancellation policy says', async () => {
    const policyId = await cancellationPolicy(t, {
      text: 'Credits return until a day before the session.',
      packageCreditReturn: { untilMinutesBeforeStart: 24 * 60 },
    });
    const buyer = await adult(t);
    const withPolicy = await buy(buyer, 3, { cancellationPolicyVersionId: policyId });
    // Well before the session: returned.
    const early = await book(buyer, sessions[5]!, withPolicy.entitlementId);
    expect(early.status).toBe(201);
    const canceledEarly = await post(
      t,
      `/v1/session-bookings/${early.body.id as string}/cancel`,
      buyer.header,
      { reason: 'cannot come', expectedRevision: early.body.revision },
    );
    expect(canceledEarly.status, JSON.stringify(canceledEarly.body)).toBe(200);
    expect(canceledEarly.body.creditDisposition).toBe('returned');
    // Inside the notice period: kept under the policy.
    const late = await book(buyer, sessions[0]!, withPolicy.entitlementId);
    expect(late.status).toBe(201);
    t.clock.set(new Date(Date.parse('2026-11-20T02:00:00Z') - 2 * HOUR));
    const canceledLate = await post(
      t,
      `/v1/session-bookings/${late.body.id as string}/cancel`,
      buyer.header,
      { reason: 'sick', expectedRevision: late.body.revision },
    );
    expect(canceledLate.body.creditDisposition).toBe('retained_by_policy');
    const row = await t.db
      .selectFrom('package_entitlements')
      .select('redeemed_count')
      .where('id', '=', withPolicy.entitlementId)
      .executeTakeFirstOrThrow();
    expect(row.redeemed_count).toBe(1);
    t.clock.set(new Date('2026-11-02T15:00:00Z'));

    // No policy stating a return: retained pending policy, nothing returned automatically.
    const other = await adult(t);
    const without = await buy(other, 2);
    const booked = await book(other, sessions[5]!, without.entitlementId);
    const canceled = await post(
      t,
      `/v1/session-bookings/${booked.body.id as string}/cancel`,
      other.header,
      { reason: 'changed plans', expectedRevision: booked.body.revision },
    );
    expect(canceled.body.creditDisposition).toBe('retained_pending_policy');
  });

  it('SPK-COND-002: a canceled purchase revokes the package and a future booking raises an owned exception', async () => {
    const buyer = await adult(t);
    const { enrollmentId, entitlementId } = await buy(buyer, 2);
    const booked = await book(buyer, sessions[3]!, entitlementId);
    expect(booked.status).toBe(201);
    const enrollment = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(frontDesk.header);
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, frontDesk.header, {
      reason: 'refunded at the desk',
      expectedRevision: enrollment.body.revision,
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drain(t);
    const row = await t.db
      .selectFrom('package_entitlements')
      .select(['status', 'revoked_reason'])
      .where('id', '=', entitlementId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'revoked', revoked_reason: 'purchase_canceled' });
    const booking = await t.db
      .selectFrom('session_bookings')
      .select('status')
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    expect(booking.status).toBe('confirmed');
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'affected_id'])
      .where('category', '=', 'enrollment.revoked_package_has_bookings')
      .where('affected_id', '=', entitlementId)
      .execute();
    expect(exceptions).toEqual([{ owner_queue: 'program_manager', affected_id: entitlementId }]);
    const refused = await book(buyer, sessions[4]!, entitlementId);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('PACKAGE_NOT_REDEEMABLE');
  });

  it('POL-039: a package expires exactly as its definition chose, through the expiry job', async () => {
    const buyer = await adult(t);
    const { entitlementId } = await buy(buyer, 2, {
      expiry: { kind: 'days_after_issue', days: 2 },
    });
    const row = await t.db
      .selectFrom('package_entitlements')
      .select(['issued_at', 'expires_at'])
      .where('id', '=', entitlementId)
      .executeTakeFirstOrThrow();
    expect(new Date(row.expires_at!).getTime() - new Date(row.issued_at).getTime()).toBe(2 * DAY);
    t.clock.advance(2 * DAY + 1000);
    try {
      await t.runPeriodicJobs([EXPIRE_PACKAGES_JOB]);
      const after = await t.db
        .selectFrom('package_entitlements')
        .select('status')
        .where('id', '=', entitlementId)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe('expired');
    } finally {
      t.clock.set(new Date('2026-11-02T15:00:00Z'));
    }
    // A fixed date expires at the next local midnight after it, in the facility zone.
    const fixed = await adult(t);
    const dated = await buy(fixed, 1, { expiry: { kind: 'fixed_date', date: '2026-12-31' } });
    const datedRow = await t.db
      .selectFrom('package_entitlements')
      .select('expires_at')
      .where('id', '=', dated.entitlementId)
      .executeTakeFirstOrThrow();
    const facility = await t.db
      .selectFrom('facilities')
      .select('timezone')
      .where('id', '=', t.facilityId)
      .executeTakeFirstOrThrow();
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: facility.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(datedRow.expires_at!));
    expect(local).toBe('2027-01-01, 00:00');
  });

  it('staff list packages in facility scope; a customer list needs a participant', async () => {
    const listed = await t.http.get('/v1/package-entitlements?limit=2').set(frontDesk.header);
    expect(listed.status).toBe(200);
    expect(listed.body.items.length).toBeLessThanOrEqual(2);
    const customer = await adult(t);
    const refused = await t.http.get('/v1/package-entitlements').set(customer.header);
    expect(refused.status).toBe(400);
  });
});
