import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import {
  competitionWorld,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

interface StaffImpact {
  assignmentId: string;
  personId: string;
  eventId: string;
  kind: string;
  role: string;
  status: string;
}

/**
 * SPK-SCHED-009 (a closure identifies affected games, programs, rentals, staff, customers,
 * financial obligations and messages), SPK-AT-009 (complete impact preview), R3-TRACE-A-06:
 * workforce owns staff assignments and registers the closure impact contributor that names the
 * live assignments (proposed, offered or accepted) on the affected events. Because it always
 * answers, staff is identified: a closure over an unstaffed event reports [] and 0, never null.
 */
describe('closure impact names the staff on the affected events (SPK-SCHED-009, R3-TRACE-A-06)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let scheduler: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    scheduler = await staffMember(t, ['scheduler']);
  });
  afterAll(async () => {
    await t.close();
  });

  const impact = async (date: string) => {
    const res = await t.http
      .get('/v1/closure-impact')
      .query({ facilityId: t.facilityId, start: at(date, '17:00'), end: at(date, '21:00') })
      .set(scheduler.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { staff: StaffImpact[] | null; summary: { staff: number | null } };
  };

  const propose = async (fixtureId: string, personId: string, role: string) => {
    const res = await post(t, '/v1/assignments', world.leagueManager, {
      personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.assignment as { id: string; revision: number };
  };

  it('SPK-SCHED-009: a closure over a staffed fixture lists its live assignments and counts each person once; a withdrawn one is left out', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-02-10' });
    const referee = await staffMember(t, ['official']);
    const assistant = await staffMember(t, ['official']);
    const proposed = await propose(game.fixtureId, referee.personId, 'referee');
    const offered = await post(t, `/v1/assignments/${proposed.id}/offer`, world.leagueManager, {
      expectedRevision: proposed.revision,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    const accepted = await t.http
      .post(`/v1/assignments/${proposed.id}/accept`)
      .set(referee.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: offered.body.assignment.revision });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const dropped = await propose(game.fixtureId, assistant.personId, 'assistant_referee');
    const withdrawn = await post(t, `/v1/assignments/${dropped.id}/withdraw`, world.leagueManager, {
      reason: 'not needed',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);

    const preview = await impact('2027-02-10');
    expect(preview.staff).toEqual([
      {
        assignmentId: proposed.id,
        personId: referee.personId,
        eventId: game.eventId,
        kind: 'official',
        role: 'referee',
        status: 'accepted',
      },
    ]);
    expect(preview.summary.staff).toBe(1);
  });

  it('SPK-SCHED-009: a closure over an unstaffed fixture reports no staff (identified), not "not identified"', async () => {
    await scheduleFixture(t, world, { date: '2027-02-11' });
    const preview = await impact('2027-02-11');
    expect(preview.staff).toEqual([]);
    expect(preview.summary.staff).toBe(0);
  });
});
