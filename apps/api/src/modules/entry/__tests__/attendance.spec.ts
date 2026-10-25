import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  personCommitment,
  seedPitchWithHalves,
} from '../../scheduling';
import { createAssignmentFixture } from '../../workforce';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  exceptionsOf,
  family,
  key,
  post,
  program,
  sessionRef,
  staffMember,
  TODAY,
  type Actor,
  type Family,
  type Program,
} from './support';

describe('attendance observations and corrections (§4.8, SPK-ENTRY-005, §4.5)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let coach: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    coach = await staffMember(t, ['coach']);
    fam = await family(t, desk, ['view', 'pay', 'register', 'collect']);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    await enroll(t, p, fam.childB, fam.guardian.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const observe = (actor: Actor, body: object, idempotencyKey?: string) =>
    post(t, '/v1/attendance-observations', actor, body, idempotencyKey);

  it('§4.8: desk staff record an activity-specific observation with actor and received time', async () => {
    const res = await observe(desk, {
      personId: fam.childA,
      activity: sessionRef(p),
      observedState: 'present',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      duplicate: false,
      conflict: null,
      observation: {
        personId: fam.childA,
        observedState: 'present',
        source: 'online',
        activity: { type: 'session', id: p.sessionId, offeringId: p.offering.offeringId },
        recordedBy: { personId: desk.personId, kind: 'staff' },
        correctsObservationId: null,
      },
    });
    expect(res.body.observation.receivedAt).toBe(t.clock.now().toISOString());
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', res.body.observation.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['entry.attendance_observed']);
    expect(JSON.stringify(events[0]!.payload)).not.toContain('Ava');
  });

  it('SPK-UX-007: a coach records attendance only for an activity they hold an accepted assignment for', async () => {
    const body = { personId: fam.childB, activity: sessionRef(p), observedState: 'present' };
    const unassigned = await observe(coach, body);
    expect(unassigned.status).toBe(403);
    expect(unassigned.body.details).toMatchObject({ code: 'not_assigned' });
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: p.sessionId,
      offeringId: p.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      role: 'head_coach',
      status: 'offered',
      scheduledStart: p.start,
      scheduledEnd: p.end,
    });
    const offeredOnly = await observe(coach, body);
    expect(offeredOnly.status).toBe(403);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: p.sessionId,
      offeringId: p.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      role: 'assistant_coach',
      status: 'accepted',
      scheduledStart: p.start,
      scheduledEnd: p.end,
    });
    const assigned = await observe(coach, body);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    expect(assigned.body.observation.recordedBy.personId).toBe(coach.personId);
    // A customer is never an attendance recorder.
    const customer = await observe(fam.guardian, body);
    expect(customer.status).toBe(403);
  });

  it('SPK-ENTRY-005: a correction is a new row with actor, time and reason; the original is never changed', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, fam.guardian.personId);
    const original = await observe(desk, {
      personId: child,
      activity: sessionRef(p),
      observedState: 'absent',
    });
    expect(original.status).toBe(201);
    const before = await t.db
      .selectFrom('attendance_observations')
      .selectAll()
      .where('id', '=', original.body.observation.id)
      .executeTakeFirstOrThrow();
    t.clock.advance(10 * 60_000);
    const noReason = await post(
      t,
      `/v1/attendance-observations/${original.body.observation.id}/corrections`,
      manager,
      { observedState: 'present' },
    );
    expect(noReason.status).toBe(400);
    const corrected = await post(
      t,
      `/v1/attendance-observations/${original.body.observation.id}/corrections`,
      manager,
      { observedState: 'late', reason: 'Arrived at 10:20 with a parent' },
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.observation).toMatchObject({
      correctsObservationId: original.body.observation.id,
      correctionReason: 'Arrived at 10:20 with a parent',
      observedState: 'late',
      observedAt: original.body.observation.observedAt,
      receivedAt: t.clock.now().toISOString(),
      recordedBy: { personId: manager.personId },
    });
    const after = await t.db
      .selectFrom('attendance_observations')
      .selectAll()
      .where('id', '=', original.body.observation.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'actor'])
      .where('target_id', '=', corrected.body.observation.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: 'entry.correct_attendance',
      reason: 'Arrived at 10:20 with a parent',
    });

    const again = await post(
      t,
      `/v1/attendance-observations/${original.body.observation.id}/corrections`,
      manager,
      { observedState: 'present', reason: 'Second opinion' },
    );
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({
      code: 'already_corrected',
      correctedByObservationId: corrected.body.observation.id,
    });
    const chained = await post(
      t,
      `/v1/attendance-observations/${corrected.body.observation.id}/corrections`,
      manager,
      { observedState: 'present', reason: 'Was on time after all' },
    );
    expect(chained.status).toBe(201);

    const view = await t.http
      .get(
        `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}&personId=${child}`,
      )
      .set(desk.header);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const person = view.body.people[0];
    expect(person).toMatchObject({
      personId: child,
      effectiveState: 'present',
      status: 'recorded',
      currentObservationIds: [chained.body.observation.id],
    });
    expect(person.history.map((h: { observedState: string }) => h.observedState)).toEqual([
      'absent',
      'late',
      'present',
    ]);
    expect(person.history[0].correctedByObservationId).toBe(corrected.body.observation.id);
  });

  it('§4.15: independent observations that disagree are both kept, flagged and raised for review', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, fam.guardian.personId);
    const present = await observe(desk, {
      personId: child,
      activity: sessionRef(p),
      observedState: 'present',
    });
    const absent = await observe(coach, {
      personId: child,
      activity: sessionRef(p),
      observedState: 'absent',
    });
    expect(absent.status, JSON.stringify(absent.body)).toBe(201);
    expect(absent.body.observation.flags).toEqual(['conflict']);
    expect(absent.body.conflict).toMatchObject({
      conflictingObservationIds: [present.body.observation.id, absent.body.observation.id],
    });
    const raised = await exceptionsOf(t, 'entry.attendance_conflict');
    const mine = raised.find((e) => e.id === absent.body.conflict.exceptionId)!;
    expect(mine).toMatchObject({ owner_queue: 'program_manager', status: 'open' });
    const view = await t.http
      .get(
        `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}&personId=${child}`,
      )
      .set(desk.header);
    expect(view.body.people[0]).toMatchObject({ status: 'conflict', effectiveState: null });
    expect(view.body.people[0].currentObservationIds).toHaveLength(2);
    // Late is still attendance: no conflict with present.
    const late = await observe(desk, {
      personId: fam.childA,
      activity: sessionRef(p),
      observedState: 'late',
    });
    expect(late.body.conflict).toBeNull();
    // A reviewer resolves the conflict with a correction naming the effective state.
    const resolved = await post(
      t,
      `/v1/attendance-observations/${absent.body.observation.id}/corrections`,
      manager,
      { observedState: 'present', reason: 'Coach marked the wrong row' },
    );
    expect(resolved.status).toBe(201);
    expect(resolved.body.conflict).toBeNull();
    const after = await t.http
      .get(
        `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}&personId=${child}`,
      )
      .set(desk.header);
    expect(after.body.people[0]).toMatchObject({ status: 'recorded', effectiveState: 'present' });
  });

  it('records a client observation once (idempotent per device) and replays an idempotency key', async () => {
    const clientObservationId = newId();
    const body = {
      personId: fam.childB,
      activity: sessionRef(p),
      observedState: 'present',
      clientObservationId,
      deviceId: 'tablet-7',
    };
    const first = await observe(desk, body);
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    const second = await observe(desk, body);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      duplicate: true,
      observation: { id: first.body.observation.id },
    });
    const idem = key();
    const once = await observe(desk, { ...body, clientObservationId: newId() }, idem);
    const replay = await observe(
      desk,
      { ...body, clientObservationId: once.body.observation.clientObservationId },
      idem,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(once.body);
    const rows = await t.db
      .selectFrom('attendance_observations')
      .select('id')
      .where('device_id', '=', 'tablet-7')
      .execute();
    expect(rows).toHaveLength(2);
    const future = await observe(desk, {
      personId: fam.childB,
      activity: sessionRef(p),
      observedState: 'present',
      observedAt: new Date(t.clock.now().getTime() + 60 * 60_000).toISOString(),
    });
    expect(future.status).toBe(400);
  });

  it('attendance is protected: a guardian reads their child only, a stranger gets NOT_FOUND', async () => {
    const path = `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}`;
    const own = await t.http.get(`${path}&personId=${fam.childA}`).set(fam.guardian.header);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.people.map((x: { personId: string }) => x.personId)).toEqual([fam.childA]);
    const everyone = await t.http.get(path).set(fam.guardian.header);
    expect(everyone.status).toBe(404);
    const stranger = await adultCustomer(t);
    const peek = await t.http.get(`${path}&personId=${fam.childA}`).set(stranger.header);
    expect(peek.status).toBe(404);
    const assignedCoach = await t.http.get(path).set(coach.header);
    expect(assignedCoach.status).toBe(200);
    expect(assignedCoach.body.people.length).toBeGreaterThanOrEqual(2);
  });

  it('§4.14 field-level: a guardian reads the history of their child without staff or device identifiers; staff see them', async () => {
    const path = `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}&personId=${fam.childA}`;
    const own = await t.http.get(path).set(fam.guardian.header);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const history = own.body.people[0].history as Array<Record<string, unknown>>;
    expect(history.length).toBeGreaterThan(0);
    for (const row of history) {
      expect(row['recordedBy']).toMatchObject({
        accountId: null,
        personId: null,
        sessionId: null,
        staffRoles: [],
      });
      expect(row).toMatchObject({ deviceId: null, syncBatchId: null, snapshotReference: null });
    }
    const staff = await t.http.get(path).set(desk.header);
    expect(staff.status).toBe(200);
    const recordedBy = (staff.body.people[0].history as Array<{ recordedBy: { personId: string } }>)
      .map((h) => h.recordedBy.personId)
      .filter((id) => id !== null);
    expect(recordedBy.length).toBeGreaterThan(0);
  });

  it('event activities: an assigned official records attendance; a committed player is admitted at check-in', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
    });
    const player = await createPersonFixture(t, { kind: 'adult' });
    const event = await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at(TODAY, '13:00'),
      end: at(TODAY, '14:00'),
      kind: 'practice',
      sourceType: 'program',
      commitments: [personCommitment(player, 'participant')],
    });
    const official = await staffMember(t, ['official']);
    const ref = { type: 'event', eventId: event.id };
    const denied = await observe(official, {
      personId: player,
      activity: ref,
      observedState: 'present',
    });
    expect(denied.status).toBe(403);
    await createAssignmentFixture(t, {
      targetType: 'event',
      targetId: event.id,
      personId: official.personId,
      kind: 'official',
      status: 'accepted',
      scheduledStart: event.scheduledStart,
      scheduledEnd: event.scheduledEnd,
    });
    const recorded = await observe(official, {
      personId: player,
      activity: ref,
      observedState: 'present',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.observation.activity).toMatchObject({ type: 'event', id: event.id });
    const checkin = await post(t, '/v1/session-checkins', desk, {
      personId: player,
      activity: ref,
    });
    expect(checkin.body).toMatchObject({ status: 'admitted', basis: { kind: 'event_commitment' } });
    const outsider = await createPersonFixture(t, { kind: 'adult' });
    const held = await post(t, '/v1/session-checkins', desk, { personId: outsider, activity: ref });
    expect(held.body).toMatchObject({ status: 'held', basis: null });
  });
});
