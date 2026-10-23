import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, customerPrincipal, staffPrincipal, type TestApp } from '../../../testing';
import { EVENT_SCHEDULING_PORT, type EventSchedulingPort } from '../ports';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  createScheduledEvent,
  personCommitment,
  seedOperatingHours,
  seedPitchWithHalves,
  seedResource,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

describe('EventSchedulingPort: direct scheduling for owning records (SPK-SCHED-002/003/004)', () => {
  let t: TestApp;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let scheduler: Principal;
  let leagueManager: Principal;

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    scheduler = staffPrincipal(org, ['scheduler']);
    leagueManager = staffPrincipal(org, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('is exported under the port token and bound to the same service instance', () => {
    const port = t.app.get<EventSchedulingPort>(EVENT_SCHEDULING_PORT);
    expect(port).toBe(events);
  });

  it('creates a published event with reservations on every conflict unit, buffers from the resources, and a change notice', async () => {
    const teamA = newId();
    const teamB = newId();
    const event = await events.createEvent(leagueManager, {
      facilityId: facility,
      kind: 'game',
      title: 'U12 A vs B',
      format: '11v11',
      scheduledStart: at('2026-10-24', '18:00'),
      scheduledEnd: at('2026-10-24', '19:00'),
      resourceIds: [pitch.pitchId],
      commitments: [teamCommitment(teamA, 'home_team'), teamCommitment(teamB, 'away_team')],
      sourceType: 'fixture',
      sourceId: newId(),
    });
    expect(event).toMatchObject({
      status: 'published',
      publishedRevision: 1,
      revision: 1,
      timezone: 'America/Los_Angeles',
      setupMinutes: 0,
      cleanupMinutes: 10,
      resourceIds: [pitch.pitchId],
      dstResolution: 'exact',
    });
    const units = await t.db
      .selectFrom('reservation_units')
      .select(['conflict_unit_id', 'status'])
      .where('event_id', '=', event.id)
      .execute();
    expect(units.map((u) => u.conflict_unit_id).sort()).toEqual(
      [pitch.units.north, pitch.units.south].sort(),
    );
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select(['party_id'])
      .where('event_id', '=', event.id)
      .execute();
    expect(commitments.map((c) => c.party_id).sort()).toEqual([teamA, teamB].sort());
    const notice = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('aggregate_id', '=', event.id)
      .where('event_type', '=', 'scheduling.event_changed')
      .executeTakeFirstOrThrow();
    expect(notice.payload).toMatchObject({
      change: 'created',
      before: null,
      after: {
        title: 'U12 A vs B',
        scheduledStart: at('2026-10-24', '18:00'),
        resources: [{ id: pitch.pitchId, name: 'Pitch 1' }],
      },
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', event.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['scheduling.event_created']);
  });

  it('SPK-SCHED-003: the ten-minute cleanup of the 18:00–19:00 game makes 19:00 unavailable on either half and names the event', async () => {
    const existing = await events.listEvents(scheduler, {
      facilityId: facility,
      start: at('2026-10-24', '00:00'),
      end: at('2026-10-25', '00:00'),
      limit: 10,
    });
    const game = existing.items.find((e) => e.title === 'U12 A vs B');
    expect(game).toBeDefined();
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-10-24', '19:00'),
        end: at('2026-10-24', '20:00'),
        title: '7v7 north',
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflictingEventIds: [game!.id],
        conflicts: [
          expect.objectContaining({ code: 'physical_overlap', conflictUnitId: pitch.units.north }),
        ],
      },
    });
    // nothing was written for the rejected event
    const rows = await t.db
      .selectFrom('events')
      .select('id')
      .where('title', '=', '7v7 north')
      .execute();
    expect(rows).toEqual([]);
    // 19:10 is fine, and both halves can run simultaneously
    const north = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-10-24', '19:10'),
      end: at('2026-10-24', '20:00'),
      title: '7v7 north',
    });
    const south = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-10-24', '19:10'),
      end: at('2026-10-24', '20:00'),
      title: '7v7 south',
    });
    expect(north.status).toBe('published');
    expect(south.status).toBe('published');
    // and the whole pitch is now blocked by both halves
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-10-24', '19:30'),
        end: at('2026-10-24', '20:30'),
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { conflictingEventIds: expect.arrayContaining([north.id, south.id]) },
    });
  });

  it('SPK-SCHED-004: a team, an official or equipment cannot be committed to overlapping events, and required rest applies', async () => {
    const team = newId();
    const official = newId();
    const first = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-10-25', '10:00'),
      end: at('2026-10-25', '11:00'),
      commitments: [teamCommitment(team), personCommitment(official)],
    });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-10-25', '10:30'),
        end: at('2026-10-25', '11:30'),
        commitments: [teamCommitment(team, 'away_team')],
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [
          expect.objectContaining({ code: 'party_overlap', conflictingEventIds: [first.id] }),
        ],
      },
    });
    // 11:30 is only 30 minutes after the first game: the default 60-minute rest is not met
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-10-25', '11:30'),
        end: at('2026-10-25', '12:30'),
        commitments: [personCommitment(official)],
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [
          expect.objectContaining({ code: 'insufficient_rest', conflictingEventIds: [first.id] }),
        ],
      },
    });
    // 12:00 satisfies the rest
    const rested = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-10-25', '12:00'),
      end: at('2026-10-25', '13:00'),
      commitments: [personCommitment(official), teamCommitment(team)],
    });
    expect(rested.status).toBe('published');
  });

  it('SPK-SCHED-002: compatible formats and configured arrangements are enforced', async () => {
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-10-26', '10:00'),
        end: at('2026-10-26', '11:00'),
        format: '11v11',
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [
          expect.objectContaining({ code: 'incompatible_format', resourceId: pitch.northHalfId }),
        ],
      },
    });
    // a second pitch whose halves are not permitted to run together (no 'two halves' configuration)
    const pitch2 = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 2',
    });
    await t.db
      .deleteFrom('resource_configurations')
      .where('id', '=', pitch2.twoHalvesConfigurationId)
      .execute();
    const north = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch2.northHalfId],
      start: at('2026-10-26', '10:00'),
      end: at('2026-10-26', '11:00'),
    });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch2.southHalfId],
        start: at('2026-10-26', '10:00'),
        end: at('2026-10-26', '11:00'),
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [
          expect.objectContaining({
            code: 'configuration_not_permitted',
            conflictingEventIds: [north.id],
          }),
        ],
      },
    });
  });

  it('SPK-SCHED-001: operating hours bound events; resource windows override facility windows', async () => {
    const court = await seedResource(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Court',
      kind: 'room',
    });
    await seedOperatingHours(t.db, {
      organizationId: org,
      facilityId: facility,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    await seedOperatingHours(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: court.resourceId,
      opensAt: '09:00',
      closesAt: '12:00',
    });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [court.resourceId],
        start: at('2026-10-27', '11:30'),
        end: at('2026-10-27', '12:30'),
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [
          expect.objectContaining({
            code: 'outside_operating_hours',
            resourceId: court.resourceId,
          }),
        ],
      },
    });
    const ok = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [court.resourceId],
      start: at('2026-10-27', '09:00'),
      end: at('2026-10-27', '10:00'),
    });
    expect(ok.status).toBe('published');
    // the facility window applies to resources without their own hours
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-10-27', '06:00'),
        end: at('2026-10-27', '07:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await t.db.deleteFrom('operating_hours').where('organization_id', '=', org).execute();
  });

  it('moves and cancels an event with revision checks, releasing the old holds and carrying old and new details', async () => {
    const event = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-10-28', '18:00'),
      end: at('2026-10-28', '19:00'),
      title: 'Movable',
    });
    await expect(
      events.moveEvent(scheduler, event.id, {
        scheduledStart: at('2026-10-28', '19:00'),
        scheduledEnd: at('2026-10-28', '20:00'),
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    // moving onto itself (its own old occupancy) is not a conflict
    const moved = await events.moveEvent(scheduler, event.id, {
      scheduledStart: at('2026-10-28', '18:30'),
      scheduledEnd: at('2026-10-28', '19:30'),
      resourceIds: [pitch.pitchId],
      expectedRevision: 1,
      reason: 'league request',
    });
    expect(moved).toMatchObject({
      revision: 2,
      publishedRevision: 2,
      resourceIds: [pitch.pitchId],
    });
    const active = await t.db
      .selectFrom('reservation_units')
      .select(['conflict_unit_id', 'status'])
      .where('event_id', '=', event.id)
      .execute();
    expect(
      active
        .filter((u) => u.status === 'active')
        .map((u) => u.conflict_unit_id)
        .sort(),
    ).toEqual([pitch.units.north, pitch.units.south].sort());
    expect(active.filter((u) => u.status === 'released')).toHaveLength(1);
    const notices = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', event.id)
      .where(sql`payload->>'change'`, '=', 'moved')
      .execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      change: 'moved',
      before: { scheduledStart: at('2026-10-28', '18:00'), resources: [{ id: pitch.northHalfId }] },
      after: { scheduledStart: at('2026-10-28', '18:30'), resources: [{ id: pitch.pitchId }] },
      reason: 'league request',
    });

    const canceled = await events.cancelEvent(scheduler, event.id, {
      expectedRevision: 2,
      reason: 'rained out',
    });
    expect(canceled).toMatchObject({ status: 'canceled', cancelReason: 'rained out', revision: 3 });
    const stillActive = await t.db
      .selectFrom('reservation_units')
      .select('id')
      .where('event_id', '=', event.id)
      .where('status', '=', 'active')
      .execute();
    expect(stillActive).toEqual([]);
    await expect(
      events.cancelEvent(scheduler, event.id, { reason: 'again' }),
    ).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(
      events.moveEvent(scheduler, event.id, {
        scheduledStart: at('2026-10-28', '18:00'),
        scheduledEnd: at('2026-10-28', '19:00'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // the space is free again
    const again = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-10-28', '18:30'),
      end: at('2026-10-28', '19:30'),
    });
    expect(again.status).toBe('published');
  });

  it('SPK-FIX-005: draft events hold no space until published', async () => {
    const draft = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.pitchId],
      start: at('2026-10-29', '18:00'),
      end: at('2026-10-29', '19:00'),
      status: 'draft',
    });
    expect(draft).toMatchObject({ status: 'draft', publishedRevision: null });
    const holds = await t.db
      .selectFrom('reservations')
      .select('id')
      .where('event_id', '=', draft.id)
      .execute();
    expect(holds).toEqual([]);
    const notices = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', draft.id)
      .execute();
    expect(notices).toEqual([]);
  });

  it('authorization: staff role matrix, cross-organization and customers without authority see not-found', async () => {
    const event = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-10-30', '18:00'),
      end: at('2026-10-30', '19:00'),
      commitments: [personCommitment(newId(), 'participant')],
    });
    const frontDesk = staffPrincipal(org, ['front_desk']);
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-10-31', '18:00'),
        end: at('2026-10-31', '19:00'),
        principal: frontDesk,
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const otherFacilityScheduler = staffPrincipal(org, ['scheduler'], { facilityIds: [newId()] });
    await expect(
      events.cancelEvent(otherFacilityScheduler, event.id, { reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    // staff of another organization: the record does not exist for them
    const otherOrg = staffPrincipal(newId(), ['system_administrator']);
    await expect(events.getEvent(otherOrg, event.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(events.cancelEvent(otherOrg, event.id, { reason: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // front desk may read
    expect((await events.getEvent(frontDesk, event.id)).id).toBe(event.id);
    // the committed participant may read their own event; a stranger gets not-found, not access-denied (§4.10)
    const participantId = event.commitments[0]!.partyId;
    const participant = customerPrincipal(org, { personId: participantId });
    expect((await events.getEvent(participant, event.id)).id).toBe(event.id);
    const stranger = customerPrincipal(org);
    await expect(events.getEvent(stranger, event.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const res = await t.http.get(`/v1/events/${event.id}`).set(await t.authHeader(stranger));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    const sys = systemPrincipal(org);
    expect((await events.getEvent(sys, event.id)).id).toBe(event.id);
  });

  it('AvailabilityPort and ReservationQueryPort reflect holds, buffers and closures', async () => {
    const court = await seedResource(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Court A',
      kind: 'room',
      defaultCleanupMinutes: 15,
    });
    const booked = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [court.resourceId],
      start: at('2026-11-02', '10:00'),
      end: at('2026-11-02', '11:00'),
      kind: 'rental',
    });
    const slots = await events.findAvailableSlots(scheduler, {
      resourceId: court.resourceId,
      interval: { start: at('2026-11-02', '08:00'), end: at('2026-11-02', '13:00') },
      durationMinutes: 60,
      stepMinutes: 15,
    });
    const starts = slots.map((s) => s.start);
    expect(starts).toContain(at('2026-11-02', '08:00'));
    expect(starts).toContain(at('2026-11-02', '08:45')); // ends 09:45, its 15-minute cleanup touches 10:00 without overlapping
    expect(starts).not.toContain(at('2026-11-02', '09:00')); // its own cleanup would run into the 10:00 booking
    expect(starts).not.toContain(at('2026-11-02', '11:00')); // cleanup of the booking runs to 11:15
    expect(starts).toContain(at('2026-11-02', '11:15'));
    expect(starts).toContain(at('2026-11-02', '12:00'));
    expect(starts).not.toContain(at('2026-11-02', '12:15')); // would end after the window

    const reservations = await events.listReservations(scheduler, {
      resourceId: court.resourceId,
      interval: { start: at('2026-11-02', '00:00'), end: at('2026-11-03', '00:00') },
    });
    expect(reservations).toEqual([
      expect.objectContaining({
        eventId: booked.id,
        resourceId: court.resourceId,
        status: 'active',
        occupied: { start: at('2026-11-02', '10:00'), end: at('2026-11-02', '11:15') },
      }),
    ]);
    const byFacility = await events.listReservations(staffPrincipal(org, ['facilities_operator']), {
      facilityId: facility,
      interval: { start: at('2026-11-02', '00:00'), end: at('2026-11-03', '00:00') },
    });
    expect(byFacility.some((r) => r.eventId === booked.id)).toBe(true);
    const http = await t.http
      .get(`/v1/resources/${court.resourceId}/availability`)
      .query({
        start: at('2026-11-02', '08:00'),
        end: at('2026-11-02', '09:30'),
        durationMinutes: 60,
      })
      .set(await t.authHeader(staffPrincipal(org, ['front_desk'])));
    expect(http.status).toBe(200);
    expect(http.body.slots.map((s: { start: string }) => s.start)).toEqual([
      at('2026-11-02', '08:00'),
      at('2026-11-02', '08:15'),
      at('2026-11-02', '08:30'),
    ]);
  });

  it('lists events by facility window with resource and source filters and cursor pagination', async () => {
    const sourceId = newId();
    for (let i = 0; i < 3; i += 1) {
      await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-12-01', `${10 + i}:00`),
        end: at('2026-12-01', `${10 + i}:45`),
        sourceType: 'season',
        sourceId,
      });
    }
    const page1 = await events.listEvents(scheduler, {
      facilityId: facility,
      start: at('2026-12-01', '00:00'),
      end: at('2026-12-02', '00:00'),
      sourceType: 'season',
      sourceId,
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await events.listEvents(scheduler, {
      facilityId: facility,
      start: at('2026-12-01', '00:00'),
      end: at('2026-12-02', '00:00'),
      sourceType: 'season',
      sourceId,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const byResource = await events.listEvents(scheduler, {
      facilityId: facility,
      start: at('2026-12-01', '00:00'),
      end: at('2026-12-02', '00:00'),
      resourceId: pitch.northHalfId,
      limit: 10,
    });
    expect(byResource.items).toEqual([]);
    const res = await t.http
      .get('/v1/events')
      .query({
        facilityId: facility,
        start: at('2026-12-01', '00:00'),
        end: at('2026-12-02', '00:00'),
        limit: 10,
      })
      .set(await t.authHeader(staffPrincipal(org, ['coach'])));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });
});
