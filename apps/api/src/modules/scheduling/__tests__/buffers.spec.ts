import { DomainError, newId, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { EventSeriesService } from '../services/event-series.service';
import { EventsService } from '../services/events.service';
import { ResourcesService } from '../services/resources.service';
import { ScheduleDraftsService } from '../services/schedule-drafts.service';
import { SchedulingModule } from '../scheduling.module';
import { at, seedPitchWithHalves, type PitchFixture } from '../testing/scheduling-fixtures';

/**
 * SPK-SCHED-003: conflict checks include preparation and cleanup buffers; "a ten-minute turnover
 * requirement does not make its space available at 19:00". A resource's default setup and cleanup
 * is its turnover requirement (SPK-SCHED-001), so every write path holds at least the largest
 * requirement among the resources it actually reserves.
 */
describe('turnover buffers follow the reserved resources (SPK-SCHED-001/003)', () => {
  let t: TestApp;
  let events: EventsService;
  let resources: ResourcesService;
  let drafts: ScheduleDraftsService;
  let series: EventSeriesService;
  let pitch: PitchFixture;
  let scheduler: Principal;

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    resources = t.app.get(ResourcesService);
    drafts = t.app.get(ScheduleDraftsService);
    series = t.app.get(EventSeriesService);
    // each half has a 10-minute cleanup requirement
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    scheduler = staffPrincipal(t.organizationId, ['scheduler']);
  });
  afterAll(async () => {
    await t.close();
  });

  const book = (
    resourceId: string,
    start: string,
    end: string,
    extra: { setupMinutes?: number; cleanupMinutes?: number } = {},
  ) =>
    events.createEvent(scheduler, {
      facilityId: t.facilityId,
      kind: 'game',
      title: 'Game',
      scheduledStart: start,
      scheduledEnd: end,
      resourceIds: [resourceId],
      sourceType: 'fixture',
      sourceId: newId(),
      ...extra,
    });
  const outcome = (p: Promise<{ status: string }>) =>
    p.then(
      (e) => e.status,
      (error: unknown) => (DomainError.is(error) ? error.code : String(error)),
    );
  const room = (name: string) =>
    resources.createResource(scheduler, { facilityId: t.facilityId, kind: 'room', name });
  const occupiedOf = async (eventId: string) => {
    const rows = await t.db
      .selectFrom('reservations')
      .select((eb) => [
        eb.fn<string>('lower', [eb.ref('occupied')]).as('start'),
        eb.fn<string>('upper', [eb.ref('occupied')]).as('end'),
      ])
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
    return rows.map((r) => ({
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
    }));
  };

  it('SPK-SCHED-003: an explicit cleanup below the half requirement is raised to it, so the space is not free at 19:00', async () => {
    const game = await book(
      pitch.southHalfId,
      at('2026-11-02', '18:00'),
      at('2026-11-02', '19:00'),
      {
        cleanupMinutes: 0,
      },
    );
    expect(game.cleanupMinutes).toBe(10);
    expect(
      await outcome(book(pitch.southHalfId, at('2026-11-02', '19:00'), at('2026-11-02', '20:00'))),
    ).toBe('RESOURCE_CONFLICT');
    // a larger explicit value extends the buffer
    const long = await book(
      pitch.southHalfId,
      at('2026-11-02', '10:00'),
      at('2026-11-02', '11:00'),
      {
        cleanupMinutes: 25,
      },
    );
    expect(long.cleanupMinutes).toBe(25);
    // availability reserves the same buffer createEvent will hold: a 09:00-10:00 slot would need
    // the half until 10:10, which the 10:00 game already holds
    const slots = await events.findAvailableSlots(scheduler, {
      resourceId: pitch.southHalfId,
      interval: { start: at('2026-11-02', '08:30'), end: at('2026-11-02', '10:00') },
      durationMinutes: 60,
      cleanupMinutes: 0,
      stepMinutes: 10,
    });
    expect(slots.map((s) => s.start)).toEqual([
      at('2026-11-02', '08:30'),
      at('2026-11-02', '08:40'),
      at('2026-11-02', '08:50'),
    ]);
  });

  it('SPK-SCHED-003: moving an event from a room without buffer onto a half takes the half requirement', async () => {
    const plain = await room('Room A');
    const event = await book(plain.id, at('2026-11-03', '18:00'), at('2026-11-03', '19:00'));
    expect(event.cleanupMinutes).toBe(0);
    const moved = await events.moveEvent(scheduler, event.id, {
      scheduledStart: at('2026-11-03', '18:00'),
      scheduledEnd: at('2026-11-03', '19:00'),
      resourceIds: [pitch.northHalfId],
      expectedRevision: event.revision,
    });
    expect(moved.cleanupMinutes).toBe(10);
    expect(await occupiedOf(event.id)).toEqual([
      { start: at('2026-11-03', '18:00'), end: at('2026-11-03', '19:10') },
    ]);
    expect(
      await outcome(book(pitch.northHalfId, at('2026-11-03', '19:00'), at('2026-11-03', '20:00'))),
    ).toBe('RESOURCE_CONFLICT');
    // moving back onto the room does not carry the half's turnover along
    const back = await events.moveEvent(scheduler, event.id, {
      scheduledStart: at('2026-11-03', '18:00'),
      scheduledEnd: at('2026-11-03', '19:00'),
      resourceIds: [plain.id],
      expectedRevision: moved.revision,
    });
    expect(back.cleanupMinutes).toBe(0);
  });

  it('SPK-SCHED-003: a draft resource change onto a half and a draft create with cleanup 0 both hold the half requirement', async () => {
    const plain = await room('Room B');
    const event = await book(plain.id, at('2026-11-04', '18:00'), at('2026-11-04', '19:00'));
    const draft = await drafts.create(scheduler, {
      facilityId: t.facilityId,
      name: 'buffers',
      changes: [
        { kind: 'resource_change', targetEventId: event.id, resourceIds: [pitch.northHalfId] },
        {
          kind: 'create',
          resourceIds: [pitch.southHalfId],
          proposed: {
            kind: 'game',
            title: 'Draft game',
            scheduledStart: at('2026-11-04', '18:00'),
            scheduledEnd: at('2026-11-04', '19:00'),
            cleanupMinutes: 0,
          },
        },
      ],
    });
    const publication = await drafts.publish(scheduler, draft.id, {});
    const after = await events.getEvent(scheduler, event.id);
    expect(after).toMatchObject({ resourceIds: [pitch.northHalfId], cleanupMinutes: 10 });
    const created = publication.eventIds.find((id) => id !== event.id) as string;
    expect((await events.getEvent(scheduler, created)).cleanupMinutes).toBe(10);
    for (const half of [pitch.northHalfId, pitch.southHalfId]) {
      expect(await outcome(book(half, at('2026-11-04', '19:00'), at('2026-11-04', '20:00')))).toBe(
        'RESOURCE_CONFLICT',
      );
    }
  });

  it('SPK-SCHED-003: a series edit onto a half recomputes every occurrence buffer', async () => {
    const plain = await room('Room C');
    const created = await series.createSeries(scheduler, {
      facilityId: t.facilityId,
      kind: 'practice',
      title: 'Weekly practice',
      recurrence: { frequency: 'weekly', interval: 1, startDate: '2026-11-05', count: 2 },
      localStartTime: '18:00',
      durationMinutes: 60,
      resourceIds: [plain.id],
    });
    expect(created.cleanupMinutes).toBe(0);
    await series.editSeries(scheduler, created.id, {
      scope: 'entire_series',
      preview: false,
      changes: { resourceIds: [pitch.northHalfId] },
      expectedRevision: created.revision,
    });
    const rows = await t.db
      .selectFrom('events')
      .select(['cleanup_minutes', 'scheduled_end'])
      .where('series_id', '=', created.id)
      .orderBy('occurrence_index')
      .execute();
    expect(rows.map((r) => r.cleanup_minutes)).toEqual([10, 10]);
    expect((await series.getSeries(scheduler, created.id)).cleanupMinutes).toBe(10);
    const end = new Date(rows[0]!.scheduled_end);
    expect(
      await outcome(
        book(
          pitch.northHalfId,
          end.toISOString(),
          new Date(end.getTime() + 60 * 60_000).toISOString(),
        ),
      ),
    ).toBe('RESOURCE_CONFLICT');
    // a series created on a half with an explicit zero cleanup is raised to the requirement
    const onHalf = await series.createSeries(scheduler, {
      facilityId: t.facilityId,
      kind: 'practice',
      title: 'Half practice',
      recurrence: { frequency: 'weekly', interval: 1, startDate: '2026-11-06', count: 1 },
      localStartTime: '10:00',
      durationMinutes: 60,
      cleanupMinutes: 0,
      resourceIds: [pitch.southHalfId],
    });
    expect(onHalf.cleanupMinutes).toBe(10);
  });
});
