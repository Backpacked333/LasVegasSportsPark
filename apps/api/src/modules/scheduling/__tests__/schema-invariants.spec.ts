import { newId } from '@sportspark/contracts';
import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  seedOrganization,
  tstzrange,
  type Db,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  seedPitchWithHalves,
  seedResource,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

/**
 * Integrity invariants proven at the database (§4.7 invariant 4, CLAUDE.md "Integrity that
 * matters is enforced in the database"): rows are inserted through Kysely, bypassing the services.
 */
describe('scheduling schema invariants (migration 0300)', () => {
  let t: TestApp;
  let db: Db;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule] });
    db = t.db;
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch A',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function insertEvent(
    start: string,
    end: string,
    resourceIds: string[],
    extra: Record<string, unknown> = {},
  ) {
    const id = newId();
    await db
      .insertInto('events')
      .values({
        id,
        organization_id: org,
        facility_id: facility,
        kind: 'game',
        title: `event ${id.slice(0, 6)}`,
        format: null,
        series_id: null,
        occurrence_index: null,
        scheduled_start: start,
        scheduled_end: end,
        timezone: 'America/Los_Angeles',
        status: 'published',
        published_revision: 1,
        resource_ids: resourceIds,
        source_type: null,
        source_id: null,
        canceled_at: null,
        cancel_reason: null,
        ...extra,
      })
      .execute();
    return id;
  }

  /** Mirrors what the service writes: one reservation per resource, one unit row per conflict unit. */
  async function reserve(
    eventId: string,
    resourceId: string,
    unitIds: string[],
    occupiedStart: string,
    occupiedEnd: string,
  ) {
    const reservationId = newId();
    await db
      .insertInto('reservations')
      .values({
        id: reservationId,
        organization_id: org,
        facility_id: facility,
        event_id: eventId,
        resource_id: resourceId,
        occupied: tstzrange(occupiedStart, occupiedEnd),
        released_at: null,
      })
      .execute();
    for (const unitId of unitIds) {
      await db
        .insertInto('reservation_units')
        .values({
          id: newId(),
          organization_id: org,
          reservation_id: reservationId,
          event_id: eventId,
          conflict_unit_id: unitId,
          occupied: tstzrange(occupiedStart, occupiedEnd),
        })
        .execute();
    }
    return reservationId;
  }

  it('SPK-SCHED-002: a whole-pitch reservation conflicts with any overlapping half-pitch reservation', async () => {
    const whole = await insertEvent(at('2026-11-07', '18:00'), at('2026-11-07', '19:00'), [
      pitch.pitchId,
    ]);
    await reserve(
      whole,
      pitch.pitchId,
      [pitch.units.north, pitch.units.south],
      at('2026-11-07', '18:00'),
      at('2026-11-07', '19:10'),
    );
    const half = await insertEvent(at('2026-11-07', '19:00'), at('2026-11-07', '20:00'), [
      pitch.northHalfId,
    ]);
    await expect(
      reserve(
        half,
        pitch.northHalfId,
        [pitch.units.north],
        at('2026-11-07', '19:00'),
        at('2026-11-07', '20:00'),
      ),
    ).rejects.toSatisfy(isExclusionViolation);
    // the reverse order fails too: a whole pitch cannot take a unit a half already holds
    const otherHalf = await insertEvent(at('2026-11-08', '18:00'), at('2026-11-08', '19:00'), [
      pitch.southHalfId,
    ]);
    await reserve(
      otherHalf,
      pitch.southHalfId,
      [pitch.units.south],
      at('2026-11-08', '18:00'),
      at('2026-11-08', '19:00'),
    );
    const whole2 = await insertEvent(at('2026-11-08', '18:30'), at('2026-11-08', '19:30'), [
      pitch.pitchId,
    ]);
    await expect(
      reserve(
        whole2,
        pitch.pitchId,
        [pitch.units.north, pitch.units.south],
        at('2026-11-08', '18:30'),
        at('2026-11-08', '19:30'),
      ),
    ).rejects.toSatisfy(isExclusionViolation);
  });

  it('SPK-SCHED-002: two halves of the same pitch may be reserved simultaneously', async () => {
    const north = await insertEvent(at('2026-11-09', '18:00'), at('2026-11-09', '19:00'), [
      pitch.northHalfId,
    ]);
    const south = await insertEvent(at('2026-11-09', '18:00'), at('2026-11-09', '19:00'), [
      pitch.southHalfId,
    ]);
    await reserve(
      north,
      pitch.northHalfId,
      [pitch.units.north],
      at('2026-11-09', '18:00'),
      at('2026-11-09', '19:10'),
    );
    await reserve(
      south,
      pitch.southHalfId,
      [pitch.units.south],
      at('2026-11-09', '18:00'),
      at('2026-11-09', '19:10'),
    );
    const held = await db
      .selectFrom('reservation_units')
      .select('event_id')
      .where('event_id', 'in', [north, south])
      .where('status', '=', 'active')
      .execute();
    expect(held).toHaveLength(2);
  });

  it('SPK-SCHED-003: buffers make 19:00–20:00 conflict with a game ending 19:00 that has a ten-minute cleanup', async () => {
    const room = await seedResource(db, {
      organizationId: org,
      facilityId: facility,
      name: 'Court 1',
      kind: 'room',
    });
    const first = await insertEvent(
      at('2026-11-10', '18:00'),
      at('2026-11-10', '19:00'),
      [room.resourceId],
      { cleanup_minutes: 10 },
    );
    // occupied = scheduled + cleanup
    await reserve(
      first,
      room.resourceId,
      [room.unitId],
      at('2026-11-10', '18:00'),
      at('2026-11-10', '19:10'),
    );
    const next = await insertEvent(at('2026-11-10', '19:00'), at('2026-11-10', '20:00'), [
      room.resourceId,
    ]);
    await expect(
      reserve(
        next,
        room.resourceId,
        [room.unitId],
        at('2026-11-10', '19:00'),
        at('2026-11-10', '20:00'),
      ),
    ).rejects.toSatisfy(isExclusionViolation);
    // 19:10 is the first free instant (half-open ranges touch without overlapping)
    await reserve(
      next,
      room.resourceId,
      [room.unitId],
      at('2026-11-10', '19:10'),
      at('2026-11-10', '20:00'),
    );
  });

  it('released reservations free the units', async () => {
    const room = await seedResource(db, {
      organizationId: org,
      facilityId: facility,
      name: 'Court 2',
      kind: 'room',
    });
    const first = await insertEvent(at('2026-11-11', '18:00'), at('2026-11-11', '19:00'), [
      room.resourceId,
    ]);
    const reservationId = await reserve(
      first,
      room.resourceId,
      [room.unitId],
      at('2026-11-11', '18:00'),
      at('2026-11-11', '19:00'),
    );
    const second = await insertEvent(at('2026-11-11', '18:30'), at('2026-11-11', '19:30'), [
      room.resourceId,
    ]);
    await expect(
      reserve(
        second,
        room.resourceId,
        [room.unitId],
        at('2026-11-11', '18:30'),
        at('2026-11-11', '19:30'),
      ),
    ).rejects.toSatisfy(isExclusionViolation);
    await db
      .updateTable('reservation_units')
      .set({ status: 'released' })
      .where('reservation_id', '=', reservationId)
      .execute();
    await db
      .updateTable('reservations')
      .set({ status: 'released', released_at: new Date() })
      .where('id', '=', reservationId)
      .execute();
    await reserve(
      second,
      room.resourceId,
      [room.unitId],
      at('2026-11-11', '18:30'),
      at('2026-11-11', '19:30'),
    );
  });

  it('SPK-SCHED-004: team and official commitments cannot overlap, and released ones do not count', async () => {
    const teamId = newId();
    const officialId = newId();
    const a = await insertEvent(at('2026-11-12', '18:00'), at('2026-11-12', '19:00'), [
      pitch.northHalfId,
    ]);
    const b = await insertEvent(at('2026-11-12', '18:30'), at('2026-11-12', '19:30'), [
      pitch.southHalfId,
    ]);
    const commit = (
      eventId: string,
      partyType: 'team' | 'person',
      partyId: string,
      start: string,
      end: string,
    ) =>
      db
        .insertInto('event_commitments')
        .values({
          id: newId(),
          organization_id: org,
          event_id: eventId,
          party_type: partyType,
          party_id: partyId,
          role: partyType === 'team' ? 'home_team' : 'official',
          occupied: tstzrange(start, end),
        })
        .execute();
    await commit(a, 'team', teamId, at('2026-11-12', '18:00'), at('2026-11-12', '19:00'));
    await expect(
      commit(b, 'team', teamId, at('2026-11-12', '18:30'), at('2026-11-12', '19:30')),
    ).rejects.toSatisfy(isExclusionViolation);
    await commit(a, 'person', officialId, at('2026-11-12', '18:00'), at('2026-11-12', '19:00'));
    await expect(
      commit(b, 'person', officialId, at('2026-11-12', '18:30'), at('2026-11-12', '19:30')),
    ).rejects.toSatisfy(isExclusionViolation);
    // the same id as a different party type is a different party (an equipment id never collides with a person id)
    await commit(b, 'team', officialId, at('2026-11-12', '18:30'), at('2026-11-12', '19:30'));
    await db
      .updateTable('event_commitments')
      .set({ status: 'released' })
      .where('event_id', '=', a)
      .execute();
    await commit(b, 'person', officialId, at('2026-11-12', '18:30'), at('2026-11-12', '19:30'));
  });

  it('§4.3: references cannot cross organizations (composite foreign keys)', async () => {
    const other = await seedOrganization(db);
    await expect(
      db
        .insertInto('resources')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: other.facilityId,
          kind: 'pitch',
          name: 'Foreign pitch',
          parent_resource_id: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      db
        .insertInto('resource_conflict_units')
        .values({
          organization_id: other.organizationId,
          resource_id: pitch.pitchId,
          conflict_unit_id: pitch.units.north,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      db
        .insertInto('schedule_drafts')
        .values({
          id: newId(),
          organization_id: other.organizationId,
          facility_id: facility,
          name: 'cross-org draft',
          base_revision: json({ capturedAt: new Date().toISOString(), eventRevisions: {} }),
          author: json({ kind: 'staff' }),
          validation_results: null,
          validated_at: null,
          published_at: null,
          publication_group_id: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('§4.3: a row of one facility cannot name a resource or an event of another facility (0301)', async () => {
    const otherFacility = newId();
    await db
      .insertInto('facilities')
      .values({
        id: otherFacility,
        organization_id: org,
        slug: `other-${otherFacility.slice(0, 8)}`,
        name: 'Other facility',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    const there = await seedResource(db, {
      organizationId: org,
      facilityId: otherFacility,
      name: 'Pitch over there',
    });
    // a subdivision of another facility's pitch
    await expect(
      db
        .insertInto('resources')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          kind: 'subdivision',
          name: 'Borrowed half',
          parent_resource_id: there.resourceId,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // a closure of this facility over the other facility's pitch
    await expect(
      db
        .insertInto('closures')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: there.resourceId,
          during: tstzrange(at('2026-11-20', '08:00'), at('2026-11-20', '20:00')),
          reason: 'cross-facility',
          source: 'manual',
          created_by: json({}),
          impact: null,
          resolution: null,
          applied_at: null,
          lifted_at: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // operating hours of this facility for the other facility's pitch
    await expect(
      db
        .insertInto('operating_hours')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: there.resourceId,
          weekday: 1,
          opens_at: '08:00',
          closes_at: '20:00',
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // a reservation joining this facility's event to the other facility's pitch, whichever
    // facility the reservation claims
    const eventId = await insertEvent(at('2026-11-20', '10:00'), at('2026-11-20', '11:00'), [
      there.resourceId,
    ]);
    for (const claimed of [facility, otherFacility]) {
      await expect(
        db
          .insertInto('reservations')
          .values({
            id: newId(),
            organization_id: org,
            facility_id: claimed,
            event_id: eventId,
            resource_id: there.resourceId,
            occupied: tstzrange(at('2026-11-20', '10:00'), at('2026-11-20', '11:00')),
            released_at: null,
          })
          .execute(),
      ).rejects.toSatisfy(isForeignKeyViolation);
    }
  });

  it('check constraints list exactly the lifecycle states and structural rules', async () => {
    await expect(
      insertEvent(at('2026-11-13', '18:00'), at('2026-11-13', '19:00'), [pitch.pitchId], {
        status: 'scheduled',
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertEvent(at('2026-11-13', '18:00'), at('2026-11-13', '19:00'), [pitch.pitchId], {
        status: 'published',
        published_revision: null,
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertEvent(at('2026-11-13', '19:00'), at('2026-11-13', '18:00'), [pitch.pitchId]),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('resources')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          kind: 'subdivision',
          name: 'Orphan half',
          parent_resource_id: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('closures')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: null,
          during: tstzrange(at('2026-11-13', '18:00'), at('2026-11-13', '19:00')),
          reason: 'x',
          source: 'manual',
          status: 'open' as never,
          created_by: json({}),
          impact: null,
          resolution: null,
          applied_at: null,
          lifted_at: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('schedule_drafts')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          name: 'bad status',
          status: 'open' as never,
          base_revision: json({ capturedAt: new Date().toISOString(), eventRevisions: {} }),
          author: json({ kind: 'staff' }),
          validation_results: null,
          validated_at: null,
          published_at: null,
          publication_group_id: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-SCHED-007: a series never materializes the same occurrence twice', async () => {
    const seriesId = newId();
    await db
      .insertInto('event_series')
      .values({
        id: seriesId,
        organization_id: org,
        facility_id: facility,
        kind: 'practice',
        title: 'Tuesday practice',
        timezone: 'America/Los_Angeles',
        recurrence: json({ frequency: 'weekly', interval: 1, startDate: '2026-11-03', count: 2 }),
        local_start_time: '18:00',
        duration_minutes: 60,
        resource_ids: [pitch.northHalfId],
        source_type: null,
        source_id: null,
      })
      .execute();
    await insertEvent(at('2026-11-03', '18:00'), at('2026-11-03', '19:00'), [pitch.northHalfId], {
      series_id: seriesId,
      occurrence_index: 0,
    });
    await expect(
      insertEvent(at('2026-11-10', '18:00'), at('2026-11-10', '19:00'), [pitch.northHalfId], {
        series_id: seriesId,
        occurrence_index: 0,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      insertEvent(at('2026-11-10', '18:00'), at('2026-11-10', '19:00'), [pitch.northHalfId], {
        series_id: seriesId,
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('§4.7 invariant 9: publications are append-only', async () => {
    const draftId = newId();
    await db
      .insertInto('schedule_drafts')
      .values({
        id: draftId,
        organization_id: org,
        facility_id: facility,
        name: 'published draft',
        status: 'published',
        base_revision: json({ capturedAt: new Date().toISOString(), eventRevisions: {} }),
        author: json({ kind: 'staff' }),
        validation_results: null,
        validated_at: null,
        published_at: new Date(),
        publication_group_id: null,
      })
      .execute();
    const id = newId();
    await db
      .insertInto('publications')
      .values({
        id,
        organization_id: org,
        facility_id: facility,
        draft_id: draftId,
        actor: json({ kind: 'staff' }),
        committed_at: new Date(),
        operation_id: null,
      })
      .execute();
    await expect(
      db
        .updateTable('publications')
        .set({ event_ids: [newId()] })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('publications').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
