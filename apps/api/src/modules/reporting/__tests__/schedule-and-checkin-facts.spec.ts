import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createOfferingSessionFixture } from '../../catalog';
import { createEnrollmentFixture } from '../../enrollment';
import { createAttendanceObservationFixture } from '../../entry';
import { createPersonFixture } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  seedOperatingHours,
  seedResource,
} from '../../scheduling';
import { get, post, reportingTestApp, staff, valueOf, type Actor } from './support';

type Row = Record<string, string | number | boolean | null>;

/** A day of its own for the schedule changes, and one for the check-ins. */
const SCHEDULE_DAY = '2027-02-10';
const CHECKIN_DAY = '2027-02-12';
const CHECKIN_ONLY_DAY = '2027-02-14';

/**
 * Facts the operating reports read as of the as-of instant (SPK-REPORT-002, metric dictionary G3):
 * MET-002 counts the changes recorded for a published event, never its first publication, however
 * that publication was reached (R3-REPORTING-01; SPK-SCHED-005, SPK-FIX-005); MET-009 and the
 * MET-069 observed-use overlay never count a check-in withdrawn by the as-of instant
 * (R3-REPORTING-07; SPK-ENTRY-008); a check-in is not attendance, so an activity with check-ins
 * and no observation has no MET-008 rate and leaves its denominator (R3-REPORTING-06; G13).
 */
describe('schedule changes and check-in withdrawals as of the as-of instant (SPK-REPORT-002)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let gm: Actor;
  let events: EventsService;
  let roomId: string;

  beforeAll(async () => {
    t = await reportingTestApp();
    scheduler = await staff(t, ['scheduler']);
    gm = await staff(t, ['general_manager']);
    events = t.app.get(EventsService);
    await seedOperatingHours(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    roomId = (
      await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Court 1',
        kind: 'room',
      })
    ).resourceId;
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-002 / SPK-SCHED-005 (R3-REPORTING-01): a draft published once by a schedule draft is not changed after publication; a later move is', async () => {
    const system = systemPrincipal(t.organizationId, 'tests');
    // A proposed fixture (a draft, as the solver or an import leaves it) published unchanged by a
    // schedule draft change targeting it: it is published at revision 2 (SPK-FIX-005).
    const proposed = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [roomId],
      start: at(SCHEDULE_DAY, '18:00'),
      end: at(SCHEDULE_DAY, '19:00'),
      status: 'draft',
      title: 'Proposed fixture',
    });
    const draft = await post(t, '/v1/schedule-drafts', scheduler, {
      facilityId: t.facilityId,
      name: 'Round 1',
      changes: [{ kind: 'create', targetEventId: proposed.id, proposed: { title: 'Round 1' } }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const published = await post(t, `/v1/schedule-drafts/${draft.body.id}/publish`, scheduler, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const row = await t.db
      .selectFrom('events')
      .select(['status', 'revision', 'published_revision'])
      .where('id', '=', proposed.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'published', revision: 2, published_revision: 2 });

    // An event published directly, then moved within the day after customers were told.
    const direct = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [roomId],
      start: at(SCHEDULE_DAY, '10:00'),
      end: at(SCHEDULE_DAY, '11:00'),
      title: 'Morning game',
    });
    const beforeMove = t.clock.now().toISOString();
    t.clock.advance(60_000);
    await events.moveEvent(system, direct.id, {
      scheduledStart: at(SCHEDULE_DAY, '11:00'),
      scheduledEnd: at(SCHEDULE_DAY, '12:00'),
      reason: 'Referee late',
    });
    t.clock.advance(60_000);

    const res = await get(t, '/v1/reports/daily-schedule', gm, {
      facilityId: t.facilityId,
      date: SCHEDULE_DAY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-001', 'Scheduled activities')).toBe(2);
    expect(valueOf(res.body, 'MET-002', 'Changed or canceled after publication')).toBe(1);
    expect(valueOf(res.body, 'MET-002', 'Changed or canceled share')).toBe(0.5);
    const rows = res.body.rows as Row[];
    expect(rows.find((r) => r.eventId === proposed.id)).toMatchObject({
      status: 'published',
      changedAfterPublication: false,
      changeTypes: '',
    });
    expect(rows.find((r) => r.eventId === direct.id)).toMatchObject({
      status: 'published',
      changedAfterPublication: true,
      changeTypes: 'moved',
    });

    // As of an instant before the move, nothing had changed after publication (G3).
    const earlier = await get(t, '/v1/reports/daily-schedule', gm, {
      facilityId: t.facilityId,
      date: SCHEDULE_DAY,
      asOf: beforeMove,
    });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(valueOf(earlier.body, 'MET-002', 'Changed or canceled after publication')).toBe(0);
    // Only the change facts honour the as-of instant: the row keeps the event's current times, and
    // the freshness note says so rather than claiming the rerun ignores the move (SPK-REPORT-007).
    expect((earlier.body.rows as Row[]).find((r) => r.eventId === direct.id)).toMatchObject({
      start: at(SCHEDULE_DAY, '11:00'),
      changeTypes: '',
    });
    expect(earlier.body.freshness.note).toContain(
      'publication, times, spaces, titles and the day an event falls on are taken as they stand now',
    );
    const definition = (
      res.body.metrics as Array<{ metricKey: string; numerator: string; exclusions: string[] }>
    ).find((m) => m.metricKey === 'MET-002')!;
    expect(definition.numerator).toContain('scheduling.event_changed');
    expect(definition.numerator).not.toContain('published revision');
    expect(definition.exclusions.join(' ')).toContain('the first publication itself');
  });

  it('SPK-REPORT-002 / SPK-ENTRY-008 (R3-REPORTING-07): a check-in withdrawn by the as-of instant is neither admitted (MET-009) nor evidence of use (MET-069)', async () => {
    t.clock.set(new Date(at(CHECKIN_DAY, '08:00')));
    const game = async (start: string, end: string) =>
      createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [roomId],
        start: at(CHECKIN_DAY, start),
        end: at(CHECKIN_DAY, end),
        kind: 'game',
      });
    const kept = await game('09:00', '10:00');
    const mistaken = await game('12:00', '13:00');
    // Written as the entry module leaves them (test helper only): admitted, then one withdrawn
    // (the status changes; the admission instant stays).
    const admit = async (eventId: string, start: string, end: string) => {
      const id = newId();
      await t.db
        .insertInto('session_checkins')
        .values({
          id,
          organization_id: t.organizationId,
          facility_id: t.facilityId,
          visit_id: null,
          person_id: await createPersonFixture(t, { kind: 'adult' }),
          activity_type: 'event',
          activity_id: eventId,
          offering_id: null,
          offering_session_id: null,
          scheduling_event_id: eventId,
          activity_start: new Date(at(CHECKIN_DAY, start)),
          activity_end: new Date(at(CHECKIN_DAY, end)),
          basis_kind: 'event_commitment',
          enrollment_id: null,
          session_booking_id: null,
          basis_reference: newId(),
          status: 'admitted',
          checked_in_at: t.clock.now(),
          evaluated_at: t.clock.now(),
          admitted_at: t.clock.now(),
          withdrawn_at: null,
          withdrawn_reason: null,
          recorded_by: json({ kind: 'system', actorLabel: 'reporting-tests' }),
          recorded_by_person_id: null,
        })
        .execute();
      return id;
    };
    t.clock.set(new Date(at(CHECKIN_DAY, '08:50')));
    await admit(kept.id, '09:00', '10:00');
    t.clock.set(new Date(at(CHECKIN_DAY, '11:50')));
    const wrong = await admit(mistaken.id, '12:00', '13:00');
    const beforeWithdrawal = t.clock.now().toISOString();
    t.clock.set(new Date(at(CHECKIN_DAY, '11:55')));
    await t.db
      .updateTable('session_checkins')
      .set({ status: 'withdrawn', withdrawn_at: t.clock.now(), withdrawn_reason: 'Wrong person' })
      .where('id', '=', wrong)
      .execute();
    t.clock.set(new Date(at(CHECKIN_DAY, '23:00')));

    const day = { facilityId: t.facilityId, from: CHECKIN_DAY, to: CHECKIN_DAY };
    const attendance = await get(t, '/v1/reports/attendance', gm, day);
    expect(attendance.status, JSON.stringify(attendance.body)).toBe(200);
    expect(valueOf(attendance.body, 'MET-009', 'Session check-ins admitted')).toBe(1);
    expect(
      valueOf(attendance.body, 'MET-009', 'Session check-ins withdrawn (not counted as admitted)'),
    ).toBe(1);
    // Before the withdrawal was recorded, both were admitted (G3).
    const earlier = await get(t, '/v1/reports/attendance', gm, { ...day, asOf: beforeWithdrawal });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(valueOf(earlier.body, 'MET-009', 'Session check-ins admitted')).toBe(2);
    expect(
      valueOf(earlier.body, 'MET-009', 'Session check-ins withdrawn (not counted as admitted)'),
    ).toBe(0);

    // Observed use: only the hour with an admitted, not withdrawn, check-in.
    const utilization = await get(t, '/v1/reports/utilization', gm, day);
    expect(utilization.status, JSON.stringify(utilization.body)).toBe(200);
    expect(valueOf(utilization.body, 'MET-069', 'Observed-use unit-hours')).toBeCloseTo(1, 4);
    const before = await get(t, '/v1/reports/utilization', gm, { ...day, asOf: beforeWithdrawal });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(valueOf(before.body, 'MET-069', 'Observed-use unit-hours')).toBeCloseTo(2, 4);
  });

  it('SPK-REPORT-002 / G13 (R3-REPORTING-06): a started session with check-ins and no attendance observation has no rate and leaves the MET-008 denominator; its check-ins still count for MET-009', async () => {
    t.clock.set(new Date(at(CHECKIN_ONLY_DAY, '08:00')));
    const managerId = (await staff(t, ['program_manager'])).personId;
    const { offeringId } = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'term',
      startsOn: CHECKIN_ONLY_DAY,
      endsOn: '2027-03-31',
      basePriceMinor: 9000,
    });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date(at(CHECKIN_ONLY_DAY, '17:00')),
      scheduledEnd: new Date(at(CHECKIN_ONLY_DAY, '18:00')),
    });
    const participants: Array<{ personId: string; enrollmentId: string }> = [];
    for (let i = 0; i < 4; i += 1) {
      const personId = await createPersonFixture(t, { kind: 'adult' });
      const enrollmentId = await createEnrollmentFixture(t, {
        offeringId,
        participantPersonId: personId,
      });
      participants.push({ personId, enrollmentId });
    }
    // Every expected participant is admitted at the desk (written as the entry module leaves an
    // admitted check-in; test helper only). Nobody takes attendance.
    t.clock.set(new Date(at(CHECKIN_ONLY_DAY, '16:55')));
    for (const { personId, enrollmentId } of participants) {
      await t.db
        .insertInto('session_checkins')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          facility_id: t.facilityId,
          visit_id: null,
          person_id: personId,
          activity_type: 'session',
          activity_id: sessionId,
          offering_id: offeringId,
          offering_session_id: sessionId,
          scheduling_event_id: null,
          activity_start: new Date(at(CHECKIN_ONLY_DAY, '17:00')),
          activity_end: new Date(at(CHECKIN_ONLY_DAY, '18:00')),
          basis_kind: 'enrollment',
          enrollment_id: enrollmentId,
          session_booking_id: null,
          basis_reference: newId(),
          status: 'admitted',
          checked_in_at: t.clock.now(),
          evaluated_at: t.clock.now(),
          admitted_at: t.clock.now(),
          withdrawn_at: null,
          withdrawn_reason: null,
          recorded_by: json({ kind: 'system', actorLabel: 'reporting-tests' }),
          recorded_by_person_id: null,
        })
        .execute();
    }
    t.clock.set(new Date(at(CHECKIN_ONLY_DAY, '20:00')));
    const day = { facilityId: t.facilityId, from: CHECKIN_ONLY_DAY, to: CHECKIN_ONLY_DAY };

    const res = await get(t, '/v1/reports/attendance', gm, day);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-009', 'Session check-ins admitted')).toBe(4);
    // A check-in is not an attendance observation (MET-007): no rate, never 0 (G13).
    expect(valueOf(res.body, 'MET-008', 'Attendance rate')).toBeNull();
    expect(
      valueOf(res.body, 'MET-008', 'Started activities with session check-ins only (no rate)'),
    ).toBe(1);
    expect(
      valueOf(
        res.body,
        'MET-008',
        'Expected participants of activities with session check-ins only',
      ),
    ).toBe(4);
    expect(
      valueOf(res.body, 'MET-008', 'Started activities without attendance captured (no rate)'),
    ).toBe(0);
    const row = (res.body.rows as Row[]).find((r) => r.activityId === sessionId)!;
    expect(row).toMatchObject({
      expected: 4,
      attended: 0,
      attendanceCapture: 'checkins_only',
      attendanceRate: null,
    });
    expect(row.rateUnavailableReason).toContain('check-ins only');
    const definition = (
      res.body.metrics as Array<{ metricKey: string; denominator: string; exclusions: string[] }>
    ).find((m) => m.metricKey === 'MET-008')!;
    expect(definition.denominator).toContain('attendance observation');
    expect(definition.denominator).not.toContain('check-in');
    const atCheckins = t.clock.now().toISOString();

    // Once attendance is taken for the session, it has a rate over its expected participants.
    t.clock.set(new Date(at(CHECKIN_ONLY_DAY, '20:05')));
    await createAttendanceObservationFixture(t, {
      personId: participants[0]!.personId,
      activity: { type: 'session', offeringId, sessionId },
      observedAt: new Date(at(CHECKIN_ONLY_DAY, '17:05')),
    });
    const observed = await get(t, '/v1/reports/attendance', gm, day);
    expect(observed.status, JSON.stringify(observed.body)).toBe(200);
    expect(valueOf(observed.body, 'MET-008', 'Attendance rate')).toBe(0.25);
    expect(
      valueOf(observed.body, 'MET-008', 'Started activities with session check-ins only (no rate)'),
    ).toBe(0);
    expect((observed.body.rows as Row[]).find((r) => r.activityId === sessionId)).toMatchObject({
      attendanceCapture: 'captured',
      attendanceRate: 0.25,
    });

    // Rerun as of the earlier instant, before the observation was received (G3).
    const rerun = await get(t, '/v1/reports/attendance', gm, { ...day, asOf: atCheckins });
    expect(rerun.status, JSON.stringify(rerun.body)).toBe(200);
    expect(valueOf(rerun.body, 'MET-008', 'Attendance rate')).toBeNull();
    expect((rerun.body.rows as Row[]).find((r) => r.activityId === sessionId)).toMatchObject({
      attendanceCapture: 'checkins_only',
    });
  });
});
