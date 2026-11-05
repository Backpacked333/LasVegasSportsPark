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
    const gapRule = {
      facilityId: facility,
      kind: 'maintenance' as const,
      title: 'Overnight cleaning',
      recurrence: {
        frequency: 'weekly' as const,
        interval: 1,
        byWeekday: [0],
        startDate: '2026-03-01',
        count: 2,
      },
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch.southHalfId],
    };
    // "require resolution": without a chosen policy the series is refused, naming the dates
    const seriesBefore = await t.db.selectFrom('event_series').select('id').execute();
    await expect(series.createSeries(programManager, gapRule)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        code: 'dst_resolution_required',
        nonexistentLocalDates: ['2026-03-08'],
        ambiguousLocalDates: [],
        options: { nonexistentPolicy: ['shift_forward', 'skip'], ambiguousPolicy: [] },
      },
    });
    expect(await t.db.selectFrom('event_series').select('id').execute()).toHaveLength(
      seriesBefore.length,
    );
    await expect(
      series.createSeries(programManager, {
        ...gapRule,
        title: 'Fall-back block without a policy',
        recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-01', count: 1 },
        localStartTime: '01:30',
        resourceIds: [pitch.northHalfId],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { nonexistentLocalDates: [], ambiguousLocalDates: ['2026-11-01'] },
    });
    const shifted = await series.createSeries(programManager, {
      ...gapRule,
      nonexistentPolicy: 'shift_forward',
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
        expectedRevision: created.revision,
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
    // §4.9: a series edit names the revision it was made against
    const blind = await t.http
      .post(`/v1/event-series/${created.id}/edits`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ scope: 'entire_series', preview: false, changes: { title: 'blind rename' } });
    expect(blind.status).toBe(400);
    expect(blind.body.code).toBe('VALIDATION_FAILED');

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
    const seriesRevision = async () =>
      (await series.getSeries(programManager, created.id)).revision;
    await expect(
      series.editSeries(programManager, created.id, {
        scope: 'one',
        occurrenceIndex: 0,
        preview: false,
        changes: { title: 'late' },
        expectedRevision: await seriesRevision(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const one = await series.editSeries(programManager, created.id, {
      scope: 'one',
      occurrenceIndex: 1,
      preview: false,
      changes: { cancel: true },
      reason: 'holiday',
      expectedRevision: await seriesRevision(),
    });
    expect(one.affected.map((a) => a.eventId)).toEqual([rows[1]!.id]);
    expect(one.affected[0]?.after).toBeNull();
    expect((await events.getEvent(programManager, rows[1]!.id)).status).toBe('canceled');

    // the entire series: every future, non-canceled occurrence changes and the rule is updated
    const entire = await series.editSeries(programManager, created.id, {
      scope: 'entire_series',
      preview: false,
      changes: { title: 'Saturday academy (renamed)', durationMinutes: 60 },
      expectedRevision: await seriesRevision(),
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

  it('R3-TRACE-A-08 / SPK-SCHED-008: an edit whose new local time falls in an overlap or gap requires the scheduler to choose, and skip cancels instead of leaving the old start', async () => {
    t.clock.set('2026-10-01T12:00:00Z');
    // a pitch of its own: the earlier fall-back block holds Pitch 1 at 01:30 on 2026-11-01
    const pitch2 = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 2',
    });
    const rowsOf = (seriesId: string) =>
      t.db
        .selectFrom('events')
        .select(['id', 'occurrence_index', 'scheduled_start', 'dst_resolution', 'status'])
        .where('series_id', '=', seriesId)
        .orderBy('occurrence_index')
        .execute();
    const starts = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
      rows.map((r) => new Date(r.scheduled_start).toISOString());

    // 19:00 needs no policy, so creation stores the defaults nobody chose ('first')
    const sundays = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'practice',
      title: 'Sunday evening practice',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [0],
        startDate: '2026-10-25',
        count: 3,
      },
      localStartTime: '19:00',
      durationMinutes: 60,
      resourceIds: [pitch2.northHalfId],
    });
    const original = await rowsOf(sundays.id);
    const toEarlyMorning = {
      scope: 'entire_series' as const,
      changes: { localStartTime: '01:30' },
      expectedRevision: sundays.revision,
    };
    // 01:30 occurs twice on 2026-11-01: refused for the preview and the commit, nothing changes
    for (const preview of [true, false]) {
      await expect(
        series.editSeries(programManager, sundays.id, { ...toEarlyMorning, preview }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          code: 'dst_resolution_required',
          nonexistentLocalDates: [],
          ambiguousLocalDates: ['2026-11-01'],
          options: { nonexistentPolicy: [], ambiguousPolicy: ['first', 'second'] },
        },
      });
    }
    expect(starts(await rowsOf(sundays.id))).toEqual(starts(original));
    // the scheduler chooses over HTTP; the chosen policy becomes the series' own
    const chosen = await t.http
      .post(`/v1/event-series/${sundays.id}/edits`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        ...toEarlyMorning,
        preview: false,
        changes: { localStartTime: '01:30', ambiguousPolicy: 'second' },
      });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.affected.map((a: { dstResolution: string }) => a.dstResolution)).toEqual([
      'exact',
      'second',
      'exact',
    ]);
    const early = await rowsOf(sundays.id);
    expect(starts(early)).toEqual([
      '2026-10-25T08:30:00.000Z', // 01:30 PDT
      '2026-11-01T09:30:00.000Z', // the second 01:30 (PST)
      '2026-11-08T09:30:00.000Z', // 01:30 PST
    ]);
    expect(early.map((r) => r.dst_resolution)).toEqual(['exact', 'second', 'exact']);
    expect(await series.getSeries(programManager, sundays.id)).toMatchObject({
      localStartTime: '01:30',
      ambiguousPolicy: 'second',
    });
    // one occurrence resolved the other way on request; a later edit that does not change its
    // wall-clock time keeps it there instead of re-resolving it with the series policy
    await series.editSeries(programManager, sundays.id, {
      scope: 'one',
      occurrenceIndex: 1,
      preview: false,
      changes: { ambiguousPolicy: 'first' },
      expectedRevision: (await series.getSeries(programManager, sundays.id)).revision,
    });
    await series.editSeries(programManager, sundays.id, {
      scope: 'entire_series',
      preview: false,
      changes: { title: 'Sunday early practice' },
      expectedRevision: (await series.getSeries(programManager, sundays.id)).revision,
    });
    const kept = await rowsOf(sundays.id);
    expect(starts(kept)[1]).toBe('2026-11-01T08:30:00.000Z');
    expect(kept[1]?.dst_resolution).toBe('first');

    // a series created with 'skip' (no gap at 19:00) moved to 02:30 across 2027-03-14
    const skipping = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Sunday turf care',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [0],
        startDate: '2027-03-07',
        count: 3,
      },
      localStartTime: '19:00',
      durationMinutes: 30,
      resourceIds: [pitch2.southHalfId],
      nonexistentPolicy: 'skip',
    });
    const toGap = {
      scope: 'entire_series' as const,
      preview: true,
      changes: { localStartTime: '02:30' },
      expectedRevision: skipping.revision,
    };
    // the stored policy is not applied silently either
    await expect(series.editSeries(programManager, skipping.id, toGap)).rejects.toMatchObject({
      details: {
        code: 'dst_resolution_required',
        nonexistentLocalDates: ['2027-03-14'],
        ambiguousLocalDates: [],
      },
    });
    const preview = await series.editSeries(programManager, skipping.id, {
      ...toGap,
      changes: { localStartTime: '02:30', nonexistentPolicy: 'skip' },
    });
    expect(preview.affected.map((a) => a.after?.scheduledStart ?? null)).toEqual([
      '2027-03-07T10:30:00.000Z', // 02:30 PST
      null, // 2027-03-14 has no 02:30: the occurrence is canceled
      '2027-03-21T09:30:00.000Z', // 02:30 PDT
    ]);
    await series.editSeries(programManager, skipping.id, {
      ...toGap,
      preview: false,
      changes: { localStartTime: '02:30', nonexistentPolicy: 'skip' },
    });
    const skipped = await rowsOf(skipping.id);
    expect(skipped.map((r) => r.status)).toEqual(['published', 'canceled', 'published']);
    // no occurrence keeps its old 19:00 start while the rest of the series moves
    expect(
      skipped
        .filter((r) => r.status === 'published')
        .map((r) => localTimeOf('America/Los_Angeles', new Date(r.scheduled_start))),
    ).toEqual(['02:30', '02:30']);
    const canceled = await events.getEvent(programManager, skipped[1]!.id);
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancelReason).toBe(
      'Skipped: the new local start time does not exist on this date',
    );
    expect(
      await t.db
        .selectFrom('reservation_units')
        .select('id')
        .where('event_id', '=', skipped[1]!.id)
        .where('status', '=', 'active')
        .execute(),
    ).toEqual([]);
    expect(await series.getSeries(programManager, skipping.id)).toMatchObject({
      localStartTime: '02:30',
      nonexistentPolicy: 'skip',
    });

    // a policy chosen for the series' own local time is a real choice: an edit that sends that
    // time again needs no new one, and the shifted occurrence keeps its instant and resolution
    const shifted = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Sunday irrigation',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [0],
        startDate: '2027-03-07',
        count: 2,
      },
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch2.northHalfId],
      nonexistentPolicy: 'shift_forward',
    });
    await series.editSeries(programManager, shifted.id, {
      scope: 'entire_series',
      preview: false,
      changes: { localStartTime: '02:30', durationMinutes: 45 },
      expectedRevision: shifted.revision,
    });
    const irrigation = await rowsOf(shifted.id);
    expect(starts(irrigation)).toEqual(['2027-03-07T10:30:00.000Z', '2027-03-14T10:30:00.000Z']);
    expect(irrigation.map((r) => r.dst_resolution)).toEqual(['exact', 'shifted_forward']);
  });

  it('R3-TRACE-A-08 / SPK-SCHED-008: an edit re-resolves only the axis it names, records the resolution of a new local time, and applies a gap policy to shifted occurrences', async () => {
    t.clock.set('2026-10-01T12:00:00Z');
    const pitch3 = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 3',
    });
    const rowsOf = (seriesId: string) =>
      t.db
        .selectFrom('events')
        .select(['id', 'occurrence_index', 'scheduled_start', 'dst_resolution', 'status'])
        .where('series_id', '=', seriesId)
        .orderBy('occurrence_index')
        .execute();
    const shape = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
      rows.map((r) => [new Date(r.scheduled_start).toISOString(), r.dst_resolution, r.status]);
    const changesOf = async (eventId: string) =>
      (
        await t.db
          .selectFrom('outbox_events')
          .select(['event_type', 'payload'])
          .where('aggregate_id', '=', eventId)
          .where('event_type', '=', 'scheduling.event_changed')
          .execute()
      ).map((o) => (o.payload as { change: string }).change);
    const revisionOf = async (id: string) => (await series.getSeries(programManager, id)).revision;
    const weekly = (startDate: string) => ({
      frequency: 'weekly' as const,
      interval: 1,
      byWeekday: [0],
      startDate,
      count: 3,
    });

    // 1. An overlap-day occurrence resolved individually keeps that choice when a later edit names
    // only the other axis (the series' stored ambiguous policy is not applied to it).
    const overlap = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'practice',
      title: 'A1',
      recurrence: weekly('2026-10-25'),
      localStartTime: '01:30',
      durationMinutes: 30,
      resourceIds: [pitch3.northHalfId],
      ambiguousPolicy: 'second',
    });
    await series.editSeries(programManager, overlap.id, {
      scope: 'one',
      occurrenceIndex: 1,
      preview: false,
      changes: { ambiguousPolicy: 'first' },
      expectedRevision: await revisionOf(overlap.id),
    });
    const resolvedFirst = await rowsOf(overlap.id);
    expect(shape(resolvedFirst)[1]).toEqual(['2026-11-01T08:30:00.000Z', 'first', 'published']);
    const noticesBefore = await changesOf(resolvedFirst[1]!.id);
    const titleOnly = await series.editSeries(programManager, overlap.id, {
      scope: 'entire_series',
      preview: false,
      changes: { title: 'A2', nonexistentPolicy: 'skip' },
      expectedRevision: await revisionOf(overlap.id),
    });
    expect(titleOnly.affected.map((a) => a.dstResolution)).toEqual(['exact', 'first', 'exact']);
    expect(shape(await rowsOf(overlap.id))).toEqual([
      ['2026-10-25T08:30:00.000Z', 'exact', 'published'],
      ['2026-11-01T08:30:00.000Z', 'first', 'published'],
      ['2026-11-08T09:30:00.000Z', 'exact', 'published'],
    ]);
    // a title change, not a move
    expect((await changesOf(resolvedFirst[1]!.id)).slice(noticesBefore.length)).toEqual([
      'updated',
    ]);
    // naming the ambiguous axis for the entire series does apply to it
    await series.editSeries(programManager, overlap.id, {
      scope: 'entire_series',
      preview: false,
      changes: { ambiguousPolicy: 'second' },
      expectedRevision: await revisionOf(overlap.id),
    });
    expect(shape(await rowsOf(overlap.id))[1]).toEqual([
      '2026-11-01T09:30:00.000Z',
      'second',
      'published',
    ]);

    // 2. A new local start records its own resolution even where the instant stays the same:
    // 02:30 (shifted to 03:30 on 2028-03-12) moved to 03:30 is exact there ...
    const toLater = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Sunday line marking',
      recurrence: weekly('2028-03-05'),
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch3.northHalfId],
      nonexistentPolicy: 'shift_forward',
    });
    expect(shape(await rowsOf(toLater.id))[1]).toEqual([
      '2028-03-12T10:30:00.000Z',
      'shifted_forward',
      'published',
    ]);
    const laterPreview = await series.editSeries(programManager, toLater.id, {
      scope: 'entire_series',
      preview: true,
      changes: { localStartTime: '03:30' },
      expectedRevision: toLater.revision,
    });
    expect(laterPreview.affected.map((a) => a.dstResolution)).toEqual(['exact', 'exact', 'exact']);
    await series.editSeries(programManager, toLater.id, {
      scope: 'entire_series',
      preview: false,
      changes: { localStartTime: '03:30' },
      expectedRevision: toLater.revision,
    });
    expect(shape(await rowsOf(toLater.id))).toEqual([
      ['2028-03-05T11:30:00.000Z', 'exact', 'published'], // 03:30 PST
      ['2028-03-12T10:30:00.000Z', 'exact', 'published'], // 03:30 PDT, asked for, not shifted
      ['2028-03-19T10:30:00.000Z', 'exact', 'published'],
    ]);
    // ... and 03:30 moved to 02:30 under shift_forward is shifted there, at the same instant
    const toEarlier = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Sunday goal check',
      recurrence: weekly('2028-03-05'),
      localStartTime: '03:30',
      durationMinutes: 30,
      resourceIds: [pitch3.southHalfId],
    });
    const earlierChange = {
      scope: 'entire_series' as const,
      changes: { localStartTime: '02:30', nonexistentPolicy: 'shift_forward' as const },
      expectedRevision: toEarlier.revision,
    };
    const earlierPreview = await series.editSeries(programManager, toEarlier.id, {
      ...earlierChange,
      preview: true,
    });
    expect(earlierPreview.affected.map((a) => a.dstResolution)).toEqual([
      'exact',
      'shifted_forward',
      'exact',
    ]);
    await series.editSeries(programManager, toEarlier.id, { ...earlierChange, preview: false });
    expect(shape(await rowsOf(toEarlier.id))).toEqual([
      ['2028-03-05T10:30:00.000Z', 'exact', 'published'], // 02:30 PST
      ['2028-03-12T10:30:00.000Z', 'shifted_forward', 'published'], // 02:30 does not exist
      ['2028-03-19T09:30:00.000Z', 'exact', 'published'], // 02:30 PDT
    ]);

    // 3. A gap policy named without a new time concerns the occurrences shifted out of the gap
    // (they stand for 02:30, not 03:30): skip cancels the shifted occurrence, so the series' stored
    // policy and its occurrences agree; shift_forward keeps it.
    const gap = await series.createSeries(programManager, {
      facilityId: facility,
      kind: 'maintenance',
      title: 'Sunday drainage check',
      recurrence: weekly('2027-03-07'),
      localStartTime: '02:30',
      durationMinutes: 30,
      resourceIds: [pitch3.northHalfId],
      nonexistentPolicy: 'shift_forward',
    });
    const created = shape(await rowsOf(gap.id));
    expect(created[1]).toEqual(['2027-03-14T10:30:00.000Z', 'shifted_forward', 'published']);
    await series.editSeries(programManager, gap.id, {
      scope: 'entire_series',
      preview: false,
      changes: { nonexistentPolicy: 'shift_forward' },
      expectedRevision: await revisionOf(gap.id),
    });
    expect(shape(await rowsOf(gap.id))).toEqual(created);
    const skipPreview = await series.editSeries(programManager, gap.id, {
      scope: 'entire_series',
      preview: true,
      changes: { nonexistentPolicy: 'skip' },
      expectedRevision: await revisionOf(gap.id),
    });
    expect(skipPreview.affected.map((a) => a.after?.scheduledStart ?? null)).toEqual([
      '2027-03-07T10:30:00.000Z',
      null,
      '2027-03-21T09:30:00.000Z',
    ]);
    await series.editSeries(programManager, gap.id, {
      scope: 'entire_series',
      preview: false,
      changes: { nonexistentPolicy: 'skip' },
      expectedRevision: await revisionOf(gap.id),
    });
    const skippedRows = await rowsOf(gap.id);
    expect(skippedRows.map((r) => r.status)).toEqual(['published', 'canceled', 'published']);
    expect((await events.getEvent(programManager, skippedRows[1]!.id)).cancelReason).toBe(
      'Skipped: the new local start time does not exist on this date',
    );
    expect(await series.getSeries(programManager, gap.id)).toMatchObject({
      localStartTime: '02:30',
      nonexistentPolicy: 'skip',
    });
  });

  it('R3-TIME-MONEY-04 / SPK-SCHED-007: an HTTP series whose until date describes more than 366 occurrences is refused (SERIES_TOO_LONG), never truncated', async () => {
    const before = await t.db.selectFrom('event_series').select('id').execute();
    const res = await t.http
      .post('/v1/event-series')
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        facilityId: facility,
        kind: 'rental',
        title: 'Nightly field reservation',
        // 426 nightly dates; the 366-occurrence cap used to stop at 2027-11-01 without a signal
        recurrence: {
          frequency: 'daily',
          interval: 1,
          startDate: '2026-11-01',
          until: '2027-12-31',
        },
        localStartTime: '21:00',
        durationMinutes: 60,
        resourceIds: [pitch.southHalfId],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'SERIES_TOO_LONG', maxOccurrences: 366 },
    });
    expect(await t.db.selectFrom('event_series').select('id').execute()).toHaveLength(
      before.length,
    );
    expect(
      await t.db
        .selectFrom('events')
        .select('id')
        .where('title', '=', 'Nightly field reservation')
        .execute(),
    ).toEqual([]);
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
