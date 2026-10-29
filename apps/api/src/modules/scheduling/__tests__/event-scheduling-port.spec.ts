import {
  DomainError,
  errors,
  importActorLabel,
  newId,
  systemPrincipal,
  type Principal,
  type RecordAuthorityScope,
} from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORD_AUTHORITY_IMPL, UnitOfWork, type RecordAuthorityPort } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  EVENT_SCHEDULING_PORT,
  type CreateEventSeriesInput,
  type EventSchedulingPort,
} from '../ports';
import { SchedulingModule } from '../scheduling.module';
import { EventsService } from '../services/events.service';
import { BOOKING_SOURCE_TYPE } from '../services/event-writer';
import { localTimeOf } from '../time/local-time';
import {
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

const HOUR = 3_600_000;

async function caught(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (DomainError.is(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/**
 * SCH-02 / SCH-03 (IF-31): series and cancellation on EVENT_SCHEDULING_PORT, conflict-first
 * (SPK-COND-003 "reserve all required resources together"), joined to the caller's unit of work,
 * authority-checked in process (K-11, IF-42, §5.6), and clock-stamped (CLAUDE.md data rules).
 */
describe('EVENT_SCHEDULING_PORT series, cancellation and authority (SCH-02, SCH-03)', () => {
  let t: TestApp;
  let port: EventSchedulingPort;
  let events: EventsService;
  let uow: UnitOfWork;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let booking: Principal;

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    port = t.app.get<EventSchedulingPort>(EVENT_SCHEDULING_PORT);
    events = t.app.get(EventsService);
    uow = t.app.get(UnitOfWork);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    booking = systemPrincipal(org, BOOKING_SOURCE_TYPE);
  });
  afterAll(async () => {
    await t.close();
  });

  const weekly = (overrides: Partial<CreateEventSeriesInput> = {}): CreateEventSeriesInput => ({
    kind: 'rental',
    title: 'Tuesday rental',
    facilityId: facility,
    resourceIds: [pitch.northHalfId],
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      byWeekday: [2],
      startDate: '2026-11-03',
      count: 4,
    },
    localStartTime: '19:00',
    durationMinutes: 60,
    sourceType: BOOKING_SOURCE_TYPE,
    sourceId: newId(),
    ...overrides,
  });

  const rowsOf = async (sourceId: string) => ({
    series: await t.db
      .selectFrom('event_series')
      .select('id')
      .where('source_id', '=', sourceId)
      .execute(),
    events: await t.db
      .selectFrom('events')
      .select(['id', 'status'])
      .where('source_id', '=', sourceId)
      .execute(),
  });

  it('SPK-COND-003: a series with one conflicting occurrence writes nothing and lists that occurrence', async () => {
    // the third Tuesday is already taken on the whole pitch (it covers the north half)
    const taken = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-17', '19:30'),
      end: at('2026-11-17', '20:30'),
      title: 'League game',
    });
    const input = weekly();
    const outboxBefore = (await t.db.selectFrom('outbox_events').select('id').execute()).length;
    const error = await caught(uow.run(() => port.createEventSeries(booking, input)));
    expect(error.code).toBe('RESOURCE_CONFLICT');
    const details = error.details as {
      conflicts: Array<{
        occurrenceIndex: number;
        occurrenceStart: string;
        conflictingEventIds: string[];
        details: Array<{ code: string }>;
      }>;
      conflictingEventIds: string[];
    };
    expect(details.conflicts).toHaveLength(1);
    expect(details.conflicts[0]).toMatchObject({
      occurrenceIndex: 2,
      occurrenceStart: at('2026-11-17', '19:00'),
      conflictingEventIds: [taken.id],
    });
    expect(details.conflicts[0]?.details.map((d) => d.code)).toContain('physical_overlap');
    expect(details.conflictingEventIds).toEqual([taken.id]);
    // nothing written: no series, no event, no reservation, no notice
    expect(await rowsOf(input.sourceId)).toEqual({ series: [], events: [] });
    expect((await t.db.selectFrom('outbox_events').select('id').execute()).length).toBe(
      outboxBefore,
    );
  });

  it('SCH-02: a series reserves every occurrence with one notice each, and rolls back with the caller’s unit of work', async () => {
    const input = weekly({
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [4],
        startDate: '2026-11-05',
        count: 3,
      },
      kind: 'party',
      title: 'Birthday party',
    });
    // a joined unit: the caller fails after the series, so nothing of it remains
    await expect(
      uow.run(async () => {
        await port.createEventSeries(booking, input);
        throw new Error('booking failed after scheduling');
      }),
    ).rejects.toThrow('booking failed after scheduling');
    expect(await rowsOf(input.sourceId)).toEqual({ series: [], events: [] });

    const created = await uow.run(() => port.createEventSeries(booking, input));
    expect(created.eventIds).toHaveLength(3);
    const rows = await t.db
      .selectFrom('events')
      .select(['id', 'status', 'series_id', 'occurrence_index', 'kind', 'source_type'])
      .where('id', 'in', created.eventIds)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((r) => [r.status, r.series_id, r.occurrence_index, r.kind])).toEqual([
      ['published', created.seriesId, 0, 'party'],
      ['published', created.seriesId, 1, 'party'],
      ['published', created.seriesId, 2, 'party'],
    ]);
    expect(rows.every((r) => r.source_type === BOOKING_SOURCE_TYPE)).toBe(true);
    const reservations = await t.db
      .selectFrom('reservations')
      .select(['event_id', 'resource_id', 'status'])
      .where('event_id', 'in', created.eventIds)
      .execute();
    expect(reservations).toHaveLength(3);
    expect(reservations.every((r) => r.resource_id === pitch.northHalfId)).toBe(true);
    const notices = await t.db
      .selectFrom('outbox_events')
      .select(['aggregate_id', 'payload'])
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', 'in', created.eventIds)
      .execute();
    expect(notices).toHaveLength(3);
    expect(notices.every((n) => (n.payload as { change: string }).change === 'created')).toBe(true);
  });

  it('SPK-SCHED-008: weekly occurrences keep their local start time across a daylight-saving change', async () => {
    // US daylight saving time ends on Sunday 2026-11-01: 18:00 local is 01:00Z before, 02:00Z after
    const created = await uow.run(() =>
      port.createEventSeries(
        booking,
        weekly({
          resourceIds: [pitch.southHalfId],
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byWeekday: [3],
            startDate: '2026-10-21',
            count: 3,
          },
          localStartTime: '18:00',
        }),
      ),
    );
    const rows = await t.db
      .selectFrom('events')
      .select(['scheduled_start', 'scheduled_end', 'timezone', 'dst_resolution'])
      .where('id', 'in', created.eventIds)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((r) => new Date(r.scheduled_start).toISOString())).toEqual([
      '2026-10-22T01:00:00.000Z',
      '2026-10-29T01:00:00.000Z',
      '2026-11-05T02:00:00.000Z',
    ]);
    for (const row of rows) {
      expect(localTimeOf(row.timezone, new Date(row.scheduled_start))).toBe('18:00');
      expect(new Date(row.scheduled_end).getTime() - new Date(row.scheduled_start).getTime()).toBe(
        HOUR,
      );
      expect(row.dst_resolution).toBe('exact');
    }
  });

  it('SCH-02: cancelEventSeries cancels the occurrences from an instant, releases their space and ends the series', async () => {
    const input = weekly({
      resourceIds: [pitch.southHalfId],
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [1],
        startDate: '2026-11-02',
        count: 4,
      },
      localStartTime: '20:00',
      commitments: [personCommitment(newId(), 'host')],
    });
    const created = await uow.run(() => port.createEventSeries(booking, input));
    const third = await events.getEvent(staffPrincipal(org, ['scheduler']), created.eventIds[2]!);
    const result = await uow.run(() =>
      port.cancelEventSeries(booking, created.seriesId, {
        reason: 'Booking ended early',
        fromInstant: third.scheduledStart,
      }),
    );
    expect(result.canceledEventIds).toEqual(created.eventIds.slice(2));
    const rows = await t.db
      .selectFrom('events')
      .select(['id', 'status', 'cancel_reason'])
      .where('series_id', '=', created.seriesId)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((r) => r.status)).toEqual(['published', 'published', 'canceled', 'canceled']);
    expect(rows[2]?.cancel_reason).toBe('Booking ended early');
    const active = await t.db
      .selectFrom('reservations')
      .select('event_id')
      .where('event_id', 'in', created.eventIds)
      .where('status', '=', 'active')
      .execute();
    expect(active.map((r) => r.event_id).sort()).toEqual(created.eventIds.slice(0, 2).sort());
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select(['event_id', 'status'])
      .where('event_id', 'in', created.eventIds.slice(2))
      .execute();
    expect(commitments.every((c) => c.status === 'released')).toBe(true);
    const canceledNotices = await t.db
      .selectFrom('outbox_events')
      .select(['aggregate_id', 'payload'])
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', 'in', created.eventIds)
      .execute();
    const canceled = canceledNotices.filter(
      (n) => (n.payload as { change: string }).change === 'canceled',
    );
    expect(canceled.map((n) => n.aggregate_id).sort()).toEqual(created.eventIds.slice(2).sort());
    const series = await t.db
      .selectFrom('event_series')
      .select(['status', 'revision'])
      .where('id', '=', created.seriesId)
      .executeTakeFirstOrThrow();
    expect(series).toEqual({ status: 'ended', revision: 2 });
    // the space is free again; a replay cancels nothing more
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: third.scheduledStart,
      end: third.scheduledEnd,
    });
    const replay = await uow.run(() =>
      port.cancelEventSeries(booking, created.seriesId, {
        reason: 'Booking ended early',
        fromInstant: third.scheduledStart,
      }),
    );
    expect(replay.canceledEventIds).toEqual([]);
    // the default instant is now: every occurrence still ahead is canceled
    const another = await uow.run(() =>
      port.createEventSeries(
        booking,
        weekly({
          resourceIds: [pitch.northHalfId],
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byWeekday: [6],
            startDate: '2026-10-24',
            count: 2,
          },
          localStartTime: '08:00',
        }),
      ),
    );
    t.clock.advance(7 * 24 * HOUR); // the first Saturday is in the past
    const now = await uow.run(() =>
      port.cancelEventSeries(booking, another.seriesId, { reason: 'Customer canceled' }),
    );
    expect(now.canceledEventIds).toEqual([another.eventIds[1]]);
    t.clock.advance(-7 * 24 * HOUR);
  });

  it('SCH-02: booking principal, kind and length rules', async () => {
    expect(
      (await caught(uow.run(() => port.createEventSeries(booking, weekly({ kind: 'game' })))))
        .details,
    ).toMatchObject({ code: 'BOOKING_EVENT_KIND' });
    expect(
      (
        await caught(
          uow.run(() => port.createEventSeries(booking, weekly({ sourceType: 'fixture' }))),
        )
      ).code,
    ).toBe('ACCESS_DENIED');
    const frontDesk = staffPrincipal(org, ['front_desk']);
    expect((await caught(uow.run(() => port.createEventSeries(frontDesk, weekly())))).code).toBe(
      'ACCESS_DENIED',
    );
    const tooMany = weekly({
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [2],
        startDate: '2026-11-03',
        count: 53,
      },
    });
    expect((await caught(uow.run(() => port.createEventSeries(booking, tooMany)))).code).toBe(
      'VALIDATION_FAILED',
    );
    const daily = weekly({
      recurrence: {
        frequency: 'daily' as 'weekly',
        interval: 1,
        startDate: '2026-11-03',
        count: 3,
      },
    });
    expect((await caught(uow.run(() => port.createEventSeries(booking, daily)))).code).toBe(
      'VALIDATION_FAILED',
    );
    const longUntil = weekly({
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [2, 4],
        startDate: '2026-11-03',
        until: '2027-11-03',
      },
    });
    expect(
      (await caught(uow.run(() => port.createEventSeries(booking, longUntil)))).details,
    ).toMatchObject({ code: 'SERIES_TOO_LONG', maxOccurrences: 52 });
    // a scheduler books any owning record's series through the port
    const scheduler = staffPrincipal(org, ['scheduler']);
    const staffSeries = await uow.run(() =>
      port.createEventSeries(
        scheduler,
        weekly({
          kind: 'practice',
          sourceType: 'team_practice',
          resourceIds: [pitch.pitchId],
          localStartTime: '07:00',
          recurrence: {
            frequency: 'weekly',
            interval: 2,
            byWeekday: [0],
            startDate: '2026-11-01',
            count: 2,
          },
        }),
      ),
    );
    expect(staffSeries.eventIds).toHaveLength(2);
  });

  it('SCH-02: two overlapping series race; one wins and the other writes nothing (PGlite and TEST_DATABASE_URL)', async () => {
    const first = weekly({
      resourceIds: [pitch.pitchId],
      localStartTime: '06:00',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [5],
        startDate: '2026-11-06',
        count: 3,
      },
    });
    const second = { ...first, sourceId: newId(), resourceIds: [pitch.northHalfId] };
    const results = await Promise.allSettled([
      uow.run(() => port.createEventSeries(booking, first)),
      uow.run(() => port.createEventSeries(booking, second)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const loser = results[0]?.status === 'rejected' ? first : second;
    expect(await rowsOf(loser.sourceId)).toEqual({ series: [], events: [] });
  });

  it('SCH-03: reservation and event created_at follow FixedClock', async () => {
    t.clock.advance(HOUR + 17_000);
    const now = t.clock.now().getTime();
    const event = await uow.run(() =>
      port.createEvent(booking, {
        facilityId: facility,
        kind: 'rental',
        title: 'Clock-stamped rental',
        scheduledStart: at('2026-12-01', '10:00'),
        scheduledEnd: at('2026-12-01', '11:00'),
        resourceIds: [pitch.northHalfId],
        commitments: [personCommitment(newId(), 'renter')],
        sourceType: BOOKING_SOURCE_TYPE,
        sourceId: newId(),
      }),
    );
    expect(new Date(event.createdAt).getTime()).toBe(now);
    const stamp = (rows: Array<{ created_at: Date }>) =>
      rows.map((r) => new Date(r.created_at).getTime());
    const eventRow = await t.db
      .selectFrom('events')
      .select(['created_at', 'updated_at'])
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(new Date(eventRow.created_at).getTime()).toBe(now);
    expect(new Date(eventRow.updated_at).getTime()).toBe(now);
    for (const table of ['reservations', 'reservation_units', 'event_commitments'] as const) {
      const rows = await t.db
        .selectFrom(table)
        .select('created_at')
        .where('event_id', '=', event.id)
        .execute();
      expect(rows.length, table).toBeGreaterThan(0);
      expect(stamp(rows), table).toEqual(rows.map(() => now));
    }
    const series = await uow.run(() =>
      port.createEventSeries(
        booking,
        weekly({
          resourceIds: [pitch.southHalfId],
          localStartTime: '06:00',
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byWeekday: [2],
            startDate: '2026-12-01',
            count: 2,
          },
        }),
      ),
    );
    const seriesRow = await t.db
      .selectFrom('event_series')
      .select('created_at')
      .where('id', '=', series.seriesId)
      .executeTakeFirstOrThrow();
    expect(new Date(seriesRow.created_at).getTime()).toBe(now);
    const occurrenceRows = await t.db
      .selectFrom('events')
      .select('created_at')
      .where('id', 'in', series.eventIds)
      .execute();
    expect(stamp(occurrenceRows)).toEqual([now, now]);
  });
});

describe('EVENT_SCHEDULING_PORT under legacy schedule authority (§5.6, K-11, IF-42)', () => {
  let t: TestApp;
  let port: EventSchedulingPort;
  let uow: UnitOfWork;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let legacyFacility: string | null = null;
  const calls: Array<{ category: string; scope: RecordAuthorityScope | undefined }> = [];

  /** A deterministic authority fake: the legacy system holds the future schedule of one facility. */
  const authority: RecordAuthorityPort = {
    assertNoLegacyAuthority: async (_organizationId, category, scope) => {
      calls.push({ category, scope });
      if (category === 'future_schedule' && scope?.facilityId === legacyFacility) {
        throw errors.accessDenied('The legacy system is authoritative for this schedule.', {
          code: 'LEGACY_AUTHORITY',
          recordCategory: category,
        });
      }
    },
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SchedulingModule],
      providers: [{ provide: RECORD_AUTHORITY_IMPL, useValue: authority }],
      clockStart: '2026-10-19T12:00:00Z',
    });
    port = t.app.get<EventSchedulingPort>(EVENT_SCHEDULING_PORT);
    uow = t.app.get(UnitOfWork);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.6: a port reservation at a facility whose schedule authority is legacy answers LEGACY_AUTHORITY', async () => {
    const scheduler = staffPrincipal(org, ['scheduler']);
    const booking = systemPrincipal(org, BOOKING_SOURCE_TYPE);
    // created while SportsPark holds the schedule
    const event = await uow.run(() =>
      port.createEvent(scheduler, {
        facilityId: facility,
        kind: 'game',
        title: 'Before cutover',
        scheduledStart: at('2026-11-10', '18:00'),
        scheduledEnd: at('2026-11-10', '19:00'),
        resourceIds: [pitch.pitchId],
        sourceType: 'fixture',
        sourceId: newId(),
      }),
    );
    const series = await uow.run(() =>
      port.createEventSeries(booking, {
        kind: 'rental',
        title: 'Weekly rental',
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        recurrence: {
          frequency: 'weekly',
          interval: 1,
          byWeekday: [3],
          startDate: '2026-11-04',
          count: 2,
        },
        localStartTime: '07:00',
        durationMinutes: 60,
        sourceType: BOOKING_SOURCE_TYPE,
        sourceId: newId(),
      }),
    );
    expect(calls).toEqual([
      { category: 'future_schedule', scope: { facilityId: facility } },
      { category: 'future_schedule', scope: { facilityId: facility } },
    ]);

    legacyFacility = facility;
    const eventsBefore = (await t.db.selectFrom('events').select('id').execute()).length;
    const refusals: DomainError[] = [];
    const writes: Array<() => Promise<unknown>> = [
      () =>
        port.createEvent(scheduler, {
          facilityId: facility,
          kind: 'game',
          title: 'After cutover',
          scheduledStart: at('2026-11-12', '18:00'),
          scheduledEnd: at('2026-11-12', '19:00'),
          resourceIds: [pitch.pitchId],
          sourceType: 'fixture',
          sourceId: newId(),
        }),
      () =>
        port.createEventSeries(booking, {
          kind: 'rental',
          title: 'Weekly rental',
          facilityId: facility,
          resourceIds: [pitch.southHalfId],
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            byWeekday: [3],
            startDate: '2026-11-04',
            count: 2,
          },
          localStartTime: '07:00',
          durationMinutes: 60,
          sourceType: BOOKING_SOURCE_TYPE,
          sourceId: newId(),
        }),
      () =>
        port.moveEvent(scheduler, event.id, {
          scheduledStart: at('2026-11-10', '20:00'),
          scheduledEnd: at('2026-11-10', '21:00'),
        }),
      () => port.cancelEvent(scheduler, event.id, { reason: 'Moved to legacy' }),
      () => port.cancelEventSeries(booking, series.seriesId, { reason: 'Moved to legacy' }),
    ];
    for (const call of writes) {
      refusals.push(await caught(uow.run(call)));
    }
    expect(refusals).toHaveLength(5);
    for (const error of refusals) {
      expect(error).toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'LEGACY_AUTHORITY', recordCategory: 'future_schedule' },
      });
    }
    expect((await t.db.selectFrom('events').select('id').execute()).length).toBe(eventsBefore);
    const unchanged = await t.db
      .selectFrom('events')
      .select(['status', 'revision'])
      .where('id', 'in', [event.id, ...series.eventIds])
      .execute();
    expect(unchanged.every((e) => e.status === 'published' && e.revision === 1)).toBe(true);

    // the import is the batch's sanctioned writer: it never asks the authority port (IF-40)
    const callsBefore = calls.length;
    const batchId = newId();
    const imported = await uow.run(() =>
      port.importEvent(systemPrincipal(org, importActorLabel(batchId)), {
        facilityId: facility,
        kind: 'game',
        title: 'Imported fixture',
        scheduledStart: at('2026-11-14', '10:00'),
        scheduledEnd: at('2026-11-14', '11:00'),
        resourceIds: [pitch.pitchId],
        sourceType: 'fixture',
        sourceId: newId(),
        importProvenance: { batchId, externalKey: 'legacy-fixture-1', recordId: newId() },
      }),
    );
    expect(imported.status).toBe('draft');
    expect(calls.length).toBe(callsBefore);
    legacyFacility = null;
  });
});
