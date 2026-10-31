import { DomainError, newId, type Event, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { ConflictDetector } from '../conflicts/conflict-detector';
import { ClosuresService } from '../services/closures.service';
import { EventWriter } from '../services/event-writer';
import { EventsService } from '../services/events.service';
import { ResourcesService } from '../services/resources.service';
import { ScheduleDraftsService } from '../services/schedule-drafts.service';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  seedPitchWithHalves,
  seedResource,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

/** Pauses the next armed call of a patched method until the test opens it. */
class Gate {
  private armed = 0;
  private waiting: Array<() => void> = [];
  private onReached: (() => void) | null = null;

  arm(): Promise<void> {
    this.armed += 1;
    return new Promise((resolve) => (this.onReached = resolve));
  }

  async pass(): Promise<void> {
    if (this.armed === 0) return;
    this.armed -= 1;
    this.onReached?.();
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  open(): void {
    for (const release of this.waiting.splice(0)) release();
  }
}

/**
 * Rules the exclusion constraints cannot express, under overlapping commands (§4.7): closures
 * (SPK-SCHED-009, SPK-FAC-003, SPK-AT-009/021), configured arrangements between subdivisions
 * (SPK-SCHED-002) and required rest (SPK-SCHED-004). A gate pauses the first command inside its
 * transaction (after conflict detection, or after its reservation rows are written) while the
 * second one runs. Under TEST_DATABASE_URL the two transactions really overlap and the locks
 * decide the order; under PGlite they run one after the other. The asserted outcome is the one a
 * sequential execution gives, in both modes.
 */
describe('scheduling rules under concurrent commands (§4.7, SPK-SCHED-002/004/009, SPK-FAC-003)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let resources: ResourcesService;
  let scheduler: Principal;
  const afterDetect = new Gate();
  const afterReserve = new Gate();

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    resources = t.app.get(ResourcesService);
    const detector = t.app.get(ConflictDetector);
    const detect = detector.detect.bind(detector);
    detector.detect = async (...args) => {
      const result = await detect(...args);
      await afterDetect.pass();
      return result;
    };
    const writer = t.app.get(EventWriter);
    const reserve = writer.reserve.bind(writer);
    writer.reserve = async (...args) => {
      await reserve(...args);
      await afterReserve.pass();
    };
    scheduler = staffPrincipal(t.organizationId, ['scheduler']);
  });
  afterAll(async () => {
    await t?.close();
  });

  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const codeOf = (r: { ok: boolean; error?: unknown }) =>
    r.ok ? 'OK' : DomainError.is(r.error) ? r.error.code : `RAW:${String(r.error)}`;
  const conflictCodes = (r: { ok: boolean; error?: unknown }) =>
    !r.ok && DomainError.is(r.error)
      ? (
          ((r.error.details as Record<string, unknown> | undefined)?.['conflicts'] as
            Array<{ code: string }> | undefined) ?? []
        ).map((c) => c.code)
      : [];
  /** Lets the second command run into whatever lock the paused one holds (PostgreSQL only). */
  const overlap = () =>
    t.database.concurrent ? new Promise((resolve) => setTimeout(resolve, 300)) : Promise.resolve();
  const book = (
    resourceId: string,
    day: string,
    from: string,
    to: string,
    extra: { commitments?: ReturnType<typeof teamCommitment>[] } = {},
  ): Promise<Event> =>
    events.createEvent(scheduler, {
      facilityId: t.facilityId,
      kind: 'game',
      title: 'Game',
      scheduledStart: at(day, from),
      scheduledEnd: at(day, to),
      resourceIds: [resourceId],
      sourceType: 'fixture',
      sourceId: newId(),
      ...extra,
    });
  /** Published events that still hold one of the units during the interval. */
  const heldInside = async (unitIds: string[], start: string, end: string) =>
    (
      await t.db
        .selectFrom('reservation_units as u')
        .innerJoin('events as e', 'e.id', 'u.event_id')
        .select('e.id')
        .distinct()
        .where('u.status', '=', 'active')
        .where('e.status', '=', 'published')
        .where('u.conflict_unit_id', 'in', unitIds)
        .where(sql<boolean>`u.occupied && tstzrange(${start}::timestamptz, ${end}::timestamptz)`)
        .execute()
    ).map((r) => r.id);

  describe('closures', () => {
    let pitch: PitchFixture;
    beforeAll(async () => {
      pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Closure pitch',
      });
    });

    it('SPK-SCHED-009 / SPK-FAC-003 / SPK-AT-021: a closure applied while a booking is in flight never leaves that booking inside the active closure', async () => {
      const interval = { start: at('2026-11-02', '08:00'), end: at('2026-11-02', '20:00') };
      const closure = await closures.createClosure(scheduler, {
        facilityId: t.facilityId,
        resourceId: pitch.northHalfId,
        interval,
        reason: 'Turf repair',
        source: 'maintenance',
      });
      const reached = afterDetect.arm();
      const booking = settle(book(pitch.northHalfId, '2026-11-02', '10:00', '11:00'));
      await reached; // the booking passed detection: the closure was still pending
      const apply = settle(
        closures.applyClosure(scheduler, closure.id, {
          mode: 'cancel_affected',
          expectedRevision: closure.revision,
        }),
      );
      let applied: Awaited<typeof apply>;
      if (t.database.concurrent) {
        applied = await apply; // the closure commits while the booking is paused
        afterDetect.open();
      } else {
        afterDetect.open();
        applied = await apply;
      }
      const booked = await booking;
      expect(codeOf(applied)).toBe('OK');
      const active = await closures.getClosure(scheduler, closure.id);
      expect(active.status).toBe('active');
      if (booked.ok) {
        // the booking committed first: the apply saw it and cancelled it
        expect(active.resolution?.canceledEventIds).toEqual([booked.value.id]);
      } else {
        expect(codeOf(booked)).toBe('RESOURCE_CONFLICT');
        expect(conflictCodes(booked)).toContain('closure');
      }
      if (t.database.concurrent) expect(booked.ok).toBe(false);
      expect(await heldInside([pitch.units.north], interval.start, interval.end)).toEqual([]);
    });

    it('SPK-SCHED-009 / SPK-AT-009: a booking in flight when a facility-wide closure is applied is part of its impact and its resolution', async () => {
      const interval = { start: at('2026-11-03', '08:00'), end: at('2026-11-03', '20:00') };
      const closure = await closures.createClosure(scheduler, {
        facilityId: t.facilityId,
        interval,
        reason: 'Storm',
        source: 'manual',
      });
      const reached = afterReserve.arm();
      const booking = settle(book(pitch.pitchId, '2026-11-03', '10:00', '11:00'));
      await reached; // reservation rows written, not committed
      const apply = settle(
        closures.applyClosure(scheduler, closure.id, {
          mode: 'leave_for_resolution',
          expectedRevision: closure.revision,
        }),
      );
      await overlap(); // the apply waits for the booking's unit locks
      afterReserve.open();
      const booked = await booking;
      const applied = await apply;
      expect(codeOf(booked)).toBe('OK');
      expect(codeOf(applied)).toBe('OK');
      const eventId = booked.ok ? booked.value.id : '';
      const active = await closures.getClosure(scheduler, closure.id);
      expect(active.status).toBe('active');
      expect(active.impact?.affectedEvents.map((e) => e.eventId)).toEqual([eventId]);
      expect(active.resolution?.unresolvedEventIds).toEqual([eventId]);
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select('details')
        .where('dedupe_key', '=', `closure:${closure.id}`)
        .executeTakeFirst();
      expect(exception?.details).toMatchObject({ eventIds: [eventId] });
    });
  });

  it('SPK-SCHED-002: two halves whose simultaneous use no active configuration permits cannot both be booked by overlapping commands', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Arrangement pitch',
    });
    await resources.updateConfiguration(scheduler, pitch.twoHalvesConfigurationId, {
      expectedRevision: 1,
      active: false,
    });
    const reached = afterDetect.arm();
    const first = settle(book(pitch.northHalfId, '2026-11-04', '10:00', '11:00'));
    await reached;
    const second = settle(book(pitch.southHalfId, '2026-11-04', '10:00', '11:00'));
    await overlap(); // the second booking waits on the parent resource
    afterDetect.open();
    const results = [await first, await second];
    expect(results.map(codeOf).sort()).toEqual(['OK', 'RESOURCE_CONFLICT']);
    const refused = results.find((r) => !r.ok) as { ok: false; error: unknown };
    expect(conflictCodes(refused)).toContain('configuration_not_permitted');
    const active = await t.db
      .selectFrom('reservations')
      .select('resource_id')
      .where('resource_id', 'in', [pitch.northHalfId, pitch.southHalfId])
      .where('status', '=', 'active')
      .execute();
    expect(active).toHaveLength(1);
  });

  it('SPK-AT-008 / §4.7: concurrent publications of drafts that hold the same space commit a non-overlapping set and leave no partial rows', async () => {
    const drafts = t.app.get(ScheduleDraftsService);
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Publication race pitch',
    });
    const day = '2026-11-09';
    const title = `Race ${newId()}`;
    const open = (name: string, resourceId: string) =>
      drafts.create(scheduler, {
        facilityId: t.facilityId,
        name,
        changes: [
          {
            kind: 'create',
            proposed: {
              kind: 'game',
              title,
              scheduledStart: at(day, '10:00'),
              scheduledEnd: at(day, '11:00'),
            },
            resourceIds: [resourceId],
          },
        ],
      });
    const whole = await Promise.all([0, 1, 2, 3].map((i) => open(`whole ${i}`, pitch.pitchId)));
    const north = await Promise.all([0, 1].map((i) => open(`north ${i}`, pitch.northHalfId)));
    const south = await Promise.all([0, 1].map((i) => open(`south ${i}`, pitch.southHalfId)));
    const all = [...whole, ...north, ...south];
    // Every publication starts at once; under TEST_DATABASE_URL they race for the same units.
    const results = await Promise.all(all.map((d) => settle(drafts.publish(scheduler, d.id, {}))));
    const committed = (group: typeof all) =>
      group.filter((d) => results[all.indexOf(d)]?.ok === true).length;
    const [w, n, so] = [committed(whole), committed(north), committed(south)];
    // Either the whole pitch alone, or at most one booking of each half (the two halves may share
    // the hour under the active two-halves configuration), never a half under the whole pitch.
    expect(
      (w === 1 && n === 0 && so === 0) || (w === 0 && n <= 1 && so <= 1 && n + so >= 1),
      `whole=${w} north=${n} south=${so}`,
    ).toBe(true);
    const failures = results.filter((r) => !r.ok);
    expect(failures.length).toBe(all.length - (w + n + so));
    expect(new Set(failures.map(codeOf))).toEqual(new Set(['RESOURCE_CONFLICT']));

    // No partial publication: one event, one publication and one succeeded operation per committed
    // draft; every refused draft is failed with its operation failed and nothing else written.
    const created = await t.db
      .selectFrom('events')
      .select('id')
      .where('title', '=', title)
      .execute();
    expect(created).toHaveLength(w + n + so);
    const publications = await t.db
      .selectFrom('publications')
      .select('draft_id')
      .where(
        'draft_id',
        'in',
        all.map((d) => d.id),
      )
      .execute();
    expect(publications).toHaveLength(w + n + so);
    const operations = await t.db
      .selectFrom('operations')
      .select(['status', sql<string>`input->>'draftId'`.as('draftId')])
      .where('kind', '=', 'scheduling.publish_schedule')
      .where(
        sql<string>`input->>'draftId'`,
        'in',
        all.map((d) => d.id),
      )
      .execute();
    expect(operations).toHaveLength(all.length);
    expect(operations.filter((o) => o.status === 'succeeded')).toHaveLength(w + n + so);
    expect(operations.filter((o) => o.status === 'failed')).toHaveLength(failures.length);
    for (const [index, draft] of all.entries()) {
      const after = await drafts.get(scheduler, draft.id);
      expect(after.status).toBe(results[index]?.ok ? 'published' : 'failed');
    }
    // The database holds no two active reservations of one conflict unit that overlap.
    const overlapping = await sql<{ count: string }>`
      select count(*)::text as count
      from reservation_units a
      join reservation_units b
        on a.organization_id = b.organization_id
       and a.conflict_unit_id = b.conflict_unit_id
       and a.id < b.id
       and a.occupied && b.occupied
      where a.status = 'active' and b.status = 'active'
        and a.conflict_unit_id in (${sql.join(Object.values(pitch.units))})
    `.execute(t.db);
    expect(overlapping.rows[0]?.count).toBe('0');
  });

  it('SPK-SCHED-004: required rest between a team commitments holds under overlapping bookings', async () => {
    const p1 = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Rest pitch 1',
    });
    const p2 = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Rest pitch 2',
    });
    const team = newId();
    const reached = afterDetect.arm();
    const first = settle(
      book(p1.resourceId, '2026-11-05', '14:00', '15:00', {
        commitments: [teamCommitment(team)],
      }),
    );
    await reached;
    const second = settle(
      book(p2.resourceId, '2026-11-05', '15:30', '16:30', {
        commitments: [teamCommitment(team, 'away_team')],
      }),
    );
    await overlap();
    afterDetect.open();
    const results = [await first, await second];
    expect(results.map(codeOf).sort()).toEqual(['OK', 'RESOURCE_CONFLICT']);
    const refused = results.find((r) => !r.ok) as { ok: false; error: unknown };
    expect(conflictCodes(refused)).toContain('insufficient_rest');
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select('event_id')
      .where('party_id', '=', team)
      .where('status', '=', 'active')
      .execute();
    expect(commitments).toHaveLength(1);
  });
});
