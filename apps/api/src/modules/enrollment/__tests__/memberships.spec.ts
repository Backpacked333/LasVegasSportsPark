import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createOfferingSessionFixture, createPolicyVersionFixture } from '../../catalog';
import { EntryModule } from '../../entry';
import { EnrollmentModule } from '../enrollment.module';
import { MEMBERSHIP_LIFECYCLE_JOB } from '../services/enrollment-jobs';
import { adultOffering, membershipOffering } from './package-g-support';
import { withStage3Doubles } from './stage3-doubles';
import {
  CLOCK_START,
  acknowledge,
  adult,
  basketWith,
  drain,
  offering,
  post,
  rejectsWith,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ENR-12: memberships (capability memberships; DEC-016, DEC-072). */
describe('memberships (ENR-12, SPK-COND-001)', () => {
  let t: TestApp;
  let frontDesk: Actor;
  let target: OfferingSetup;
  /** Sessions of the target offering: two in the week of Mon 2026-11-16, one the week after. */
  let week1: string[];
  let week2: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EnrollmentModule, EntryModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      capabilities: ['memberships', 'pickup_sessions'],
      configure: withStage3Doubles,
    });
    frontDesk = await staff(t, ['front_desk']);
    target = await adultOffering(t, 'session', { basePriceMinor: 2_500 });
    const session = (start: string) =>
      createOfferingSessionFixture(t, {
        offeringId: target.offeringId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(Date.parse(start) + HOUR),
      });
    week1 = [await session('2026-11-17T18:00:00Z'), await session('2026-11-19T18:00:00Z')];
    week2 = await session('2026-11-24T18:00:00Z');
  });
  afterAll(async () => {
    await t.close();
  });

  const includedWeekly = (count: number) => ({
    attendance: {
      mode: 'included_sessions',
      appliesTo: { offeringIds: [target.offeringId] },
      limit: { count, period: 'week', weekStartsOn: 1 },
    },
    term: { kind: 'offering_dates' },
    renewal: { noticeLeadDays: null },
  });

  /** A free membership, bought and confirmed through a basket; its term is set by the handler. */
  async function join(
    member: Actor,
    scope: Record<string, unknown>,
    dates: { startsOn?: string; endsOn?: string } = {},
  ) {
    const membership = await membershipOffering(t, scope, {
      startsOn: dates.startsOn ?? '2026-11-01',
      endsOn: dates.endsOn ?? '2027-01-31',
    });
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
    const done = await post(t, `/v1/baskets/${basket.id}/complete`, member.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await drain(t);
    return { membership, enrollmentId: done.body.lines[0].enrollmentId as string };
  }

  const book = (actor: Actor, sessionId: string, membershipEnrollmentId: string) =>
    post(t, '/v1/session-bookings', actor.header, {
      offeringId: target.offeringId,
      sessionId,
      participantPersonId: actor.personId,
      membershipEnrollmentId,
    });

  it('SPK-COND-001: a membership whose benefit is none or limited never books beyond its stated entitlement', async () => {
    const plain = await adult(t);
    const none = await join(plain, {
      attendance: { mode: 'none' },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: null },
    });
    const refused = await book(plain, week1[0]!, none.enrollmentId);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('MEMBERSHIP_INCLUDES_NO_SESSIONS');

    const member = await adult(t);
    const limited = await join(member, includedWeekly(1));
    const first = await book(member, week1[0]!, limited.enrollmentId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      status: 'confirmed',
      entitlementBasis: 'membership',
      membershipEnrollmentId: limited.enrollmentId,
      price: null,
    });
    const second = await book(member, week1[1]!, limited.enrollmentId);
    expect(second.status).toBe(409);
    expect(second.body.details).toMatchObject({
      code: 'MEMBERSHIP_SESSIONS_USED',
      periodKey: 'week:2026-11-16',
    });
    // The next week has its own allowance.
    expect((await book(member, week2, limited.enrollmentId)).status).toBe(201);
    // Canceling before the start gives the session back.
    const canceled = await post(
      t,
      `/v1/session-bookings/${first.body.id as string}/cancel`,
      member.header,
      { reason: 'swap days', expectedRevision: first.body.revision },
    );
    expect(canceled.body.creditDisposition).toBe('returned');
    expect((await book(member, week1[1]!, limited.enrollmentId)).status).toBe(201);
    const mine = await t.http.get('/v1/me/memberships').set(member.header);
    expect(mine.status).toBe(200);
    expect(mine.body.items[0]).toMatchObject({
      enrollmentId: limited.enrollmentId,
      status: 'confirmed',
      attendance: { mode: 'included_sessions', limit: { count: 1, period: 'week' } },
      usage: expect.arrayContaining([
        { periodKey: 'week:2026-11-16', usedCount: 1, limitCount: 1 },
        { periodKey: 'week:2026-11-23', usedCount: 1, limitCount: 1 },
      ]),
    });
    expect(mine.body.items[0].termStartsAt).not.toBeNull();

    // An offering the membership does not name is not included.
    const elsewhere = await adultOffering(t, 'session');
    const elsewhereSession = await createOfferingSessionFixture(t, {
      offeringId: elsewhere.offeringId,
      scheduledStart: new Date('2026-11-18T18:00:00Z'),
      scheduledEnd: new Date('2026-11-18T19:00:00Z'),
    });
    await acknowledge(t, elsewhere, member.personId, member.personId);
    const outside = await post(t, '/v1/session-bookings', member.header, {
      offeringId: elsewhere.offeringId,
      sessionId: elsewhereSession,
      participantPersonId: member.personId,
      membershipEnrollmentId: limited.enrollmentId,
    });
    expect(outside.status).toBe(422);
  });

  it('K-12 / DEC-016 / SPK-COND-001: a membership is not transferred, even with the switch off, so no termless membership is confirmed', async () => {
    const member = await adult(t);
    const { enrollmentId } = await join(member, includedWeekly(2));
    const other = await membershipOffering(t, includedWeekly(2), {
      startsOn: '2026-11-01',
      endsOn: '2027-01-31',
    });
    await acknowledge(t, other, member.personId, member.personId);
    const before = await t.db
      .selectFrom('enrollments')
      .select(['status', 'revision', 'membership_starts_at'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(before.status).toBe('confirmed');
    await t.disableCapability('memberships');
    try {
      const refused = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, member.header, {
        targetOfferingId: other.offeringId,
        expectedRevision: before.revision,
        commit: true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.details).toMatchObject({
        code: 'NOT_TRANSFERABLE',
        intent: 'membership',
      });
    } finally {
      await t.enableCapability('memberships');
    }
    const preview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/transfer-preview?targetOfferingId=${other.offeringId}`)
      .set(frontDesk.header);
    expect(preview.status).toBe(409);
    expect(preview.body.details.code).toBe('NOT_TRANSFERABLE');
    const created = await t.db
      .selectFrom('enrollments')
      .select('id')
      .where('transferred_from_enrollment_id', '=', enrollmentId)
      .execute();
    expect(created).toEqual([]);
    const after = await t.db
      .selectFrom('enrollments')
      .select(['status', 'revision', 'membership_starts_at'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('SPK-COND-001: an active membership without a session booking does not admit at check-in', async () => {
    const member = await adult(t);
    const unlimited = await join(member, {
      attendance: { mode: 'unlimited', appliesTo: { offeringIds: [target.offeringId] } },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: null },
    });
    // A session of the covered offering later today.
    const today = await createOfferingSessionFixture(t, {
      offeringId: target.offeringId,
      scheduledStart: new Date(t.clock.now().getTime() + HOUR),
      scheduledEnd: new Date(t.clock.now().getTime() + 2 * HOUR),
    });
    const checkin = () =>
      post(t, '/v1/session-checkins', frontDesk.header, {
        personId: member.personId,
        activity: { type: 'session', offeringId: target.offeringId, sessionId: today },
      });
    const held = await checkin();
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body.basis).toBeNull();
    expect(held.body.status).not.toBe('admitted');
    expect(held.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'no_participation' })]),
    );
    // With a booking through the membership, the booking is the basis.
    const booked = await book(member, today, unlimited.enrollmentId);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.membershipEnrollmentId).toBe(unlimited.enrollmentId);
    const recheck = await post(
      t,
      `/v1/session-checkins/${held.body.id as string}/recheck`,
      frontDesk.header,
      { expectedRevision: held.body.revision },
    );
    expect(recheck.status, JSON.stringify(recheck.body)).toBe(200);
    expect(recheck.body.basis).toMatchObject({ kind: 'session_booking' });
  });

  it('the database rejects overlapping active suspensions, a counter above its limit and a membership booking without its membership', async () => {
    const member = await adult(t);
    const { enrollmentId } = await join(member, includedWeekly(2));
    const suspension = (from: string, until: string | null) => ({
      id: newId(),
      organization_id: t.organizationId,
      enrollment_id: enrollmentId,
      participant_person_id: member.personId,
      suspended_from: new Date(from),
      suspended_until: until ? new Date(until) : null,
      reason: 'injury',
      created_by: json({ kind: 'system' }),
    });
    await t.db
      .insertInto('membership_suspensions')
      .values(suspension('2026-12-01T00:00:00Z', '2026-12-15T00:00:00Z'))
      .execute();
    expect(
      await rejectsWith(
        t.db
          .insertInto('membership_suspensions')
          .values(suspension('2026-12-10T00:00:00Z', null))
          .execute(),
      ),
    ).toBe('23P01');
    const booked = await book(member, week1[0]!, enrollmentId);
    expect(booked.status).toBe(201);
    expect(
      await rejectsWith(
        t.db
          .updateTable('membership_benefit_uses')
          .set({ used_count: 3 })
          .where('enrollment_id', '=', enrollmentId)
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('session_bookings')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            offering_id: target.offeringId,
            session_id: week2,
            participant_person_id: member.personId,
            kind: 'session',
            status: 'confirmed',
            entitlement_basis: 'membership',
            membership_enrollment_id: null,
            scheduled_start: new Date('2026-11-24T18:00:00Z'),
            scheduled_end: new Date('2026-11-24T19:00:00Z'),
            booked_by: json({ kind: 'system' }),
            confirmed_at: t.clock.now(),
          })
          .execute(),
      ),
    ).toBe('23514');
  });

  it('SPK-COND-001: suspensions stop bookings in their period; ending one restores them; overlaps are refused', async () => {
    const member = await adult(t);
    const { enrollmentId } = await join(member, includedWeekly(3));
    const suspended = await post(
      t,
      `/v1/enrollments/${enrollmentId}/membership-suspensions`,
      frontDesk.header,
      { from: '2026-11-16T00:00:00Z', until: '2026-11-21T00:00:00Z', reason: 'travel' },
    );
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(201);
    const overlap = await post(
      t,
      `/v1/enrollments/${enrollmentId}/membership-suspensions`,
      frontDesk.header,
      { from: '2026-11-20T00:00:00Z', reason: 'again' },
    );
    expect(overlap.status).toBe(409);
    expect(overlap.body.details.code).toBe('SUSPENSION_OVERLAP');
    const refused = await book(member, week1[0]!, enrollmentId);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('MEMBERSHIP_SUSPENDED');
    // A customer cannot end it; staff can.
    const denied = await post(
      t,
      `/v1/membership-suspensions/${suspended.body.id as string}/end`,
      member.header,
      { reason: 'back', expectedRevision: suspended.body.revision },
    );
    expect([403, 404]).toContain(denied.status);
    const ended = await post(
      t,
      `/v1/membership-suspensions/${suspended.body.id as string}/end`,
      frontDesk.header,
      { reason: 'back early', expectedRevision: suspended.body.revision },
    );
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
    expect((await book(member, week1[0]!, enrollmentId)).status).toBe(201);
  });

  it('SPK-COND-001, POL-038: member-only eligibility needs a confirmed, unsuspended membership covering the date', async () => {
    const member = await adult(t);
    const { membership } = await join(member, includedWeekly(1));
    const policy = await createPolicyVersionFixture(t, {
      kind: 'eligibility',
      content: { membershipRequired: { offeringIds: [membership.offeringId] } },
    });
    const membersOnly = await offering(t, {
      kind: 'term',
      basePriceMinor: 0,
      ageBand: { minAgeYears: 18 },
      eligibilityPolicyVersionId: policy,
      startsOn: '2026-12-01',
      endsOn: '2026-12-20',
    });
    const outsider = await adult(t);
    const reasonsOf = async (actor: Actor) => {
      const res = await t.http
        .get(
          `/v1/offerings/${membersOnly.offeringId}/registration-options?participantPersonIds=${actor.personId}`,
        )
        .set(actor.header);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const intent = res.body.participants[0].intents[0];
      return (intent.eligibility.reasons as Array<{ code: string }>).map((r) => r.code);
    };
    expect(await reasonsOf(outsider)).toContain('MEMBERSHIP_REQUIRED');
    expect(await reasonsOf(member)).not.toContain('MEMBERSHIP_REQUIRED');
  });

  it('SPK-COND-001: renewal adds a linked line; the lifecycle job sends one renewal notice and completes the term', async () => {
    const member = await adult(t);
    const expiring = await join(
      member,
      {
        attendance: { mode: 'none' },
        term: { kind: 'offering_dates' },
        renewal: { noticeLeadDays: 30 },
      },
      { startsOn: '2026-10-01', endsOn: '2026-11-20' },
    );
    await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
    await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
    const notices = await t.db
      .selectFrom('notifications')
      .select(['id', 'kind'])
      .where('kind', '=', 'renewal_opportunity')
      .where('subject_id', '=', expiring.enrollmentId)
      .execute();
    expect(notices).toHaveLength(1);

    const next = await membershipOffering(
      t,
      {
        attendance: { mode: 'none' },
        term: { kind: 'offering_dates' },
        renewal: { noticeLeadDays: null },
      },
      { startsOn: '2026-11-21', endsOn: '2027-02-28' },
    );
    await acknowledge(t, next, member.personId, member.personId);
    const renewed = await post(t, `/v1/enrollments/${expiring.enrollmentId}/renew`, member.header, {
      targetOfferingId: next.offeringId,
    });
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(201);
    expect(renewed.body.lines).toEqual([
      expect.objectContaining({ offeringId: next.offeringId, intent: 'membership' }),
    ]);
    const line = await t.db
      .selectFrom('basket_lines')
      .select('renewed_from_enrollment_id')
      .where('basket_id', '=', renewed.body.id)
      .executeTakeFirstOrThrow();
    expect(line.renewed_from_enrollment_id).toBe(expiring.enrollmentId);

    // Renewal is a new sale: refused while memberships is disabled.
    await t.disableCapability('memberships');
    try {
      const refused = await post(
        t,
        `/v1/enrollments/${expiring.enrollmentId}/renew`,
        member.header,
        { targetOfferingId: next.offeringId },
      );
      expect(refused.status).toBe(403);
      expect(refused.body.details.code).toBe('CAPABILITY_DISABLED');
    } finally {
      await t.enableCapability('memberships');
    }

    t.clock.set(new Date('2026-11-22T12:00:00Z'));
    try {
      await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
      const row = await t.db
        .selectFrom('enrollments')
        .select('status')
        .where('id', '=', expiring.enrollmentId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('completed');
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('SPK-COND-001: a from_confirmation term runs its stated length from confirmation', async () => {
    const member = await adult(t);
    const { enrollmentId } = await join(member, {
      attendance: { mode: 'none' },
      term: { kind: 'from_confirmation', lengthDays: 30 },
      renewal: { noticeLeadDays: null },
    });
    const row = await t.db
      .selectFrom('enrollments')
      .select(['confirmed_at', 'membership_starts_at', 'membership_ends_at'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(new Date(row.membership_starts_at!).getTime()).toBe(
      new Date(row.confirmed_at!).getTime(),
    );
    expect(
      new Date(row.membership_ends_at!).getTime() - new Date(row.membership_starts_at!).getTime(),
    ).toBe(30 * DAY);
  });
});
