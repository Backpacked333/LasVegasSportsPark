import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  ROSTER_PORT,
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type RosterPort,
} from '../../competition';
import { CapacityService } from '../services/capacity.service';
import { adult, drain, enrollmentTestApp, post, staff, type Actor } from './support';

/**
 * §4.7 invariants 3 and 12, §4.11, SPK-AT-023: placement's steps (hold, competition's roster
 * command, committed place, operation) run in one transaction. A failure between the roster add
 * and the committed place (here an infrastructure error standing in for a lost connection or a
 * stopped process) leaves nothing behind: no roster row the pool does not count, no placement
 * stuck `unassigned` with its player on the roster, no operation left `running`.
 */
describe('placement steps commit together (§4.7-3, §4.7-12, SPK-AT-023)', () => {
  let t: TestApp;
  let lm: Actor;
  let seasonId: string;
  let entry: string;
  let roster: RosterPort;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    lm = await staff(t, ['league_manager']);
    const pm = await staff(t, ['program_manager']);
    roster = t.app.get(ROSTER_PORT);
    seasonId = (await createSeasonFixture(t)).seasonId;
    entry = (
      await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: (await adult(t)).personId,
        teamName: 'Badgers',
      })
    ).teamEntryId;
    await addRosterMemberFixture(t, { teamEntryId: entry, personId: (await adult(t)).personId });
    const pool = await post(t, '/v1/capacity-pools', pm.header, {
      scopeType: 'team_entry',
      scopeId: entry,
      unit: 'roster_places',
      capacity: 1,
    });
    expect(pool.status).toBe(201);
  });
  afterAll(async () => {
    await t.close();
  });

  async function request(player: Actor) {
    const res = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; revision: number };
  }
  const assign = (id: string, revision: number) =>
    post(t, `/v1/placement-requests/${id}/assign`, lm.header, {
      teamEntryId: entry,
      expectedRevision: revision,
    });
  const onRoster = async (personId: string) =>
    (await roster.effectiveRoster(t.organizationId, entry, t.clock.now())).some(
      (m) => m.personId === personId,
    );
  const pool = () =>
    t.db
      .selectFrom('capacity_pools')
      .select(['held', 'committed'])
      .where('scope_id', '=', entry)
      .executeTakeFirstOrThrow();
  const placement = (id: string) =>
    t.db
      .selectFrom('placement_requests')
      .select(['status', 'revision', 'last_operation_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const running = async (kind: string) =>
    (
      await t.db
        .selectFrom('operations')
        .select('id')
        .where('kind', '=', kind)
        .where('status', '=', 'running')
        .execute()
    ).length;

  it('§4.7-12 / SPK-AT-023: a failure after the roster add rolls the whole assignment back; the retry assigns', async () => {
    const first = await adult(t, { dateOfBirth: '1999-03-03' });
    const second = await adult(t, { dateOfBirth: '1998-03-03' });
    const a = await request(first);
    const b = await request(second);
    const before = await placement(a.id);

    const spy = vi
      .spyOn(t.app.get(CapacityService), 'commitHold')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const crashed = await assign(a.id, a.revision);
    spy.mockRestore();
    expect(crashed.status).toBe(500);

    // nothing of the interrupted assignment committed
    expect(await onRoster(first.personId)).toBe(false);
    expect(await placement(a.id)).toEqual(before);
    expect(await pool()).toEqual({ held: 0, committed: 0 });
    expect(await running('enrollment.assign_placement')).toBe(0);
    await drain(t);

    // a retry with a new key and the same revision completes it
    const retried = await assign(a.id, a.revision);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.status).toBe('assigned');
    expect(await onRoster(first.personId)).toBe(true);
    expect(await pool()).toEqual({ held: 0, committed: 1 });

    // §4.7-3: the pool and the roster agree, so the second player finds no place
    const full = await assign(b.id, b.revision);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('CAPACITY_UNAVAILABLE');
    expect(await onRoster(second.personId)).toBe(false);
  });

  it('§4.7-12: a failure after the roster removal rolls the whole release back', async () => {
    const player = await adult(t, { dateOfBirth: '1997-03-03' });
    // free the single place first
    const holder = await t.db
      .selectFrom('placement_requests')
      .select(['id', 'revision'])
      .where('status', '=', 'assigned')
      .where('assigned_team_entry_id', '=', entry)
      .executeTakeFirstOrThrow();
    const freed = await post(t, `/v1/placement-requests/${holder.id}/release`, lm.header, {
      expectedRevision: holder.revision,
      reason: 'Moved away',
    });
    expect(freed.status, JSON.stringify(freed.body)).toBe(200);
    t.clock.advance(1000);
    const req = await request(player);
    const assigned = await assign(req.id, req.revision);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const before = await placement(req.id);

    const spy = vi
      .spyOn(t.app.get(CapacityService), 'releaseAllocationsFor')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const crashed = await post(t, `/v1/placement-requests/${req.id}/release`, lm.header, {
      expectedRevision: before.revision,
      reason: 'Injury',
    });
    spy.mockRestore();
    expect(crashed.status).toBe(500);
    expect(await onRoster(player.personId)).toBe(true);
    expect(await placement(req.id)).toEqual(before);
    expect(await pool()).toEqual({ held: 0, committed: 1 });
    expect(await running('enrollment.release_placement')).toBe(0);

    const released = await post(t, `/v1/placement-requests/${req.id}/release`, lm.header, {
      expectedRevision: before.revision,
      reason: 'Injury',
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    t.clock.advance(1000);
    expect(await onRoster(player.personId)).toBe(false);
    expect(await pool()).toEqual({ held: 0, committed: 0 });
  });
});
