import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
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
  drainOutbox,
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
  it('SPK-ENTRY-001 / SPK-ENTRY-004 / SPK-ENTRY-005: no check-in or observed attendance ahead of the activity day, and no attendance for a canceled activity — online or offline (R4-OPS-MODULES-06)', async () => {
    const now = t.clock.now();
    const nextWeek = await createOfferingSessionFixture(t, {
      offeringId: p.offering.offeringId,
      scheduledStart: new Date(at('2027-01-23', '10:00')),
      scheduledEnd: new Date(at('2027-01-23', '11:00')),
    });
    const canceled = await createOfferingSessionFixture(t, {
      offeringId: p.offering.offeringId,
      scheduledStart: new Date(at(TODAY, '12:00')),
      scheduledEnd: new Date(at(TODAY, '13:00')),
      status: 'canceled',
    });
    const nextWeekRef = { type: 'session', offeringId: p.offering.offeringId, sessionId: nextWeek };
    const canceledRef = { type: 'session', offeringId: p.offering.offeringId, sessionId: canceled };

    // A check-in for next week's session is refused and holds nothing.
    const early = await post(t, '/v1/session-checkins', desk, {
      personId: fam.childA,
      activity: nextWeekRef,
    });
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.details).toMatchObject({
      code: 'activity_not_today',
      activityDate: '2027-01-23',
    });
    const held = await t.db
      .selectFrom('session_checkins')
      .select('id')
      .where('activity_id', '=', nextWeek)
      .execute();
    expect(held).toEqual([]);

    // Attendance is not observed ahead of the activity day, nor for a canceled activity.
    const ahead = await observe(desk, {
      personId: fam.childA,
      activity: nextWeekRef,
      observedState: 'absent',
    });
    expect(ahead.status, JSON.stringify(ahead.body)).toBe(409);
    expect(ahead.body.details).toMatchObject({ code: 'activity_not_today' });
    const ofCanceled = await observe(desk, {
      personId: fam.childA,
      activity: canceledRef,
      observedState: 'present',
    });
    expect(ofCanceled.status, JSON.stringify(ofCanceled.body)).toBe(409);
    expect(ofCanceled.body.details).toMatchObject({ code: 'activity_canceled' });

    // Offline: the same items are rejected with the same reasons.
    const batch = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-window',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: { reference: 'roster-window', takenAt: now.toISOString() },
      items: [
        {
          kind: 'attendance',
          clientObservationId: newId(),
          observedAt: now.toISOString(),
          personId: fam.childA,
          activity: nextWeekRef,
          observedState: 'absent',
        },
        {
          kind: 'attendance',
          clientObservationId: newId(),
          observedAt: now.toISOString(),
          personId: fam.childA,
          activity: canceledRef,
          observedState: 'present',
        },
      ],
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    expect(
      batch.body.items.map((i: { outcome: string; reason: string }) => [i.outcome, i.reason]),
    ).toEqual([
      ['rejected', 'activity_not_today'],
      ['rejected', 'activity_canceled'],
    ]);
    const recorded = await t.db
      .selectFrom('attendance_observations')
      .select('id')
      .where('activity_id', 'in', [nextWeek, canceled])
      .execute();
    expect(recorded).toEqual([]);
  });
  it('R4-OPS-MODULES-06 / §4.15: attendance is judged against the activity at the observed time — observed before a later cancellation it is recorded, online (backdated) and offline; an offline item still refused is kept for review with what the device observed', async () => {
    const restore = t.clock.now();
    const later = await createOfferingSessionFixture(t, {
      offeringId: p.offering.offeringId,
      scheduledStart: new Date(at(TODAY, '15:00')),
      scheduledEnd: new Date(at(TODAY, '16:00')),
    });
    const elsewhere = await createOfferingSessionFixture(t, {
      offeringId: p.offering.offeringId,
      scheduledStart: new Date(at('2027-01-24', '15:00')),
      scheduledEnd: new Date(at('2027-01-24', '16:00')),
    });
    const laterRef = { type: 'session', offeringId: p.offering.offeringId, sessionId: later };
    const elsewhereRef = {
      type: 'session',
      offeringId: p.offering.offeringId,
      sessionId: elsewhere,
    };
    // 15:30: the session is canceled while it is taking place (the device is offline).
    t.clock.set(at(TODAY, '15:30'));
    const cancel = await post(t, `/v1/sessions/${later}/cancel`, manager, { reason: 'Lightning' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    await drainOutbox(t);

    // Online, backdated: observed at 15:10, before the cancellation, it is recorded.
    t.clock.set(at(TODAY, '15:40'));
    const backdated = await observe(desk, {
      personId: fam.childB,
      activity: laterRef,
      observedState: 'present',
      observedAt: at(TODAY, '15:10'),
    });
    expect(backdated.status, JSON.stringify(backdated.body)).toBe(201);
    expect(backdated.body.observation).toMatchObject({
      observedState: 'present',
      observedAt: at(TODAY, '15:10'),
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', backdated.body.observation.id as string)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ activityCanceledAt: at(TODAY, '15:30') });
    // Observed after the cancellation, it is refused.
    const afterCancel = await observe(desk, {
      personId: fam.childB,
      activity: laterRef,
      observedState: 'present',
      observedAt: at(TODAY, '15:35'),
    });
    expect(afterCancel.status, JSON.stringify(afterCancel.body)).toBe(409);
    expect(afterCancel.body.details).toMatchObject({
      code: 'activity_canceled',
      canceledAt: at(TODAY, '15:30'),
    });

    // Offline (snapshot 14:50, synchronized 16:30): the 15:05 observation is recorded and
    // flagged; the 15:45 one (after the cancellation) and one for an activity on another day
    // (e.g. moved after the device observed it) are refused and kept for review, never dropped.
    t.clock.set(at(TODAY, '16:30'));
    const beforeCancel = newId();
    const afterCancelItem = newId();
    const otherDay = newId();
    const sync = (clientBatchId: string, items: object[]) =>
      post(t, '/v1/offline-sync', desk, {
        deviceId: 'tablet-observed-at',
        clientBatchId,
        facilityId: t.facilityId,
        snapshot: { reference: 'roster-observed-at', takenAt: at(TODAY, '14:50') },
        items,
      });
    const items = [
      {
        kind: 'attendance',
        clientObservationId: beforeCancel,
        observedAt: at(TODAY, '15:05'),
        personId: fam.childA,
        activity: laterRef,
        observedState: 'present',
      },
      {
        kind: 'attendance',
        clientObservationId: afterCancelItem,
        observedAt: at(TODAY, '15:45'),
        personId: fam.childA,
        activity: laterRef,
        observedState: 'left_early',
      },
      {
        kind: 'attendance',
        clientObservationId: otherDay,
        observedAt: at(TODAY, '15:50'),
        personId: fam.childB,
        activity: elsewhereRef,
        observedState: 'present',
      },
    ];
    const batch = await sync(newId(), items);
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    expect(
      batch.body.items.map((i: { outcome: string; reason: string | null; flags: string[] }) => [
        i.outcome,
        i.reason,
        i.flags,
      ]),
    ).toEqual([
      ['accepted', null, ['canceled_after_observation']],
      ['rejected', 'activity_canceled', []],
      ['rejected', 'activity_not_today', []],
    ]);
    const recorded = await t.db
      .selectFrom('attendance_observations')
      .select(['person_id', 'observed_state', 'observed_at', 'source', 'client_observation_id'])
      .where('activity_id', 'in', [later, elsewhere])
      .orderBy('observed_at')
      .execute();
    expect(
      recorded.map((r) => [
        r.person_id,
        r.observed_state,
        new Date(r.observed_at).toISOString(),
        r.source,
      ]),
    ).toEqual([
      [fam.childA, 'present', at(TODAY, '15:05'), 'offline_sync'],
      [fam.childB, 'present', at(TODAY, '15:10'), 'online'],
    ]);
    const reviewOfDevice = async () =>
      (await exceptionsOf(t, 'entry.offline_attendance_unrecorded'))
        .filter((e) => (e.details as { deviceId: string }).deviceId === 'tablet-observed-at')
        .sort((a, b) =>
          (a.details as { observedAt: string }).observedAt <
          (b.details as { observedAt: string }).observedAt
            ? -1
            : 1,
        );
    const review = await reviewOfDevice();
    expect(review.map((e) => e.details)).toEqual([
      expect.objectContaining({
        batchId: batch.body.id,
        deviceId: 'tablet-observed-at',
        clientObservationId: afterCancelItem,
        personId: fam.childA,
        observedState: 'left_early',
        observedAt: at(TODAY, '15:45'),
        activityType: 'session',
        activityId: later,
        activityCanceledAt: at(TODAY, '15:30'),
        snapshotReference: 'roster-observed-at',
        reason: 'activity_canceled',
      }),
      expect.objectContaining({
        clientObservationId: otherDay,
        personId: fam.childB,
        observedState: 'present',
        observedAt: at(TODAY, '15:50'),
        activityId: elsewhere,
        activityStart: at('2027-01-24', '15:00'),
        reason: 'activity_not_today',
      }),
    ]);
    expect(review.every((e) => e.owner_queue === 'program_manager' && e.status === 'open')).toBe(
      true,
    );
    expect([...batch.body.exceptionIds].sort()).toEqual(review.map((e) => e.id).sort());

    // Re-sent in another batch: the recorded item is a duplicate, the refused ones keep their one
    // review exception each.
    const again = await sync(newId(), items);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.items.map((i: { outcome: string }) => i.outcome)).toEqual([
      'duplicate',
      'rejected',
      'rejected',
    ]);
    expect((await reviewOfDevice()).map((e) => e.id)).toEqual(review.map((e) => e.id));
    t.clock.set(restore);
  });
});
