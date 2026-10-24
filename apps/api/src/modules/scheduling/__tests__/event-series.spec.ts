import { newId, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { EventSeriesService } from '../services/event-series.service';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import { localTimeOf } from '../time/local-time';
import {
  at,
  createScheduledEvent,
  seedPitchWithHalves,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

describe('recurring series across daylight-saving changes and recurrence edits (SPK-SCHED-007/008)', () => {
  let t: TestApp;
  let series: EventSeriesService;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let programManager: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-02-01T12:00:00Z' });
    series = t.app.get(EventSeriesService);
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    programManager = staffPrincipal(org, ['program_manager']);
    auth = await t.authHeader(programManager);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;

  it('SPK-SCHED-008: a weekly 19:00 practice keeps its local time across the spring-forward transition', async () => {
    const res = await t.http
      .post('/v1/event-series')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        kind: 'practice',
        title: 'U10 practice',
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          byWeekday: [2],
          startDate: '2026-03-03',
          until: '2026-03-17',
        },
        localStartTime: '19:00',
        durationMinutes: 60,
        resourceIds: [pitch.northHalfId],
        commitments: [{ partyType: 'team', partyId: newId(), role: 'home_team' }],
        sourceType: 'program_session_plan',
        sourceId: newId(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      timezone: 'America/Los_Angeles',
      localStartTime: '19:00',
      status: 'active',
    });
    expect(res.body.eventIds).toHaveLength(3);
    const rows = await t.db
      .selectFrom('events')
      .selectAll()
      .where('series_id', '=', res.body.id)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((r) => r.occurrence_index)).toEqual([0, 1, 2]);
    expect(rows.map((r) => new Date(r.scheduled_start).toISOString())).toEqual([
      '2026-03-04T03:00:00.000Z', // PST
      '2026-03-11T02:00:00.000Z', // PDT: the UTC instant moved, the wall-clock time did not
      '2026-03-18T02:00:00.000Z',
    ]);
    expect(
      rows.every(
        (r) => localTimeOf('America/Los_Angeles', new Date(r.scheduled_start)) === '19:00',
      ),
    ).toBe(true);
    expect(rows.every((r) => r.status === 'published' && r.dst_resolution === 'exact')).toBe(true);
    const holds = await t.db
      .selectFrom('reservation_units')
      .select('id')
      .where(
        'event_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('status', '=', 'active')
      .execute();
    expect(holds).toHaveLength(3);
    const view = await t.http.get(`/v1/event-series/${res.body.id}`).set(auth);
    expect(view.body.eventIds).toEqual(rows.map((r) => r.id));
  });

  it('SPK-SCHED-008: nonexistent and ambiguous local times are resolved explicitly and recorded on the event', async () => {
    const shifted = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Overnight cleaning',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [0],
        startDate: '2026-03-01',
        count: 2,
      },
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch.southHalfId],
    });
    const shiftedRows = await t.db
      .selectFrom('events')
      .select(['scheduled_start', 'dst_resolution', 'occurrence_index'])
      .where('series_id', '=', shifted.id)
      .orderBy('occurrence_index')
      .execute();
    expect(shiftedRows.map((r) => r.dst_resolution)).toEqual(['exact', 'shifted_forward']);
    expect(new Date(shiftedRows[1]!.scheduled_start).toISOString()).toBe(
      '2026-03-08T10:30:00.000Z',
    ); // 03:30 PDT
    expect(localTimeOf('America/Los_Angeles', new Date(shiftedRows[1]!.scheduled_start))).toBe(
      '03:30',
    );

    const skipped = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Skip the gap',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [0],
        startDate: '2026-03-01',
        count: 3,
      },
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch.northHalfId],
      nonexistentPolicy: 'skip',
    });
    const skippedRows = await t.db
      .selectFrom('events')
      .select('occurrence_index')
      .where('series_id', '=', skipped.id)
      .orderBy('occurrence_index')
      .execute();
    expect(skippedRows.map((r) => r.occurrence_index)).toEqual([0, 2]); // index 1 (2026-03-08) was skipped and keeps its index

    const ambiguous = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'block',
      title: 'Fall-back block',
      recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-01', count: 1 },
      localStartTime: '01:30',
      durationMinutes: 30,
      resourceIds: [pitch.northHalfId],
      ambiguousPolicy: 'second',
    });
    const ambiguousRows = await t.db
      .selectFrom('events')
      .select(['scheduled_start', 'dst_resolution'])
      .where('series_id', '=', ambiguous.id)
      .execute();
    expect(ambiguousRows[0]).toMatchObject({ dst_resolution: 'second' });
    expect(new Date(ambiguousRows[0]!.scheduled_start).toISOString()).toBe(
      '2026-11-01T09:30:00.000Z',
    );
  });

  it('a conflict in any occurrence rejects the whole series and names the conflicting event', async () => {
    const blocker = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-04-09', '17:00'),
      end: at('2026-04-09', '18:00'),
      title: 'Thursday blocker',
    });
    const before = await t.db.selectFrom('event_series').select('id').execute();
    await expect(
      series.createSeries(programManager, {
        facilityId: facility,
        kind: 'practice',
        title: 'Thursday practice',
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          byWeekday: [4],
          startDate: '2026-04-02',
          count: 3,
        },
        localStartTime: '17:30',
        durationMinutes: 60,
        resourceIds: [pitch.southHalfId],
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflictingEventIds: [blocker.id],
        conflicts: [expect.objectContaining({ key: 'occurrence:1', code: 'physical_overlap' })],
      },
    });
    expect(await t.db.selectFrom('event_series').select('id').execute()).toHaveLength(
      before.length,
    );
    expect(
      await t.db
        .selectFrom('events')
        .select('id')
        .where('title', '=', 'Thursday practice')
        .execute(),
    ).toEqual([]);
  });

  it('SPK-SCHED-007: edits preview exactly which events change; past occurrences keep their stable identity', async () => {
    const created = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'session',
      title: 'Saturday academy',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [6],
        startDate: '2026-05-02',
        count: 4,
      },
      localStartTime: '09:00',
      durationMinutes: 90,
      resourceIds: [pitch.northHalfId],
    });
    const rows = await t.db
      .selectFrom('events')
      .selectAll()
      .where('series_id', '=', created.id)
      .orderBy('occurrence_index')
      .execute();
    expect(rows).toHaveLength(4);
    // occurrence 0 (2026-05-02) has been played: the clock is now after it
    t.clock.set('2026-05-04T12:00:00Z');

    const preview = await t.http
      .post(`/v1/event-series/${created.id}/edits`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        scope: 'this_and_future',
        occurrenceIndex: 2,
        preview: true,
        changes: { localStartTime: '10:00', resourceIds: [pitch.pitchId] },
      });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.committed).toBe(false);
    expect(
      preview.body.affected.map((a: { occurrenceIndex: number }) => a.occurrenceIndex),
    ).toEqual([2, 3]);
    expect(preview.body.affected[0]).toMatchObject({
      eventId: rows[2]!.id,
      before: { scheduledStart: at('2026-05-16', '09:00'), resources: [{ id: pitch.northHalfId }] },
      after: {
        scheduledStart: at('2026-05-16', '10:00'),
        resources: [{ id: pitch.pitchId, name: 'Pitch 1' }],
      },
      dstResolution: 'exact',
    });
    expect(preview.body.unchangedEventIds.sort()).toEqual([rows[0]!.id, rows[1]!.id].sort());
    const untouched = await events.getEvent(programManager, rows[2]!.id);
    expect(untouched).toMatchObject({ revision: 1, scheduledStart: at('2026-05-16', '09:00') });

    const committed = await series.editSeries(programManager, created.id, {
      scope: 'this_and_future',
      occurrenceIndex: 2,
      preview: false,
      changes: { localStartTime: '10:00', resourceIds: [pitch.pitchId] },
      expectedRevision: 1,
      reason: 'coach availability',
    });
    expect(committed.committed).toBe(true);
    expect(committed.affected.map((a) => a.eventId)).toEqual([rows[2]!.id, rows[3]!.id]);
    const moved = await events.getEvent(programManager, rows[2]!.id);
    expect(moved).toMatchObject({
      id: rows[2]!.id,
      revision: 2,
      publishedRevision: 2,
      scheduledStart: at('2026-05-16', '10:00'),
      scheduledEnd: at('2026-05-16', '11:30'),
      resourceIds: [pitch.pitchId],
    });
    const past = await events.getEvent(programManager, rows[0]!.id);
    expect(past).toMatchObject({
      revision: 1,
      scheduledStart: at('2026-05-02', '09:00'),
      resourceIds: [pitch.northHalfId],
    });
    const activeUnits = await t.db
      .selectFrom('reservation_units')
      .select('conflict_unit_id')
      .where('event_id', '=', rows[2]!.id)
      .where('status', '=', 'active')
      .execute();
    expect(activeUnits.map((u) => u.conflict_unit_id).sort()).toEqual(
      [pitch.units.north, pitch.units.south].sort(),
    );
    const notice = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', rows[3]!.id)
      .where(sql`payload->>'change'`, '=', 'moved')
      .executeTakeFirstOrThrow();
    expect(notice.payload).toMatchObject({
      change: 'moved',
      before: { scheduledStart: at('2026-05-23', '09:00') },
      after: { scheduledStart: at('2026-05-23', '10:00') },
      reason: 'coach availability',
    });

    // editing a played occurrence is refused; editing one future occurrence touches only it
    await expect(
      series.editSeries(programManager, created.id, {
        scope: 'one',
        occurrenceIndex: 0,
        preview: false,
        changes: { title: 'late' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const one = await series.editSeries(programManager, created.id, {
      scope: 'one',
      occurrenceIndex: 1,
      preview: false,
      changes: { cancel: true },
      reason: 'holiday',
    });
    expect(one.affected.map((a) => a.eventId)).toEqual([rows[1]!.id]);
    expect(one.affected[0]?.after).toBeNull();
    expect((await events.getEvent(programManager, rows[1]!.id)).status).toBe('canceled');

    // the entire series: every future, non-canceled occurrence changes and the rule is updated
    const entire = await series.editSeries(programManager, created.id, {
      scope: 'entire_series',
      preview: false,
      changes: { title: 'Saturday academy (renamed)', durationMinutes: 60 },
    });
    expect(entire.affected.map((a) => a.eventId).sort()).toEqual([rows[2]!.id, rows[3]!.id].sort());
    const view = await series.getSeries(programManager, created.id);
    expect(view).toMatchObject({
      title: 'Saturday academy (renamed)',
      durationMinutes: 60,
      revision: 4,
    });
    expect(await events.getEvent(programManager, rows[3]!.id)).toMatchObject({
      title: 'Saturday academy (renamed)',
      scheduledEnd: at('2026-05-23', '11:00'),
    });
  });

  it('authorization: coaches cannot create series; other organizations see nothing', async () => {
    const coach = await t.authHeader(staffPrincipal(org, ['coach']));
    const denied = await t.http
      .post('/v1/event-series')
      .set(coach)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        kind: 'practice',
        title: 'x',
        recurrence: { frequency: 'daily', startDate: '2026-06-01', count: 1 },
        localStartTime: '09:00',
        durationMinutes: 60,
        resourceIds: [pitch.pitchId],
      });
    expect(denied.status).toBe(403);
    const otherOrg = await t.authHeader(staffPrincipal(newId(), ['scheduler']));
    const existing = await t.db.selectFrom('event_series').select('id').executeTakeFirstOrThrow();
    expect((await t.http.get(`/v1/event-series/${existing.id}`).set(otherOrg)).status).toBe(404);
  });
});
