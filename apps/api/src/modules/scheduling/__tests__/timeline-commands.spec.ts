import { newId, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { EventsService } from '../services/events.service';
import { ClosureImpactContributors } from '../services/closure-impact-contributors';
import { SchedulingModule } from '../scheduling.module';
import {
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  seedResource,
  teamCommitment,
  type PitchFixture,
} from '../testing/scheduling-fixtures';

/**
 * Schedule timeline gaps (docs/design/park-ui-redesign.md "Operate"): sport on events (migration
 * 0304), direct move and cancel that keep the publication guarantees (SPK-SCHED-005/006,
 * SPK-COMMS-005), the event detail read (SPK-SCHED-009 contributors), window counts and
 * cross-resource availability (SPK-SCHED-003).
 */
describe('timeline commands and composed reads (SPK-SCHED-003/005/006/009)', () => {
  let t: TestApp;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let court: string;
  let scheduler: Principal;
  let auth: { Authorization: string };
  const staffPerson = newId();
  const participant = newId();

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, { organizationId: org, facilityId: facility });
    court = (
      await seedResource(t.db, {
        organizationId: org,
        facilityId: facility,
        name: 'Court 1',
        kind: 'room',
      })
    ).resourceId;
    await t.db
      .updateTable('resources')
      .set({ compatible_sports: ['basketball'] })
      .where('id', '=', court)
      .execute();
    scheduler = staffPrincipal(org, ['scheduler']);
    auth = await t.authHeader(scheduler);
    // A workforce stand-in: the module that owns staff assignments answers for the event.
    t.app
      .get(ClosureImpactContributors)
      .register('test.staff_and_participants', async (_db, _org, refs) => ({
        staff: refs.map((r) => ({
          assignmentId: newId(),
          personId: staffPerson,
          eventId: r.eventId,
          kind: 'official',
          role: 'referee',
          status: 'accepted',
        })),
        customers: refs.map((r) => ({
          personId: participant,
          eventIds: [r.eventId],
          via: ['enrollment' as const],
        })),
      }));
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;

  describe('sport on events (migration 0304)', () => {
    it('SPK-SCHED-001: an event names its sport from the vocabulary and the event read returns it', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [court],
        start: at('2026-11-02', '18:00'),
        end: at('2026-11-02', '19:00'),
        title: 'Rec G3',
      });
      expect(event.sport).toBeNull();
      const res = await events.createEvent(staffPrincipal(org, ['scheduler']), {
        facilityId: facility,
        kind: 'game',
        title: 'Rec G4',
        sport: 'basketball',
        scheduledStart: at('2026-11-02', '20:00'),
        scheduledEnd: at('2026-11-02', '21:00'),
        resourceIds: [court],
        sourceType: 'fixture',
        sourceId: newId(),
      });
      expect(res.sport).toBe('basketball');
      const read = await t.http.get(`/v1/events/${res.id}`).set(auth);
      expect(read.body.sport).toBe('basketball');
    });

    it('SPK-SCHED-001: a sport outside the vocabulary is refused with unknown_sport', async () => {
      await expect(
        events.createEvent(scheduler, {
          facilityId: facility,
          kind: 'game',
          title: 'Curling',
          sport: 'curling',
          scheduledStart: at('2026-11-03', '18:00'),
          scheduledEnd: at('2026-11-03', '19:00'),
          resourceIds: [pitch.pitchId],
          sourceType: 'fixture',
          sourceId: newId(),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { code: 'unknown_sport' } });
    });

    it('SPK-SCHED-001: a space listing its sports refuses another sport (incompatible_sport)', async () => {
      await expect(
        events.createEvent(scheduler, {
          facilityId: facility,
          kind: 'game',
          title: 'Futsal on the court',
          sport: 'futsal',
          scheduledStart: at('2026-11-04', '18:00'),
          scheduledEnd: at('2026-11-04', '19:00'),
          resourceIds: [court],
          sourceType: 'fixture',
          sourceId: newId(),
        }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_CONFLICT',
        details: { conflicts: [expect.objectContaining({ code: 'incompatible_sport' })] },
      });
    });

    it('migration 0304: the database refuses a sport that is not a slug', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-11-05', '08:00'),
        end: at('2026-11-05', '09:00'),
      });
      await expect(
        t.db
          .updateTable('events')
          .set({ sport: 'Not A Slug' })
          .where('id', '=', event.id)
          .execute(),
      ).rejects.toThrow(/events_sport_slug/);
      await expect(
        t.db
          .updateTable('resources')
          .set({ compatible_sports: ['ok', 'NOT OK'] })
          .where('id', '=', court)
          .execute(),
      ).rejects.toThrow(/resources_compatible_sports_slug/);
    });

    it('SPK-SCHED-007: a series stores its sport and every occurrence carries it', async () => {
      const res = await t.http
        .post('/v1/event-series')
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          facilityId: facility,
          kind: 'session',
          title: 'Hoops Fundamentals',
          sport: 'basketball',
          recurrence: { frequency: 'weekly', byWeekday: [2], startDate: '2026-11-10', count: 2 },
          localStartTime: '16:00',
          durationMinutes: 60,
          resourceIds: [court],
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.sport).toBe('basketball');
      const rows = await t.db
        .selectFrom('events')
        .select('sport')
        .where('series_id', '=', res.body.id)
        .execute();
      expect(rows.map((r) => r.sport)).toEqual(['basketball', 'basketball']);
    });

    it('SPK-SCHED-005: a draft change may set the sport; an unknown sport is a validation issue', async () => {
      const draft = await t.http
        .post('/v1/schedule-drafts')
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          facilityId: facility,
          name: 'sports',
          changes: [
            {
              kind: 'create',
              proposed: {
                kind: 'game',
                title: 'Polo',
                sport: 'polo',
                scheduledStart: at('2026-11-06', '18:00'),
                scheduledEnd: at('2026-11-06', '19:00'),
              },
              resourceIds: [pitch.pitchId],
            },
          ],
        });
      expect(draft.status).toBe(201);
      const validated = await t.http
        .post(`/v1/schedule-drafts/${draft.body.id}/validate`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({});
      expect(validated.body.validationResults.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'unknown_sport' })]),
      );
    });
  });

  describe('direct move and cancel (SPK-SCHED-005/006)', () => {
    it('SPK-SCHED-006: a direct move publishes one single-change group with a notice, an operation and a kept draft', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-09', '18:00'),
        end: at('2026-11-09', '19:00'),
        title: 'Div B',
      });
      const res = await t.http
        .post(`/v1/events/${event.id}/move`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: at('2026-11-09', '20:00'),
          scheduledEnd: at('2026-11-09', '21:00'),
          expectedRevision: event.revision,
          reason: 'Field swap',
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.event).toMatchObject({
        id: event.id,
        scheduledStart: new Date(at('2026-11-09', '20:00')).toISOString(),
        revision: event.revision + 1,
      });
      expect(res.body.publication.eventIds).toEqual([event.id]);
      expect(res.body.publication.summary.changes).toEqual([
        { sequence: 1, kind: 'move', eventId: event.id },
      ]);
      const draft = await t.db
        .selectFrom('schedule_drafts')
        .select(['status', 'publication_group_id'])
        .where('id', '=', res.body.publication.draftId)
        .executeTakeFirstOrThrow();
      expect(draft).toEqual({ status: 'published', publication_group_id: res.body.publication.id });
      const op = await t.db
        .selectFrom('operations')
        .select('status')
        .where('id', '=', res.body.publication.operationId)
        .executeTakeFirstOrThrow();
      expect(op.status).toBe('succeeded');
      const notices = await t.db
        .selectFrom('outbox_events')
        .select(['event_type', 'payload'])
        .where('aggregate_id', '=', event.id)
        .where('event_type', '=', 'scheduling.event_changed')
        .execute();
      expect(notices.map((n) => (n.payload as { change: string }).change)).toEqual([
        'created',
        'moved',
      ]);
    });

    it('SPK-SCHED-006: a conflicting direct move publishes nothing and leaves no draft, with a failed operation', async () => {
      const blocker = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-11-10', '18:00'),
        end: at('2026-11-10', '19:00'),
      });
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.southHalfId],
        start: at('2026-11-10', '20:00'),
        end: at('2026-11-10', '21:00'),
      });
      const drafts = async () =>
        Number(
          (
            await t.db
              .selectFrom('schedule_drafts')
              .select(sql<number>`count(*)::int`.as('n'))
              .executeTakeFirstOrThrow()
          ).n,
        );
      const before = await drafts();
      const res = await t.http
        .post(`/v1/events/${event.id}/move`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: at('2026-11-10', '18:30'),
          scheduledEnd: at('2026-11-10', '19:30'),
          expectedRevision: event.revision,
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RESOURCE_CONFLICT');
      expect(JSON.stringify(res.body.details)).toContain(blocker.id);
      expect(await drafts()).toBe(before);
      const unchanged = await events.getEvent(scheduler, event.id);
      expect(unchanged.revision).toBe(event.revision);
      const failed = await t.db
        .selectFrom('operations')
        .select('status')
        .where('kind', '=', 'scheduling.publish_schedule')
        .where('status', '=', 'failed')
        .execute();
      expect(failed.length).toBeGreaterThan(0);
    });

    it('§4.9: a direct move with a stale revision is STALE_REVISION and changes nothing', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-11', '18:00'),
        end: at('2026-11-11', '19:00'),
      });
      const res = await t.http
        .post(`/v1/events/${event.id}/move`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: at('2026-11-11', '20:00'),
          scheduledEnd: at('2026-11-11', '21:00'),
          expectedRevision: event.revision + 5,
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STALE_REVISION');
    });

    it('SPK-COMMS-005: a direct cancel needs a reason, releases the holds and sends one canceled notice', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-12', '18:00'),
        end: at('2026-11-12', '19:00'),
      });
      const missing = await t.http
        .post(`/v1/events/${event.id}/cancel`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: event.revision });
      expect(missing.status).toBe(400);
      const res = await t.http
        .post(`/v1/events/${event.id}/cancel`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: event.revision, reason: 'Lightning' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.event).toMatchObject({ status: 'canceled', cancelReason: 'Lightning' });
      const holds = await t.db
        .selectFrom('reservations')
        .select('status')
        .where('event_id', '=', event.id)
        .execute();
      expect(holds.every((h) => h.status === 'released')).toBe(true);
    });

    it('SPK-SCHED-006 step 1: a role without publication authority may not change events directly', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-13', '18:00'),
        end: at('2026-11-13', '19:00'),
      });
      const programManager = await t.authHeader(staffPrincipal(org, ['program_manager']));
      const res = await t.http
        .post(`/v1/events/${event.id}/cancel`)
        .set(programManager)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: event.revision, reason: 'no' });
      expect(res.status).toBe(403);
    });
  });

  describe('composed reads', () => {
    it('SPK-SCHED-009: the event detail names teams, staff from the owning module and counts attendees', async () => {
      const team = newId();
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-11-16', '18:00'),
        end: at('2026-11-16', '19:00'),
        commitments: [teamCommitment(team), personCommitment(newId(), 'official')],
      });
      const res = await t.http.get(`/v1/events/${event.id}/detail`).set(auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.event.id).toBe(event.id);
      // competition is not loaded here: the team is listed, its name not answered
      expect(res.body.teams).toEqual([
        { teamEntryId: team, role: 'home_team', teamName: null, rosterSize: null },
      ]);
      expect(res.body.staff).toMatchObject({
        identified: true,
        assignments: [expect.objectContaining({ personId: staffPerson, role: 'referee' })],
      });
      expect(res.body.committedPeople).toEqual([{ role: 'official', count: 1 }]);
      expect(res.body.attendees).toEqual({
        total: 1,
        byVia: { commitment: 0, enrollment: 1, booking: 0, roster: 0 },
      });
      expect(res.body.fixtureId).toBe(event.sourceId);
      expect(res.body.messageAudience).toEqual({
        teamEntryIds: [team],
        subjectPersonIds: [participant],
      });
    });

    it('§4.10: the event detail is staff-only and protected (a coach gets NOT_FOUND)', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-11-17', '18:00'),
        end: at('2026-11-17', '19:00'),
      });
      const coach = await t.authHeader(staffPrincipal(org, ['coach']));
      const res = await t.http.get(`/v1/events/${event.id}/detail`).set(coach);
      expect(res.status).toBe(404);
    });

    it('SPK-SCHED-003: cross-resource availability lists free starts per resource, by kind and sport', async () => {
      const res = await t.http
        .get('/v1/resource-availability')
        .set(auth)
        .query({
          facilityId: facility,
          start: at('2026-11-02', '17:00'),
          end: at('2026-11-02', '22:00'),
          durationMinutes: 60,
          resourceKind: 'room',
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.stepMinutes).toBe(60);
      expect(res.body.resources.map((r: { resourceId: string }) => r.resourceId)).toEqual([court]);
      const starts = res.body.resources[0].slots.map((s: { start: string }) => s.start);
      // the court holds Rec G3 18:00-19:00 and Rec G4 20:00-21:00
      expect(starts).not.toContain(new Date(at('2026-11-02', '18:00')).toISOString());
      expect(starts).toContain(new Date(at('2026-11-02', '17:00')).toISOString());
      const soccer = await t.http
        .get('/v1/resource-availability')
        .set(auth)
        .query({
          facilityId: facility,
          start: at('2026-11-02', '17:00'),
          end: at('2026-11-02', '22:00'),
          durationMinutes: 60,
          sport: 'soccer',
        });
      expect(soccer.body.resources.map((r: { resourceId: string }) => r.resourceId)).not.toContain(
        court,
      );
      const tooLong = await t.http
        .get('/v1/resource-availability')
        .set(auth)
        .query({
          facilityId: facility,
          start: at('2026-11-01', '00:00'),
          end: at('2026-11-20', '00:00'),
          durationMinutes: 60,
        });
      expect(tooLong.status).toBe(400);
    });
  });
});
