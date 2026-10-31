import { DomainError, newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions, UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { CLOSURE_PORT, type ClosurePort } from '../ports';
import { ClosureImpactContributors } from '../services/closure-impact-contributors';
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

  it('SPK-AT-021 / §4.12: lifting an applied closure resolves its closure_resolution_required exception and leaves other closures open', async () => {
    const exceptions = t.app.get(OperationalExceptions);
    const uow = t.app.get(UnitOfWork);
    const scheduler = staffPrincipal(org, ['scheduler']);
    const applyWithEvent = async (day: string, title: string) => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at(day, '09:00'),
        end: at(day, '10:00'),
        title,
      });
      const created = await t.http
        .post('/v1/closures')
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          facilityId: facility,
          resourceId: pitch.southHalfId,
          interval: { start: at(day, '08:00'), end: at(day, '20:00') },
          reason: `Turf repair south half ${day}`,
          source: 'maintenance',
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const applied = await t.http
        .post(`/v1/closures/${created.body.id}/apply`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({ mode: 'leave_for_resolution', expectedRevision: 1 });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body.resolution.unresolvedEventIds).toEqual([event.id]);
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .selectAll()
        .where('organization_id', '=', org)
        .where('dedupe_key', '=', `closure:${created.body.id}`)
        .executeTakeFirstOrThrow();
      expect(exception).toMatchObject({
        category: 'scheduling.closure_resolution_required',
        status: 'open',
      });
      return { closureId: created.body.id as string, event, exceptionId: exception.id };
    };
    const lifting = await applyWithEvent('2026-11-22', 'A v B');
    const staying = await applyWithEvent('2026-11-23', 'North clinic');
    // the scheduler has seen the card (acknowledged) before the area is reopened
    await uow.run(({ trx }) =>
      exceptions.transition(trx, scheduler, lifting.exceptionId, 'acknowledged'),
    );

    t.clock.advance(30 * 60_000);
    const lifted = await t.http
      .post(`/v1/closures/${lifting.closureId}/lift`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, reason: 'inspection passed' });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    expect(lifted.body).toMatchObject({ status: 'lifted' });

    // the facilities operator who reopened the area holds no scheduler queue: the exception is
    // settled by the scheduling system actor in the lift's transaction
    const settled = await exceptions.get(org, lifting.exceptionId);
    expect(settled).toMatchObject({
      status: 'resolved',
      resolution: { outcome: 'closure_lifted', closureId: lifting.closureId },
    });
    expect(new Date(settled!.resolved_at!).toISOString()).toBe(t.clock.now().toISOString());
    const transitionAudit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor', 'reason'])
      .where('organization_id', '=', org)
      .where('target_type', '=', 'operational_exception')
      .where('target_id', '=', lifting.exceptionId)
      .where('action', '=', 'exceptions.resolved')
      .executeTakeFirstOrThrow();
    expect(transitionAudit).toMatchObject({
      actor: { kind: 'system', actorLabel: 'scheduling.closure_lifted' },
      reason:
        'Closure lifted: no event it left for resolution held the closed area before the lift. Lift reason: inspection passed',
    });
    const stillOpen = await exceptions.list(org, {
      statuses: ['open', 'acknowledged'],
      category: 'scheduling.closure_resolution_required',
    });
    expect(stillOpen.items.map((e) => e.id)).toEqual([staying.exceptionId]);

    // the other closure is still active and its exception still asks for a resolution
    const otherClosure = await closures.getClosure(facilitiesOperator, staying.closureId);
    expect(otherClosure.status).toBe('active');
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

  it('SPK-SCHED-009 / R3-TRACE-A-06: the preview and the applied closure name the staff assigned to the affected events', async () => {
    const referee = newId();
    const coach = newId();
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-21', '10:00'),
      end: at('2026-11-21', '11:00'),
      title: 'Staffed league game',
      sourceType: 'fixture',
      sourceId: newId(),
    });
    const practice = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-21', '12:00'),
      end: at('2026-11-21', '13:00'),
      kind: 'practice',
      title: 'Staffed practice',
    });
    const later = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-21', '18:00'),
      end: at('2026-11-21', '19:00'),
      title: 'Evening game outside the closure',
    });
    const assignment = (eventId: string, personId: string, kind: string, role: string) => ({
      assignmentId: newId(),
      personId,
      eventId,
      kind,
      role,
      status: 'accepted',
    });
    const onGame = [
      assignment(game.id, referee, 'official', 'referee'),
      assignment(game.id, coach, 'coach', 'head_coach'),
    ];
    const onPractice = [assignment(practice.id, coach, 'coach', 'head_coach')];
    const outside = assignment(later.id, newId(), 'official', 'referee');
    // the module owning staff assignments answers for the events it is given (workforce in the app)
    const seen: string[][] = [];
    t.app.get(ClosureImpactContributors).register('test.staff_assignments', async (_db, o, evs) => {
      expect(o).toBe(org);
      seen.push(evs.map((e) => e.eventId).sort());
      const ids = new Set(evs.map((e) => e.eventId));
      // a slip naming an event outside the closure is never reported
      return {
        staff: [...onGame, ...onPractice, outside].filter(
          (a) => ids.has(a.eventId) || a === outside,
        ),
      };
    });
    const interval = { start: at('2026-11-21', '09:00'), end: at('2026-11-21', '14:00') };
    const res = await t.http
      .get('/v1/closure-impact')
      .query({ facilityId: facility, ...interval })
      .set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const expected = [...onGame, ...onPractice].sort(
      (a, b) => a.eventId.localeCompare(b.eventId) || a.assignmentId.localeCompare(b.assignmentId),
    );
    expect(res.body.staff).toEqual(expected);
    expect(res.body.summary).toMatchObject({ games: 1, programs: 1, staff: 2 });
    expect(seen.at(-1)).toEqual([game.id, practice.id].sort());

    const closure = await closures.createClosure(facilitiesOperator, {
      facilityId: facility,
      interval,
      reason: 'Lightning',
      source: 'manual',
    });
    expect(closure.impact?.staff).toEqual(expected);
    const applied = await closures.applyClosure(facilitiesOperator, closure.id, {
      mode: 'leave_for_resolution',
      expectedRevision: 1,
    });
    expect(applied.impact?.staff).toEqual(expected);
    expect(applied.impact?.summary.staff).toBe(2);
    const read = await t.http.get(`/v1/closures/${closure.id}`).set(auth);
    expect(read.body.impact.staff).toEqual(expected);
    expect(read.body.impact.staff.map((a: { eventId: string }) => a.eventId)).not.toContain(
      later.id,
    );
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

/**
 * A lift reopens the area from the lift onward only (staff copy: "bookable again from now"). An
 * event the closure left for resolution that held the closed area before the lift, finished or
 * still running, was blocked and still needs a resolution, so Today must keep naming it
 * (SPK-AT-021, SPK-AT-009, SPK-SCHED-009, SPK-UX-006). The lift also never fails over a Today card
 * someone else settled while it ran (§4.9, §4.12).
 */
describe('closure lift after left-for-resolution events started (SPK-AT-021, SPK-AT-009, SPK-UX-006, §4.12)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let exceptions: OperationalExceptions;
  let uow: UnitOfWork;
  let org: string;
  let pitch: PitchFixture;
  let facilitiesOperator: Principal;
  let scheduler: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: at('2026-12-06', '07:00') });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    exceptions = t.app.get(OperationalExceptions);
    uow = t.app.get(UnitOfWork);
    org = t.organizationId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Turf 2',
    });
    facilitiesOperator = staffPrincipal(org, ['facilities_operator']);
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(facilitiesOperator);
  });
  afterAll(async () => {
    await t?.close();
  });

  const key = () => `key-${newId()}`;
  const book = (day: string, from: string, to: string, title: string) =>
    createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.southHalfId],
      start: at(day, from),
      end: at(day, to),
      title,
    });
  /** Creates and applies an 08:00-20:00 south-half closure that leaves its events for resolution. */
  const closeSouthHalf = async (day: string) => {
    const created = await t.http
      .post('/v1/closures')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: t.facilityId,
        resourceId: pitch.southHalfId,
        interval: { start: at(day, '08:00'), end: at(day, '20:00') },
        reason: `Turf damage ${day}`,
        source: 'manual',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const applied = await t.http
      .post(`/v1/closures/${created.body.id as string}/apply`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ mode: 'leave_for_resolution', expectedRevision: 1 });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const closureId = created.body.id as string;
    const [exception] = await cardsOf(closureId);
    expect(exception).toMatchObject({ status: 'open', dedupe_key: `closure:${closureId}` });
    return {
      closureId,
      unresolved: applied.body.resolution.unresolvedEventIds as string[],
      exceptionId: exception!.id,
    };
  };
  /** As the staff UI sends it: no reason. */
  const lift = (closureId: string) =>
    t.http
      .post(`/v1/closures/${closureId}/lift`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2 });
  const cardsOf = (closureId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', org)
      .where('category', '=', 'scheduling.closure_resolution_required')
      .where('affected_type', '=', 'closure')
      .where('affected_id', '=', closureId)
      .orderBy('opened_at')
      .orderBy('id')
      .execute();
  const liftAudit = (closureId: string) =>
    t.db
      .selectFrom('audit_records')
      .select(['details', 'reason'])
      .where('organization_id', '=', org)
      .where('target_type', '=', 'closure')
      .where('target_id', '=', closureId)
      .where('action', '=', 'scheduling.closure_lifted')
      .executeTakeFirstOrThrow();
  const resolvedAudits = (exceptionId: string) =>
    t.db
      .selectFrom('audit_records')
      .select(['actor', 'reason'])
      .where('organization_id', '=', org)
      .where('target_type', '=', 'operational_exception')
      .where('target_id', '=', exceptionId)
      .where('action', '=', 'exceptions.resolved')
      .execute();
  const statusOf = async (eventId: string) =>
    (
      await t.db
        .selectFrom('events')
        .select('status')
        .where('organization_id', '=', org)
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow()
    ).status;

  it('SPK-AT-021 / SPK-AT-009: a lift after left-for-resolution events started narrows the exception to the events the closure blocked before the lift', async () => {
    const day = '2026-12-06';
    t.clock.set(at(day, '07:00'));
    const morning = await book(day, '09:00', '10:00', 'Morning game');
    const moved = await book(day, '11:00', '12:00', 'Late morning game');
    const afternoon = await book(day, '14:00', '16:00', 'Afternoon clinic');
    const evening = await book(day, '17:00', '18:00', 'Evening rental');
    const { closureId, unresolved, exceptionId } = await closeSouthHalf(day);
    expect(unresolved).toEqual([morning.id, moved.id, afternoon.id, evening.id]);

    // the scheduler resolves one of them while the half is closed
    t.clock.set(at(day, '08:30'));
    await events.cancelEvent(scheduler, moved.id, {
      reason: 'Closure: replayed on another day',
      expectedRevision: moved.revision,
    });

    // the turf passes an afternoon inspection: the half is reopened at 15:00, from 15:00 onward
    t.clock.set(at(day, '15:00'));
    const lifted = await lift(closureId);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);

    const displaced = [morning.id, afternoon.id];
    const [original, narrowed, ...rest] = await cardsOf(closureId);
    expect(rest).toEqual([]);
    expect(original).toMatchObject({
      id: exceptionId,
      status: 'resolved',
      resolution: { outcome: 'narrowed_on_lift', closureId, displacedEventIds: displaced },
    });
    // Today keeps naming the finished morning game and the clinic that was running at the lift,
    // not the evening rental the lift reopened the half for, nor the event already cancelled
    expect(narrowed).toMatchObject({
      status: 'open',
      severity: 'high',
      owner_queue: 'scheduler',
      facility_id: t.facilityId,
      dedupe_key: `closure:${closureId}:displaced`,
      details: { eventIds: displaced, supersedes: [exceptionId] },
    });
    expect(narrowed!.title).toBe(
      '2 event(s) blocked by a closure before it was lifted need resolution',
    );
    expect(await resolvedAudits(exceptionId)).toEqual([
      {
        actor: expect.objectContaining({ kind: 'system', actorLabel: 'scheduling.closure_lifted' }),
        reason:
          'Closure lifted: 2 event(s) it left for resolution held the closed area before the lift and still need resolution on a narrower exception.',
      },
    ]);
    expect((await liftAudit(closureId)).details).toEqual({
      displacedEventIds: displaced,
      resolvedExceptionIds: [exceptionId],
      keptOpenExceptionIds: [],
      raisedExceptionId: narrowed!.id,
    });
    expect(
      await Promise.all([morning, afternoon, evening, moved].map((e) => statusOf(e.id))),
    ).toEqual(['published', 'published', 'published', 'canceled']);
  });

  it('SPK-AT-021 / SPK-AT-009: when every event the exception names was blocked before the lift, the lift leaves the exception as it is', async () => {
    const day = '2026-12-07';
    t.clock.set(at(day, '07:00'));
    const game = await book(day, '09:00', '10:00', 'Morning game');
    const { closureId, exceptionId } = await closeSouthHalf(day);
    await uow.run(({ trx }) => exceptions.transition(trx, scheduler, exceptionId, 'acknowledged'));

    t.clock.set(at(day, '15:00'));
    const lifted = await lift(closureId);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);

    const cards = await cardsOf(closureId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: exceptionId,
      status: 'acknowledged',
      resolution: null,
      details: { eventIds: [game.id] },
    });
    expect(await resolvedAudits(exceptionId)).toEqual([]);
    expect((await liftAudit(closureId)).details).toEqual({
      displacedEventIds: [game.id],
      resolvedExceptionIds: [],
      keptOpenExceptionIds: [exceptionId],
      raisedExceptionId: null,
    });
    expect(await statusOf(game.id)).toBe('published');
  });

  it('SPK-AT-021: a lift after the events started resolves the exception when each event was cancelled or moved out of the closed area', async () => {
    const day = '2026-12-08';
    t.clock.set(at(day, '07:00'));
    const canceled = await book(day, '09:00', '10:00', 'Morning game');
    const relocated = await book(day, '11:00', '12:00', 'Late morning clinic');
    const { closureId, exceptionId } = await closeSouthHalf(day);
    t.clock.set(at(day, '08:15'));
    await events.cancelEvent(scheduler, canceled.id, {
      reason: 'Closure',
      expectedRevision: canceled.revision,
    });
    // moved to the north half, outside the closed area, before it started
    await events.moveEvent(scheduler, relocated.id, {
      scheduledStart: relocated.scheduledStart,
      scheduledEnd: relocated.scheduledEnd,
      resourceIds: [pitch.northHalfId],
      expectedRevision: relocated.revision,
      reason: 'Closure: moved to the north half',
    });

    t.clock.set(at(day, '15:00'));
    expect((await lift(closureId)).status).toBe(200);
    const cards = await cardsOf(closureId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: exceptionId,
      status: 'resolved',
      resolution: { outcome: 'closure_lifted', closureId },
    });
    expect((await liftAudit(closureId)).details).toMatchObject({
      displacedEventIds: [],
      resolvedExceptionIds: [exceptionId],
      raisedExceptionId: null,
    });
  });

  it('§4.9 / §4.12: a lift that listed the exception before a scheduler resolved it still lifts and leaves the scheduler resolution in place', async () => {
    const day = '2026-12-09';
    t.clock.set(at(day, '07:00'));
    await book(day, '09:00', '10:00', 'Morning game');
    const { closureId, exceptionId } = await closeSouthHalf(day);
    const stale = await exceptions.get(org, exceptionId);
    await uow.run(({ trx }) =>
      exceptions.transition(trx, scheduler, exceptionId, 'resolved', {
        reason: 'Moved to Sunday by phone',
        resolution: { outcome: 'rescheduled_by_phone' },
      }),
    );
    // the lift read the card before the scheduler's resolution committed (READ COMMITTED)
    const list = exceptions.list.bind(exceptions);
    exceptions.list = async (...args) => {
      exceptions.list = list;
      const page = await list(...args);
      return { ...page, items: [...page.items, stale!] };
    };
    try {
      t.clock.set(at(day, '07:30'));
      const lifted = await lift(closureId);
      expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    } finally {
      exceptions.list = list;
    }
    expect((await cardsOf(closureId))[0]).toMatchObject({
      status: 'resolved',
      resolution: { outcome: 'rescheduled_by_phone' },
    });
    expect((await resolvedAudits(exceptionId)).map((a) => a.reason)).toEqual([
      'Moved to Sunday by phone',
    ]);
    expect((await liftAudit(closureId)).details).toMatchObject({ resolvedExceptionIds: [] });
  });

  it('§4.9 / §4.12: a lift that waits on a scheduler resolving the same exception still lifts (PGlite and TEST_DATABASE_URL)', async () => {
    const day = '2026-12-10';
    t.clock.set(at(day, '07:00'));
    await book(day, '09:00', '10:00', 'Morning game');
    const { closureId, exceptionId } = await closeSouthHalf(day);
    t.clock.set(at(day, '07:30'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const transitioned = new Promise<void>((resolve) => (reached = resolve));
    // the scheduler's resolution holds the exception row until the test releases it
    const resolving = uow.run(async ({ trx }) => {
      await exceptions.transition(trx, scheduler, exceptionId, 'resolved', {
        reason: 'Handled by the scheduler',
      });
      reached();
      await held;
    });
    await transitioned;
    let liftDone = false;
    const lifting = closures
      .liftClosure(facilitiesOperator, closureId, { expectedRevision: 2 })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => (liftDone = true));
    if (t.database.concurrent) {
      // the lift reaches the exception row lock and waits for the scheduler's transaction
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(liftDone).toBe(false);
    }
    release();
    await resolving;
    const lifted = await lifting;
    expect(
      lifted.ok ? 'OK' : DomainError.is(lifted.error) ? lifted.error.code : String(lifted.error),
    ).toBe('OK');
    expect((await closures.getClosure(scheduler, closureId)).status).toBe('lifted');
    expect((await resolvedAudits(exceptionId)).map((a) => a.reason)).toEqual([
      'Handled by the scheduler',
    ]);
  });
});
