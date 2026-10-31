import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { CLOSURE_PORT, type ClosurePort } from '../ports';
import { ClosuresService } from '../services/closures.service';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

describe('closures: impact preview, apply, lift (SPK-SCHED-009, SPK-FAC-003/004, SPK-AT-009/021)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let facilitiesOperator: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    facilitiesOperator = staffPrincipal(org, ['facilities_operator']);
    auth = await t.authHeader(facilitiesOperator);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;

  it('is exported as ClosurePort', () => {
    expect(t.app.get<ClosurePort>(CLOSURE_PORT)).toBe(closures);
  });

  it('SPK-SCHED-009: the preview names every affected game, program and rental with its owning record and parties', async () => {
    const fixtureId = newId();
    const team = newId();
    const coach = newId();
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-14', '10:00'),
      end: at('2026-11-14', '11:00'),
      title: 'Adult league game',
      sourceType: 'fixture',
      sourceId: fixtureId,
      commitments: [teamCommitment(team), teamCommitment(newId(), 'away_team')],
    });
    const session = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-14', '12:00'),
      end: at('2026-11-14', '13:00'),
      kind: 'session',
      title: 'Youth clinic',
      sourceType: 'session',
      sourceId: newId(),
      commitments: [personCommitment(coach, 'coach')],
    });
    const rental = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-14', '12:00'),
      end: at('2026-11-14', '13:00'),
      kind: 'rental',
      title: 'Birthday party',
      sourceType: 'rental',
      sourceId: newId(),
    });
    const untouched = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-14', '18:00'),
      end: at('2026-11-14', '19:00'),
      title: 'Evening game',
    });
    // closing the north half affects the whole-pitch game and the clinic, not the south-half rental
    const north = await closures.previewImpact(facilitiesOperator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      interval: { start: at('2026-11-14', '09:00'), end: at('2026-11-14', '14:00') },
    });
    expect(north.affectedEvents.map((e) => e.eventId).sort()).toEqual([game.id, session.id].sort());
    expect(north.summary).toMatchObject({ games: 1, programs: 1, rentals: 0, teams: 2, people: 1 });
    expect(north.sourceRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'fixture',
          sourceId: fixtureId,
          eventIds: [game.id],
        }),
      ]),
    );
    // closing the whole facility affects everything in the interval
    const whole = await closures.previewImpact(facilitiesOperator, {
      facilityId: facility,
      interval: { start: at('2026-11-14', '09:00'), end: at('2026-11-14', '14:00') },
    });
    expect(whole.affectedEvents.map((e) => e.eventId).sort()).toEqual(
      [game.id, session.id, rental.id].sort(),
    );
    expect(whole.affectedEvents.map((e) => e.eventId)).not.toContain(untouched.id);
    expect(whole.summary).toMatchObject({ games: 1, programs: 1, rentals: 1 });
  });

  it('SPK-FAC-003 / SPK-AT-021: an applied subdivision closure blocks the whole pitch and that half, leaves the other half, and is lifted by an authorized release', async () => {
    const res = await t.http
      .post('/v1/closures')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        resourceId: pitch.northHalfId,
        interval: { start: at('2026-11-15', '08:00'), end: at('2026-11-15', '20:00') },
        reason: 'Turf repair north half',
        source: 'maintenance',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      impact: { affectedEvents: [] },
      revision: 1,
    });
    // pending closures block nothing yet
    const beforeApply = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '09:00'),
      end: at('2026-11-15', '10:00'),
      title: 'Before apply',
    });
    const stale = await t.http
      .post(`/v1/closures/${res.body.id}/apply`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ mode: 'leave_for_resolution', expectedRevision: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const applied = await t.http
      .post(`/v1/closures/${res.body.id}/apply`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ mode: 'leave_for_resolution', expectedRevision: 1 });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      status: 'active',
      revision: 2,
      resolution: {
        mode: 'leave_for_resolution',
        canceledEventIds: [],
        unresolvedEventIds: [beforeApply.id],
      },
    });
    expect(applied.body.impact.affectedEvents.map((e: { eventId: string }) => e.eventId)).toEqual([
      beforeApply.id,
    ]);
    // staff resolution is tracked as an operational exception owned by the scheduler queue
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('dedupe_key', '=', `closure:${res.body.id}`)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'scheduling.closure_resolution_required',
      owner_queue: 'scheduler',
      status: 'open',
    });
    // the event left for resolution keeps its holds
    const holds = await t.db
      .selectFrom('reservations')
      .select('status')
      .where('event_id', '=', beforeApply.id)
      .execute();
    expect(holds).toEqual([{ status: 'active' }]);

    const blockedHalf = createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '12:00'),
      end: at('2026-11-15', '13:00'),
    });
    await expect(blockedHalf).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [expect.objectContaining({ code: 'closure', closureId: res.body.id })],
      },
    });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-11-15', '12:00'),
        end: at('2026-11-15', '13:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const southOk = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-15', '12:00'),
      end: at('2026-11-15', '13:00'),
    });
    expect(southOk.status).toBe('published');
    const outsideOk = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '20:00'),
      end: at('2026-11-15', '21:00'),
    });
    expect(outsideOk.status).toBe('published');
    // availability search skips the closed interval (and the 20:00 booking with its ten-minute cleanup)
    const slots = await events.findAvailableSlots(facilitiesOperator, {
      resourceId: pitch.northHalfId,
      interval: { start: at('2026-11-15', '18:00'), end: at('2026-11-15', '23:00') },
      durationMinutes: 60,
      stepMinutes: 15,
    });
    expect(slots[0]?.start).toBe(at('2026-11-15', '21:15'));
    expect(slots.every((s) => s.start >= at('2026-11-15', '21:15'))).toBe(true);

    const lifted = await t.http
      .post(`/v1/closures/${res.body.id}/lift`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, reason: 'inspection passed' });
    expect(lifted.status).toBe(200);
    expect(lifted.body).toMatchObject({ status: 'lifted', revision: 3 });
    expect(lifted.body.liftedAt).not.toBeNull();
    const liftedAgain = await t.http
      .post(`/v1/closures/${res.body.id}/lift`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(liftedAgain.body.code).toBe('INVALID_TRANSITION');
    const afterLift = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '12:00'),
      end: at('2026-11-15', '13:00'),
    });
    expect(afterLift.status).toBe('published');
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', res.body.id)
      .orderBy('occurred_at')
      .execute();
    expect(outbox.map((o) => o.event_type)).toEqual([
      'scheduling.closure_applied',
      'scheduling.closure_lifted',
    ]);
  });

  it('SPK-AT-009: applying a facility closure with cancel_affected cancels every affected event with a notice naming the closure', async () => {
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-16', '10:00'),
      end: at('2026-11-16', '11:00'),
      title: 'Youth game',
      commitments: [teamCommitment(newId())],
    });
    const clinic = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-16', '12:00'),
      end: at('2026-11-16', '13:00'),
      kind: 'session',
      title: 'Adult clinic',
    });
    const closure = await closures.createClosure(facilitiesOperator, {
      facilityId: facility,
      interval: { start: at('2026-11-16', '00:00'), end: at('2026-11-17', '00:00') },
      reason: 'Flooding',
      source: 'manual',
    });
    expect(closure.impact?.affectedEvents.map((e) => e.eventId).sort()).toEqual(
      [game.id, clinic.id].sort(),
    );
    const applied = await closures.applyClosure(facilitiesOperator, closure.id, {
      mode: 'cancel_affected',
      expectedRevision: 1,
    });
    expect(applied.resolution).toEqual({
      mode: 'cancel_affected',
      canceledEventIds: [game.id, clinic.id],
      unresolvedEventIds: [],
    });
    for (const id of [game.id, clinic.id]) {
      const row = await events.getEvent(facilitiesOperator, id);
      expect(row).toMatchObject({ status: 'canceled', cancelReason: 'Closure: Flooding' });
      const active = await t.db
        .selectFrom('reservation_units')
        .select('id')
        .where('event_id', '=', id)
        .where('status', '=', 'active')
        .execute();
      expect(active).toEqual([]);
      const notice = await t.db
        .selectFrom('outbox_events')
        .select('payload')
        .where('aggregate_id', '=', id)
        .where(sql`payload->>'change'`, '=', 'canceled')
        .executeTakeFirstOrThrow();
      expect(notice.payload).toMatchObject({
        change: 'canceled',
        closureId: closure.id,
        after: null,
        before: { scheduledStart: expect.any(String) },
      });
    }
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('dedupe_key', '=', `closure:${closure.id}`)
      .execute();
    expect(exceptions).toEqual([]);
    const list = await t.http
      .get('/v1/closures')
      .query({ facilityId: facility, status: 'active' })
      .set(auth);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(closure.id);
  });

  it('authorization and idempotency: front desk cannot close, other organizations see nothing, replays return the same closure', async () => {
    const body = {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      interval: { start: at('2026-11-18', '08:00'), end: at('2026-11-18', '12:00') },
      reason: 'Line painting',
    };
    const denied = await t.http
      .post('/v1/closures')
      .set(await t.authHeader(staffPrincipal(org, ['front_desk'])))
      .set('Idempotency-Key', key())
      .send(body);
    expect(denied.status).toBe(403);
    const k = key();
    const first = await t.http.post('/v1/closures').set(auth).set('Idempotency-Key', k).send(body);
    const replay = await t.http.post('/v1/closures').set(auth).set('Idempotency-Key', k).send(body);
    expect(first.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(
      await t.db
        .selectFrom('closures')
        .select('id')
        .where('reason', '=', 'Line painting')
        .execute(),
    ).toHaveLength(1);
    const other = await seedOrganization(t.db);
    const otherOrg = await t.authHeader(staffPrincipal(other.organizationId, ['scheduler']));
    expect((await t.http.get(`/v1/closures/${first.body.id}`).set(otherOrg)).status).toBe(404);
    const crossApply = await t.http
      .post(`/v1/closures/${first.body.id}/apply`)
      .set(otherOrg)
      .set('Idempotency-Key', key())
      .send({ mode: 'cancel_affected' });
    expect(crossApply.status).toBe(404);
    const scoped = await t.authHeader(
      staffPrincipal(org, ['scheduler'], { facilityIds: [newId()] }),
    );
    expect((await t.http.get(`/v1/closures/${first.body.id}`).set(scoped)).status).toBe(403);
    await expect(
      closures.createClosure(facilitiesOperator, { ...body, facilityId: newId() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
