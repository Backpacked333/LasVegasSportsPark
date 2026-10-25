import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import { createQualificationFixture } from '../testing/workforce-fixtures';
import {
  competitionWorld,
  drainOutbox,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

interface ReadinessIssue {
  code: string;
  severity: string;
  message: string;
  source: { type: string; id: string };
}

/**
 * Readiness is derived from the authoritative records at read time (SPK-READY-002/004,
 * SPK-STAFF-001): an accepted official counts only while they hold the requirement's
 * qualifications, verified and valid at the game's current start. A lapse after acceptance (a
 * revocation, a requirement edited to add a qualification, a reschedule past the validity) blocks
 * the check and is raised for an operator; nothing is withdrawn automatically (POL-033 pending).
 */
describe('required officials stay qualified after acceptance (SPK-READY-004, SPK-STAFF-001)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
  });
  afterAll(async () => {
    await t.close();
  });

  async function readiness(fixtureId: string) {
    const res = await t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(lm.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      check: (res.body.checks as Array<{ name: string; status: string }>).find(
        (c) => c.name === 'workforce.required_officials',
      ),
      issues: (res.body.issues as ReadinessIssue[]).filter(
        (i) => i.source?.type === 'assignment_requirement',
      ),
    };
  }

  async function requirement(fixtureId: string, qualifications: string[]) {
    const req = await post(t, '/v1/assignment-requirements', lm, {
      targetType: 'fixture',
      targetId: fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
      requiredQualifications: qualifications,
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    return req.body as { id: string; revision: number };
  }

  async function acceptedReferee(fixtureId: string, official: Actor): Promise<string> {
    const offered = await post(t, '/v1/assignments', lm, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role: 'referee',
      offer: true,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const accepted = await post(
      t,
      `/v1/assignments/${offered.body.assignment.id}/accept`,
      official,
      {},
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return offered.body.assignment.id as string;
  }

  const unqualifiedExceptions = (assignmentId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'owner_queue', 'severity'])
      .where('category', '=', 'workforce.unqualified_assignment')
      .where('affected_id', '=', assignmentId)
      .execute();

  it('SPK-READY-004 / SPK-STAFF-001: a qualification revoked after acceptance blocks the officials check and is raised for the league manager', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-10' });
    const req = await requirement(game.fixtureId, ['referee_grade_7']);
    const qualificationId = await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
    });
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const revoked = await post(t, `/v1/qualifications/${qualificationId}/revoke`, lm, {
      reason: 'Licence suspended',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    await drainOutbox(t);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    const issue = after.issues.find((i) => i.code === 'required_official_unqualified');
    expect(issue).toMatchObject({
      severity: 'blocking',
      source: { type: 'assignment_requirement', id: req.id },
    });
    // the message reaches team members: it names neither the person nor their record's status
    expect(issue?.message).not.toContain(official.personId);
    expect(issue?.message).not.toMatch(/revoked|expired|unverified/);
    // the assignment fact stays; an operator decides (POL-033 pending)
    const row = await t.http.get(`/v1/assignments/${assignment}`).set(lm.header);
    expect(row.body.status).toBe('accepted');
    expect(await unqualifiedExceptions(assignment)).toEqual([
      { status: 'open', owner_queue: 'league_manager', severity: 'high' },
    ]);
  });

  it('SPK-READY-004: a requirement edited to add a qualification the accepted official lacks blocks the check', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-11' });
    const req = await requirement(game.fixtureId, []);
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const patched = await t.http
      .patch(`/v1/assignment-requirements/${req.id}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ requiredQualifications: ['referee_grade_7'], expectedRevision: req.revision });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    expect(after.issues.map((i) => i.code)).toContain('required_official_unqualified');
    expect(await unqualifiedExceptions(assignment)).toHaveLength(1);
  });

  it('SPK-READY-004: a reschedule past the qualification’s validity blocks the check', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-12' });
    await requirement(game.fixtureId, ['referee_grade_7']);
    await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
      validTo: new Date(at('2027-02-13', '00:00')),
    });
    await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const fixture = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(lm.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${game.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [world.pitch.pitchId],
          scheduledStart: at('2027-02-20', '18:00'),
          scheduledEnd: at('2027-02-20', '19:00'),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    expect(after.issues.map((i) => i.code)).toContain('required_official_unqualified');
  });

  it('SPK-READY-004: a qualified acceptance keeps the check ready and raises nothing', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-14' });
    await requirement(game.fixtureId, ['referee_grade_7']);
    await createQualificationFixture(t, { personId: official.personId, kind: 'referee_grade_7' });
    // a second, still valid qualification of the same kind keeps them qualified after a revocation
    const spare = await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
    });
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect(
      (await post(t, `/v1/qualifications/${spare}/revoke`, lm, { reason: 'Duplicate record' }))
        .status,
    ).toBe(200);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('ready');
    expect(await unqualifiedExceptions(assignment)).toEqual([]);
  });
});
