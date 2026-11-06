import { newId, type OfferingKind } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { EntryModule, createAttendanceObservationFixture } from '../../entry';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { EnrollmentModule } from '../enrollment.module';
import {
  createCapacityPoolFixture,
  createEnrollmentFixture,
  createHoldFixture,
} from '../testing/enrollment-fixtures';
import {
  CLOCK_START,
  acknowledge,
  adult,
  child,
  offering,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';
import { withStage3Doubles } from './stage3-doubles';

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

/**
 * Park UI overview reads (docs/design/park-ui-redesign.md "Grow" and "Customer app"): enrollment
 * by age, form completion and waitlist counts across offerings; the organization-wide waitlist;
 * a person's activities with recent attendance (through entry's ATTENDANCE_PORT); "picked for
 * <child>" suggestions by age band; and live availability for the camp week picker.
 */
describe('enrollment park UI overview reads', () => {
  let t: TestApp;
  let pm: Actor;
  let frontDesk: Actor;
  let coach: Actor;
  let eastPm: Actor;
  let guardian: Actor;
  let eastFacilityId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EnrollmentModule, EntryModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      configure: withStage3Doubles,
    });
    eastFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: eastFacilityId,
        organization_id: t.organizationId,
        slug: 'east',
        name: 'East complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    pm = await staff(t, ['program_manager']);
    frontDesk = await staff(t, ['front_desk']);
    coach = await staff(t, ['coach']);
    const east = await createStaffMemberFixture(t, {
      roles: ['program_manager'],
      facilityIds: [eastFacilityId],
    });
    eastPm = {
      personId: east.personId,
      accountId: east.accountId,
      header: await authHeaderForPerson(t, east.personId),
    };
    guardian = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function poolOf(setup: { offeringId: string }, capacity = 20): Promise<string> {
    return createCapacityPoolFixture(t, { offeringId: setup.offeringId, capacity });
  }

  async function waitlistEntry(
    setup: { offeringId: string },
    poolId: string,
    participantPersonId: string,
    options: { offered?: boolean } = {},
  ): Promise<string> {
    const id = newId();
    const now = t.clock.now();
    await t.db
      .insertInto('waitlist_entries')
      .values({
        id,
        organization_id: t.organizationId,
        offering_id: setup.offeringId,
        pool_id: poolId,
        participant_person_id: participantPersonId,
        intent: 'youth',
        joined_at: now,
        queued_at: now,
        requested_by: json(FIXTURE_ACTOR),
        status: options.offered ? 'offered' : 'waiting',
        offer_count: options.offered ? 1 : 0,
      })
      .execute();
    if (options.offered) {
      const holdId = await createHoldFixture(t, {
        poolId,
        ownerKind: 'waitlist_offer',
        expiresAt: new Date(now.getTime() + 86_400_000),
      });
      await t.db
        .insertInto('waitlist_offers')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          waitlist_entry_id: id,
          pool_id: poolId,
          hold_id: holdId,
          quantity: 1,
          offered_at: now,
          expires_at: new Date(now.getTime() + 86_400_000),
        })
        .execute();
    }
    t.clock.advance(1000);
    return id;
  }

  describe('offering enrollment summaries (programs overview, camp readiness)', () => {
    it('SPK-REG-005/SPK-REG-008: counts enrollment by age on the reference date, form completion and the waitlist, without any child data', async () => {
      const camp = await offering(t, { kind: 'camp', startsOn: '2027-01-10' });
      const other = await offering(t, { kind: 'term', programId: camp.programId });
      const kids = {
        eight: await child(t, [guardian], { dateOfBirth: '2018-05-01' }),
        alsoEight: await child(t, [guardian], { dateOfBirth: '2018-12-01' }),
        ten: await child(t, [guardian], { dateOfBirth: '2016-01-15' }),
        unknown: await child(t, [guardian], { dateOfBirth: null as unknown as string }),
        canceled: await child(t, [guardian], { dateOfBirth: '2017-03-03' }),
      };
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: kids.eight,
      });
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: kids.alsoEight,
        status: 'pending',
      });
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: kids.ten,
      });
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: kids.unknown,
      });
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: kids.canceled,
        status: 'canceled',
      });
      await acknowledge(t, camp, kids.eight, guardian.personId);
      await acknowledge(t, camp, kids.ten, guardian.personId);
      const pool = await poolOf(camp, 4);
      await waitlistEntry(camp, pool, await child(t, [guardian]));
      await waitlistEntry(camp, pool, await child(t, [guardian]));
      await waitlistEntry(camp, pool, await child(t, [guardian]), { offered: true });

      const unknownId = newId();
      const res = await t.http
        .get('/v1/offering-enrollment-summaries')
        .set(pm.header)
        .query({ offeringIds: [camp.offeringId, other.offeringId, unknownId].join(',') });
      expect(res.status).toBe(200);
      expect(res.body.unavailableOfferingIds).toEqual([unknownId]);
      const [summary, otherSummary] = res.body.items;
      expect(summary).toEqual({
        offeringId: camp.offeringId,
        referenceDate: '2027-01-10',
        enrolled: { confirmed: 3, pending: 1 },
        byAge: [
          { ageYears: 8, confirmed: 1, pending: 1 },
          { ageYears: 10, confirmed: 1, pending: 0 },
          { ageYears: null, confirmed: 1, pending: 0 },
        ],
        forms: {
          requiredFormCount: 1,
          participantCount: 4,
          participantsComplete: 2,
          percentComplete: 50,
        },
        waitlist: { waiting: 2, offered: 1 },
      });
      expect(otherSummary).toMatchObject({
        offeringId: other.offeringId,
        enrolled: { confirmed: 0, pending: 0 },
        byAge: [],
        forms: { participantCount: 0, percentComplete: null },
        waitlist: { waiting: 0, offered: 0 },
      });
      // §4.14: counts only; no participant id or date of birth leaves the read.
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(kids.eight);
      expect(text).not.toContain('2018-05-01');
    });

    it('§4.3/§4.14: a facility-scoped reader gets only their facilities; a role without the action is refused', async () => {
      const main = await offering(t);
      const east = await offering(t);
      await t.db
        .updateTable('offerings')
        .set({ facility_id: eastFacilityId })
        .where('id', '=', east.offeringId)
        .execute();
      const ids = [main.offeringId, east.offeringId].join(',');
      const scoped = await t.http
        .get('/v1/offering-enrollment-summaries')
        .set(eastPm.header)
        .query({ offeringIds: ids });
      expect(scoped.status).toBe(200);
      expect(scoped.body.items.map((i: { offeringId: string }) => i.offeringId)).toEqual([
        east.offeringId,
      ]);
      expect(scoped.body.unavailableOfferingIds).toEqual([main.offeringId]);
      expect(
        (
          await t.http
            .get('/v1/offering-enrollment-summaries')
            .set(coach.header)
            .query({ offeringIds: ids })
        ).status,
      ).toBe(403);
      expect(
        (
          await t.http
            .get('/v1/offering-enrollment-summaries')
            .set(guardian.header)
            .query({ offeringIds: ids })
        ).status,
      ).toBe(403);
      expect(
        (
          await t.http
            .get('/v1/offering-enrollment-summaries')
            .set(pm.header)
            .query({ offeringIds: 'not-an-id' })
        ).status,
      ).toBe(400);
    });
  });

  describe('organization-wide waitlist (registrations home)', () => {
    it('SPK-REG-008: lists live entries across offerings with the offering and open offer, counts and keyset pages; staff admin only', async () => {
      const a = await offering(t, { kind: 'camp' });
      const b = await offering(t, { kind: 'term' });
      const poolA = await poolOf(a, 10);
      const poolB = await poolOf(b, 10);
      const first = await waitlistEntry(a, poolA, await child(t, [guardian]));
      const second = await waitlistEntry(b, poolB, await child(t, [guardian]), { offered: true });
      const withdrawn = await waitlistEntry(b, poolB, await child(t, [guardian]));
      await t.db
        .updateTable('waitlist_entries')
        .set({ status: 'withdrawn', withdrawn_at: t.clock.now() })
        .where('id', '=', withdrawn)
        .execute();

      const mine = (res: { body: { items: Array<{ id: string }> } }) =>
        res.body.items.map((i) => i.id).filter((id) => [first, second, withdrawn].includes(id));
      const forBoth = (extra: Record<string, string | number> = {}) =>
        t.http
          .get('/v1/waitlist-queue')
          .set(pm.header)
          .query({ limit: 200, ...extra });

      const all = await forBoth();
      expect(all.status).toBe(200);
      expect(mine(all)).toEqual([second, first]);
      const offered = all.body.items.find((i: { id: string }) => i.id === second);
      expect(offered).toMatchObject({
        status: 'offered',
        offering: { id: b.offeringId, kind: 'term', facilityId: t.facilityId },
        openOffer: { status: 'offered', expiresAt: expect.any(String) },
      });
      expect(all.body.counts.waiting).toBeGreaterThanOrEqual(1);
      expect(all.body.counts.offered).toBeGreaterThanOrEqual(1);

      const onlyB = await forBoth({ offeringId: b.offeringId });
      expect(onlyB.body.items.map((i: { id: string }) => i.id)).toEqual([second]);
      expect(onlyB.body.counts).toEqual({ waiting: 0, offered: 1 });
      const withdrawnOnly = await forBoth({ offeringId: b.offeringId, status: 'withdrawn' });
      expect(withdrawnOnly.body.items.map((i: { id: string }) => i.id)).toEqual([withdrawn]);

      const page1 = await t.http
        .get('/v1/waitlist-queue')
        .set(pm.header)
        .query({ offeringId: a.offeringId, limit: 1 });
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toBeNull();

      // facility scope and staff-only
      const east = await t.http.get('/v1/waitlist-queue').set(eastPm.header);
      expect(east.status).toBe(200);
      expect(mine(east)).toEqual([]);
      expect((await t.http.get('/v1/waitlist-queue').set(frontDesk.header)).status).toBe(403);
      expect((await t.http.get('/v1/waitlist-queue').set(guardian.header)).status).toBe(403);
    });
  });

  describe('person activities with recent attendance (person record)', () => {
    it('SPK-ENTRY-005/SPK-SUPPORT-001: each enrollment carries the attendance of its last 8 started sessions', async () => {
      const kid = await child(t, [guardian]);
      const setup = await offering(t, { kind: 'term' });
      await createEnrollmentFixture(t, { offeringId: setup.offeringId, participantPersonId: kid });
      const now = t.clock.now().getTime();
      const hour = 3_600_000;
      const sessions: string[] = [];
      // ten past sessions (oldest first), one canceled, and one in the future
      for (let i = 10; i >= 1; i -= 1) {
        sessions.push(
          await createOfferingSessionFixture(t, {
            offeringId: setup.offeringId,
            scheduledStart: new Date(now - i * 24 * hour),
            scheduledEnd: new Date(now - i * 24 * hour + hour),
            status: i === 2 ? 'canceled' : 'scheduled',
          }),
        );
      }
      await createOfferingSessionFixture(t, {
        offeringId: setup.offeringId,
        scheduledStart: new Date(now + 24 * hour),
        scheduledEnd: new Date(now + 25 * hour),
      });
      const activity = (sessionId: string) => ({
        type: 'session' as const,
        offeringId: setup.offeringId,
        sessionId,
      });
      // newest session (i=1): present; i=3: late; i=4: absent; i=5: conflict (present + absent)
      await createAttendanceObservationFixture(t, {
        personId: kid,
        activity: activity(sessions[9]!),
      });
      await createAttendanceObservationFixture(t, {
        personId: kid,
        activity: activity(sessions[7]!),
        observedState: 'late',
      });
      await createAttendanceObservationFixture(t, {
        personId: kid,
        activity: activity(sessions[6]!),
        observedState: 'absent',
      });
      await createAttendanceObservationFixture(t, {
        personId: kid,
        activity: activity(sessions[5]!),
      });
      await createAttendanceObservationFixture(t, {
        personId: kid,
        activity: activity(sessions[5]!),
        observedState: 'absent',
      });

      const res = await t.http.get(`/v1/participants/${kid}/activities`).set(frontDesk.header);
      expect(res.status).toBe(200);
      expect(res.body.personId).toBe(kid);
      const [item] = res.body.items;
      expect(item.enrollment).toMatchObject({ offeringId: setup.offeringId, status: 'confirmed' });
      expect(item.recentSessions).toHaveLength(8);
      expect(item.recentSessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(
        [...sessions].reverse().slice(0, 8),
      );
      expect(
        item.recentSessions.map((s: { attendance: string | null; conflict: boolean }) =>
          s.conflict ? 'conflict' : s.attendance,
        ),
      ).toEqual(['present', null, 'late', 'absent', 'conflict', null, null, null]);
      expect(item.recentSessions[1].sessionStatus).toBe('canceled');
      expect(item.attendance).toEqual({ held: 7, attended: 2, recorded: 4 });

      // the guardian (view) reads it; the coach and another household are answered not found
      expect(
        (await t.http.get(`/v1/participants/${kid}/activities`).set(guardian.header)).status,
      ).toBe(200);
      const stranger = await adult(t);
      expect(
        (await t.http.get(`/v1/participants/${kid}/activities`).set(stranger.header)).status,
      ).toBe(404);
      expect(
        (await t.http.get(`/v1/participants/${kid}/activities`).set(coach.header)).status,
      ).toBe(404);
    });
  });

  describe('customer app: picked for a child, camp week availability', () => {
    let camp: OfferingSetup;
    let teens: OfferingSetup;
    let noBand: OfferingSetup;
    let taken: OfferingSetup;
    let maya: string;

    beforeAll(async () => {
      const make = (kind: OfferingKind, ageBand: { minAgeYears?: number; maxAgeYears?: number }) =>
        offering(t, { kind, ageBand, startsOn: '2026-12-21', endsOn: '2026-12-24' });
      camp = await make('camp', { minAgeYears: 7, maxAgeYears: 9 });
      teens = await make('term', { minAgeYears: 13, maxAgeYears: 17 });
      noBand = await make('term', {});
      taken = await make('camp', { minAgeYears: 6, maxAgeYears: 12 });
      maya = await child(t, [guardian], { dateOfBirth: '2018-03-01' });
      await createEnrollmentFixture(t, { offeringId: taken.offeringId, participantPersonId: maya });
    });

    it('SPK-YOUTH-006/§4.14: suggestions are published offerings whose age band fits on the reference date, nothing already taken', async () => {
      const res = await t.http
        .get('/v1/me/offering-suggestions')
        .set(guardian.header)
        .query({ participantPersonId: maya, limit: 20 });
      expect(res.status).toBe(200);
      expect(res.body.basis).toBe('ok');
      const ids = res.body.items.map((i: { offering: { id: string } }) => i.offering.id);
      expect(ids).toContain(camp.offeringId);
      expect(ids).not.toContain(teens.offeringId);
      expect(ids).not.toContain(noBand.offeringId);
      expect(ids).not.toContain(taken.offeringId);
      const suggestion = res.body.items.find(
        (i: { offering: { id: string } }) => i.offering.id === camp.offeringId,
      );
      expect(suggestion.reason).toEqual({
        kind: 'age_band',
        ageYears: 8,
        referenceDate: '2026-12-21',
      });
      expect(suggestion.offering.promotions).toEqual([]);
    });

    it('§4.10: suggestions only for someone the caller may register; no date of birth gives no suggestion', async () => {
      const stranger = await adult(t);
      expect(
        (
          await t.http
            .get('/v1/me/offering-suggestions')
            .set(stranger.header)
            .query({ participantPersonId: maya })
        ).status,
      ).toBe(404);
      expect(
        (
          await t.http
            .get('/v1/me/offering-suggestions')
            .set(pm.header)
            .query({ participantPersonId: maya })
        ).status,
      ).toBe(404);
      const unknownAge = await child(t, [guardian], { dateOfBirth: null as unknown as string });
      const res = await t.http
        .get('/v1/me/offering-suggestions')
        .set(guardian.header)
        .query({ participantPersonId: unknownAge });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        participantPersonId: unknownAge,
        basis: 'date_of_birth_unknown',
        items: [],
      });
    });

    it('SPK-REG-005: availability gives the places left of each week (holds count), published only for customers', async () => {
      const week2 = await offering(t, {
        kind: 'camp',
        startsOn: '2026-12-28',
        endsOn: '2026-12-31',
      });
      const draft = await offering(t, { kind: 'camp' });
      await t.db
        .updateTable('offerings')
        .set({ publication_state: 'draft', published_at: null })
        .where('id', '=', draft.offeringId)
        .execute();
      const pool = await poolOf(camp, 3);
      await createEnrollmentFixture(t, {
        offeringId: camp.offeringId,
        participantPersonId: await child(t, [guardian]),
      });
      await t.db
        .updateTable('capacity_pools')
        .set({ committed: 1 })
        .where('id', '=', pool)
        .execute();
      await createHoldFixture(t, { poolId: pool, quantity: 2 });
      await poolOf(draft, 5);
      const ids = [camp.offeringId, week2.offeringId, draft.offeringId].join(',');
      const res = await t.http
        .get('/v1/offering-availability')
        .set(guardian.header)
        .query({ offeringIds: ids });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        { offeringId: camp.offeringId, status: 'full', unit: 'seats', capacity: 3, remaining: 0 },
        {
          offeringId: week2.offeringId,
          status: 'not_configured',
          unit: null,
          capacity: null,
          remaining: null,
        },
      ]);
      expect(res.body.unavailableOfferingIds).toEqual([draft.offeringId]);
      // staff who read capacity there also see the draft
      const staffRes = await t.http
        .get('/v1/offering-availability')
        .set(pm.header)
        .query({ offeringIds: draft.offeringId });
      expect(staffRes.body.items).toEqual([
        {
          offeringId: draft.offeringId,
          status: 'available',
          unit: 'seats',
          capacity: 5,
          remaining: 5,
        },
      ]);
    });
  });
});
