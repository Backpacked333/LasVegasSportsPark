import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  at,
  ClosuresService,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { PreventiveSchedulesService } from '../services/preventive-schedules.service';
import { RestrictionsService } from '../services/restrictions.service';
import { createPreventiveSchedule } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

describe('preventive maintenance schedules (SPK-FAC-005)', () => {
  let t: TestApp;
  let schedules: PreventiveSchedulesService;
  let restrictions: RestrictionsService;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let scheduler: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    schedules = t.app.get(PreventiveSchedulesService);
    restrictions = t.app.get(RestrictionsService);
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 3',
    });
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(scheduler);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth, k = key()) =>
    t.http.post(path).set(headers).set('Idempotency-Key', k).send(body);

  it('SPK-FAC-005: generation materializes tasks and future restrictions through the scheduling authority, exactly once per occurrence', async () => {
    const denied = await post(
      '/v1/preventive-schedules',
      {
        facilityId: facility,
        resourceId: pitch.northHalfId,
        name: 'Weekly grooming',
        recurrence: { frequency: 'weekly', byWeekday: [1], startDate: '2026-10-26', count: 8 },
        localStartTime: '06:00',
        durationMinutes: 120,
        taskTemplate: { issue: 'Groom turf', severity: 'medium' },
      },
      await t.authHeader(staffPrincipal(org, ['front_desk'])),
    );
    expect(denied.status).toBe(403);
    const created = await post('/v1/preventive-schedules', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      name: 'Weekly grooming',
      recurrence: { frequency: 'weekly', byWeekday: [1], startDate: '2026-10-26', count: 8 },
      localStartTime: '06:00',
      durationMinutes: 120,
      taskTemplate: { issue: 'Groom turf and check infill', severity: 'medium' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'active',
      leadTimeDays: 14,
      timezone: 'America/Los_Angeles',
      restrictionKind: 'closed',
      taskTemplate: { requiresInspection: false, assignedOwnerPersonId: null },
    });
    const scheduleId: string = created.body.id;

    // default horizon: now + 14 days covers only the first Monday (the second starts after it)
    const first = await post(
      `/v1/preventive-schedules/${scheduleId}/generate`,
      {},
      await t.authHeader(staffPrincipal(org, ['facilities_operator'])),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.generated).toHaveLength(1);
    expect(first.body.generated[0]).toMatchObject({
      occurrenceIndex: 0,
      interval: { start: at('2026-10-26', '06:00'), end: at('2026-10-26', '08:00') },
    });
    const operation = await t.http.get(`/v1/operations/${first.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'facilities.generate_preventive_maintenance',
      status: 'succeeded',
    });

    // an explicit horizon materializes the next two; the first is reported as already generated
    const k = key();
    const more = await post(
      `/v1/preventive-schedules/${scheduleId}/generate`,
      { through: '2026-11-10T00:00:00Z' },
      auth,
      k,
    );
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.alreadyGeneratedOccurrenceIndexes).toEqual([0]);
    expect(more.body.generated.map((g: { occurrenceIndex: number }) => g.occurrenceIndex)).toEqual([
      1, 2,
    ]);
    const replay = await post(
      `/v1/preventive-schedules/${scheduleId}/generate`,
      { through: '2026-11-10T00:00:00Z' },
      auth,
      k,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const again = await post(`/v1/preventive-schedules/${scheduleId}/generate`, {
      through: '2026-11-10T00:00:00Z',
    });
    expect(again.body.generated).toEqual([]);
    expect(again.body.alreadyGeneratedOccurrenceIndexes).toEqual([0, 1, 2]);

    const generated = await restrictions.list(scheduler, {
      facilityId: facility,
      status: 'active',
    });
    const mine = generated.filter((r) => r.preventiveScheduleId === scheduleId);
    expect(mine.map((r) => r.occurrenceIndex)).toEqual([0, 1, 2]);
    for (const restriction of mine) {
      // approved under the schedule's own authority (creating the schedule was the human approval)
      expect(restriction).toMatchObject({
        resourceId: pitch.northHalfId,
        affectedConflictUnitIds: [pitch.units.north],
        approvedBy: { kind: 'system', actorLabel: `preventive_schedule:${scheduleId}` },
      });
      expect(restriction.schedulingClosureId).not.toBeNull();
      expect(restriction.taskId).not.toBeNull();
      const closure = await t.app
        .get(ClosuresService)
        .getClosure(scheduler, restriction.schedulingClosureId as string);
      expect(closure).toMatchObject({ status: 'active', source: 'maintenance' });
      const task = await t.http.get(`/v1/maintenance-tasks/${restriction.taskId}`).set(auth);
      expect(task.body).toMatchObject({
        preventiveScheduleId: scheduleId,
        occurrenceIndex: restriction.occurrenceIndex,
        issue: 'Groom turf and check infill',
        severity: 'medium',
        status: 'open',
        dueAt: restriction.interval.end,
        openRestrictionIds: [restriction.id],
      });
    }
    // the future closures affect availability on the half and the whole pitch, not the other half
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-02', '06:30'),
        end: at('2026-11-02', '07:30'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-11-02', '06:30'),
        end: at('2026-11-02', '07:30'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const south = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-02', '06:30'),
      end: at('2026-11-02', '07:30'),
    });
    expect(south.status).toBe('published');
    const schedule = await t.http.get(`/v1/preventive-schedules/${scheduleId}`).set(auth);
    expect(schedule.body.lastGeneratedThrough).toBe('2026-11-10T00:00:00.000Z');
  });

  it('SPK-FAC-002 / §4.3: a preventive template names only an active adult person of the organization as owner', async () => {
    const other = await seedOrganization(t.db);
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const owner = await createPersonFixture(t, { kind: 'adult' });
    const body = (assignedOwnerPersonId: string) => ({
      facilityId: facility,
      resourceId: pitch.southHalfId,
      name: 'Net inspection',
      recurrence: { frequency: 'daily', startDate: '2026-10-22', count: 1 },
      localStartTime: '06:00',
      durationMinutes: 60,
      taskTemplate: { issue: 'Inspect nets', severity: 'low', assignedOwnerPersonId },
    });
    for (const personId of [foreign, newId()]) {
      const refused = await post('/v1/preventive-schedules', body(personId));
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { path: 'taskTemplate.assignedOwnerPersonId' },
      });
    }
    const created = await post('/v1/preventive-schedules', body(owner));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const edited = await t.http
      .patch(`/v1/preventive-schedules/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        expectedRevision: created.body.revision,
        taskTemplate: { issue: 'Inspect nets', severity: 'low', assignedOwnerPersonId: foreign },
      });
    expect(edited.status, JSON.stringify(edited.body)).toBe(400);
    const generated = await post(`/v1/preventive-schedules/${created.body.id}/generate`, {
      through: '2026-10-23T00:00:00Z',
    });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.generated).toHaveLength(1);
    const task = await t.db
      .selectFrom('maintenance_tasks')
      .select(['status', 'assigned_owner_person_id'])
      .where('id', '=', generated.body.generated[0].taskId)
      .executeTakeFirstOrThrow();
    expect(task).toEqual({ status: 'assigned', assigned_owner_person_id: owner });
  });

  it('a paused or ended schedule generates nothing; status and revision are guarded', async () => {
    const schedule = await createPreventiveSchedule(schedules, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      name: 'Goal anchor check',
      recurrence: { frequency: 'daily', interval: 7, startDate: '2026-10-20', count: 4 },
      principal: scheduler,
    });
    const stale = await t.http
      .patch(`/v1/preventive-schedules/${schedule.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ status: 'paused', expectedRevision: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const paused = await t.http
      .patch(`/v1/preventive-schedules/${schedule.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ status: 'paused', expectedRevision: schedule.revision });
    expect(paused.body).toMatchObject({ status: 'paused', revision: 2 });
    const blocked = await post(`/v1/preventive-schedules/${schedule.id}/generate`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVALID_TRANSITION');
    const resumed = await schedules.update(scheduler, schedule.id, { status: 'active' });
    expect(resumed.status).toBe('active');
    const ended = await schedules.update(scheduler, schedule.id, { status: 'ended' });
    expect(ended.status).toBe('ended');
    await expect(
      schedules.update(scheduler, schedule.id, { status: 'active' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const list = await t.http
      .get('/v1/preventive-schedules')
      .query({ facilityId: facility, status: 'ended' })
      .set(auth);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([schedule.id]);
    const past = await post(`/v1/preventive-schedules/${schedule.id}/generate`, {
      through: '2020-01-01T00:00:00Z',
    });
    expect(past.status).toBe(409);
  });
});
