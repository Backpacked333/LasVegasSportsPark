import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import {
  authHeaderForPerson,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../modules/identity';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing';

const key = () => `k-${newId()}`;
const DAY = '2027-01-16';

/**
 * SPK-AT-021 (spec §6.1): "Turf maintenance restricts a subdivision — correct booking impact;
 * authorized reopening", over the assembled application. A restriction on the north half closes
 * the north half and the whole pitch (shared conflict units) but not the south half (SPK-FAC-003);
 * the affected bookings are left for resolution and surfaced; no role reopens the half by lifting
 * the scheduling closure directly, and the facilities release reopens it only after the required
 * inspection passed (SPK-FAC-004). Which roles hold the release is pending (DEC-001).
 */
describe('SPK-AT-021: turf maintenance restricts a subdivision (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2027-01-10T20:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  const drain = async () => {
    const dispatcher = t.app.get(OutboxDispatcher);
    for (let i = 0; i < 40; i += 1) if ((await dispatcher.runOnce(200)).claimed === 0) return;
  };

  it('SPK-AT-021 / SPK-FAC-003 / SPK-FAC-004: the restriction blocks the half and the whole pitch, leaves the south half bookable, surfaces affected bookings, and only an inspected facilities release reopens it', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Turf 1',
    });
    const header = async (roles: Parameters<typeof createStaffMemberFixture>[1]['roles']) =>
      authHeaderForPerson(t, (await createStaffMemberFixture(t, { roles })).personId);
    const operator = await header(['facilities_operator']);
    const scheduler = await header(['scheduler']);
    const leagueManager = await header(['league_manager']);
    const admin = await header(['system_administrator']);
    const send = (path: string, auth: { Authorization: string }, body: object) =>
      t.http.post(path).set(auth).set('Idempotency-Key', key()).send(body);
    const series = (resourceId: string, title: string, localStartTime: string) =>
      send('/v1/event-series', scheduler, {
        facilityId: t.facilityId,
        kind: 'session',
        title,
        recurrence: { frequency: 'weekly', interval: 1, startDate: DAY, count: 1 },
        localStartTime,
        durationMinutes: 60,
        resourceIds: [resourceId],
        sourceType: 'offering',
        sourceId: newId(),
      });

    const north = await series(pitch.northHalfId, 'North clinic', '09:00');
    const south = await series(pitch.southHalfId, 'South clinic', '09:00');
    expect([north.status, south.status], JSON.stringify([north.body, south.body])).toEqual([
      201, 201,
    ]);
    const season = await createSeasonFixture(t, { status: 'active' });
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    const captainA = await createPersonFixture(t, { kind: 'adult' });
    const captainB = await createPersonFixture(t, { kind: 'adult' });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainA,
      teamName: 'A',
      divisionId,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainB,
      teamName: 'B',
      divisionId,
    });
    await addRosterMemberFixture(t, { teamEntryId: home.teamEntryId, personId: captainA });
    const fixture = await send('/v1/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(DAY, '12:00'),
        scheduledEnd: at(DAY, '13:00'),
      },
    });
    expect(fixture.status, JSON.stringify(fixture.body)).toBe(201);
    await drain();

    // the turf seam needs repair and an inspection before the half returns to service
    const task = await send('/v1/maintenance-tasks', operator, {
      facilityId: t.facilityId,
      resourceId: pitch.northHalfId,
      issue: 'Turf seam lifting',
      severity: 'high',
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    const assigned = await t.http
      .patch(`/v1/maintenance-tasks/${task.body.id as string}`)
      .set(operator)
      .set('Idempotency-Key', key())
      .send({ requiresInspection: true, expectedRevision: 1 });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const restriction = await send('/v1/maintenance-restrictions', operator, {
      facilityId: t.facilityId,
      resourceId: pitch.northHalfId,
      taskId: task.body.id,
      kind: 'closed',
      interval: { start: at(DAY, '08:00'), end: at(DAY, '20:00') },
      reason: 'Turf seam',
    });
    expect(restriction.status, JSON.stringify(restriction.body)).toBe(201);
    expect(restriction.body.status).toBe('active');
    const closureId = restriction.body.schedulingClosureId as string;
    await drain();

    // booking impact: north half and whole pitch affected, south half not
    const closure = await t.http.get(`/v1/closures/${closureId}`).set(scheduler);
    expect(closure.status).toBe(200);
    const affected = (closure.body.impact.affectedEvents as Array<{ title: string }>)
      .map((e) => e.title)
      .sort();
    expect(affected).toEqual(['A v B', 'North clinic'].sort());
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', 'scheduling.closure_resolution_required')
      .execute();
    expect(exceptions).toEqual([
      { category: 'scheduling.closure_resolution_required', owner_queue: 'scheduler' },
    ]);
    const readiness = await t.http
      .get(`/v1/fixtures/${fixture.body.fixture.id as string}/readiness`)
      .set(leagueManager);
    expect(JSON.stringify(readiness.body)).toContain('field_closed');

    const bookNorth = () => series(pitch.northHalfId, 'Late north booking', '14:00');
    expect((await bookNorth()).body.code).toBe('RESOURCE_CONFLICT');
    expect((await series(pitch.pitchId, 'Late whole pitch', '15:00')).body.code).toBe(
      'RESOURCE_CONFLICT',
    );
    expect((await series(pitch.southHalfId, 'Late south booking', '14:00')).status).toBe(201);

    // no role reopens the half by lifting the scheduling closure directly
    for (const who of [scheduler, admin, operator]) {
      const current = await t.http.get(`/v1/closures/${closureId}`).set(scheduler);
      const lift = await send(`/v1/closures/${closureId}/lift`, who, {
        expectedRevision: current.body.revision,
        reason: 'looks fine',
      });
      expect(lift.status, JSON.stringify(lift.body)).toBe(422);
      expect(lift.body.details).toMatchObject({ code: 'restriction_release_required' });
    }
    expect((await bookNorth()).body.code).toBe('RESOURCE_CONFLICT');

    // authorized reopening: the release needs the passed inspection
    const early = await send(
      `/v1/maintenance-restrictions/${restriction.body.id as string}/release`,
      operator,
      { reason: 'repaired' },
    );
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(early.body.details.code).toBe('inspection_required');
    const inspected = await send(
      `/v1/maintenance-tasks/${task.body.id as string}/inspections`,
      operator,
      { outcome: 'passed' },
    );
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(201);
    const released = await send(
      `/v1/maintenance-restrictions/${restriction.body.id as string}/release`,
      operator,
      { reason: 'repaired and inspected' },
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.status).toBe('released');
    expect((await t.http.get(`/v1/closures/${closureId}`).set(scheduler)).body.status).toBe(
      'lifted',
    );
    expect((await bookNorth()).status).toBe(201);
    await drain();
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('category', '=', 'facilities.closure_lifted_outside_release')
        .execute(),
    ).toEqual([]);
  });
});
