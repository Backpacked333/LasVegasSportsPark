import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FacilityDirectory } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  competitionWorld,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

interface ListedAssignment {
  id: string;
  status: string;
  availableActions: string[];
}

/**
 * WRK-01 (SPK-SCHED-008, SPK-UX-007, SPK-STAFF-001..004, SCR-W-01, SCR-S-32/33): the workspace
 * names the activity's facility and its time zone; the staff list offers only the machine events
 * that are valid from the assignment's state and that the caller's authority performs.
 */
describe('facility on workspace assignments and available actions on staff lists (WRK-01)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let scheduler: Actor;
  let referee: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    scheduler = await staffMember(t, ['scheduler']);
    referee = await staffMember(t, ['official']);
  });
  afterAll(async () => {
    await t.close();
  });

  const propose = async (actor: Actor, fixtureId: string, offer: boolean, role = 'referee') => {
    const res = await post(t, '/v1/assignments', actor, {
      personId: referee.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role,
      offer,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.assignment as { id: string; revision: number };
  };

  it('SPK-SCHED-008 / SPK-UX-007: workspace assignments carry the facility name and time zone', async () => {
    const first = await scheduleFixture(t, world, { date: '2027-01-21' });
    const second = await scheduleFixture(t, world, { date: '2027-01-22' });
    await propose(leagueManager, first.fixtureId, true);
    await propose(leagueManager, second.fixtureId, true);
    const directory = t.app.get(FacilityDirectory);
    const describeSpy = vi.spyOn(directory, 'describe');
    try {
      const res = await t.http
        .get('/v1/me/assignments?from=2027-01-20T00:00:00Z&to=2027-01-23T12:00:00Z')
        .set(referee.header);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items).toHaveLength(2);
      for (const item of res.body.items) {
        expect(item.activity.facility).toEqual({
          id: t.facilityId,
          name: 'Main complex',
          timezone: 'America/Los_Angeles',
        });
        expect(item.activity.facilityId).toBe(t.facilityId);
      }
      // one directory read per response, however many assignments it lists
      expect(describeSpy).toHaveBeenCalledTimes(1);
    } finally {
      describeSpy.mockRestore();
    }
  });

  it('staff assignment lists carry only state- and permission-valid actions (scheduler versus league manager)', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-24' });
    const proposed = await propose(scheduler, game.fixtureId, false, 'referee');
    const offered = await propose(scheduler, game.fixtureId, true, 'assistant_referee');
    const toAccept = await propose(scheduler, game.fixtureId, true, 'fourth_official');
    const accepted = await post(t, `/v1/assignments/${toAccept.id}/accept`, referee, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const listFor = async (
      actor: Actor,
      query = `targetType=fixture&targetId=${game.fixtureId}`,
    ) => {
      const res = await t.http.get(`/v1/assignments?${query}`).set(actor.header);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const items = res.body.items as ListedAssignment[];
      return (id: string) => items.find((i) => i.id === id)?.availableActions;
    };

    // The scheduler proposes and offers (workforce.propose_assignment) but holds neither withdrawal
    // nor completion, and only the assignee answers an offer.
    const bySchedulerView = await listFor(scheduler);
    expect(bySchedulerView(proposed.id)).toEqual(['offer']);
    expect(bySchedulerView(offered.id)).toEqual([]);
    expect(bySchedulerView(toAccept.id)).toEqual([]);

    // The league manager also withdraws; completion waits for the start of the game.
    const byManager = await listFor(leagueManager);
    expect(byManager(proposed.id)).toEqual(['offer', 'withdraw']);
    expect(byManager(offered.id)).toEqual(['withdraw']);
    expect(byManager(toAccept.id)).toEqual(['withdraw']);

    // The assignee listing their own assignments answers the offer or withdraws.
    const byAssignee = await listFor(
      referee,
      `personId=${referee.personId}&targetId=${game.fixtureId}`,
    );
    expect(byAssignee(offered.id)).toEqual(['accept', 'decline', 'withdraw']);
    expect(byAssignee(toAccept.id)).toEqual(['withdraw']);

    // Once the game has started the manager may complete the accepted work; after it ended
    // nothing can be offered or accepted any more.
    const before = t.clock.now();
    t.clock.set(new Date(new Date(game.start).getTime() + 5 * 60_000));
    try {
      const started = await listFor(leagueManager);
      expect(started(toAccept.id)).toEqual(['withdraw', 'complete']);
      t.clock.set(new Date(new Date(game.end).getTime() + 60_000));
      const ended = await listFor(leagueManager);
      expect(ended(proposed.id)).toEqual(['withdraw']);
      const endedForAssignee = await listFor(
        referee,
        `personId=${referee.personId}&targetId=${game.fixtureId}`,
      );
      expect(endedForAssignee(offered.id)).toEqual(['decline', 'withdraw']);
    } finally {
      t.clock.set(before);
    }
  });
});
