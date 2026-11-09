import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createDivisionFixture, createSeasonFixture } from '../testing/competition-fixtures';
import { competitionTestApp, key, staffMember, type Actor } from './support';

interface Node {
  id: string;
  round: number;
  slot: number;
  name: string;
  published: boolean;
  sourceRule: {
    home: { kind: string; seed?: number; nodeId?: string };
    away: { kind: string; seed?: number; nodeId?: string };
  };
}

/** SPK-COMP-001 bracket progression: a division's whole playoff bracket from its structure. */
describe('bracket generation from a playoff structure (SPK-COMP-001, SPK-AT-014)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let desk: Actor;
  let seasonId: string;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    desk = await staffMember(t, ['front_desk']);
    seasonId = (await createSeasonFixture(t, { status: 'active' })).seasonId;
  });
  afterAll(async () => {
    await t.close();
  });

  const generate = (divisionId: string, actor: Actor, body: object, k = key()) =>
    t.http
      .post(`/v1/divisions/${divisionId}/bracket-nodes/generate`)
      .set(actor.header)
      .set('Idempotency-Key', k)
      .send(body);

  it('SPK-COMP-001: six qualifiers give five unpublished nodes; the top seeds go straight to the semifinals', async () => {
    const divisionId = await createDivisionFixture(t, { seasonId, name: 'Gold' });
    const k = key();
    const res = await generate(
      divisionId,
      leagueManager,
      { structure: { kind: 'single_elimination', teams: 6 }, namePrefix: 'Gold playoffs' },
      k,
    );
    expect(res.status).toBe(201);
    const nodes = res.body as Node[];
    expect(nodes.map((n) => [n.round, n.slot, n.name])).toEqual([
      [1, 2, 'Gold playoffs: Quarterfinal 2'],
      [1, 4, 'Gold playoffs: Quarterfinal 4'],
      [2, 1, 'Gold playoffs: Semifinal 1'],
      [2, 2, 'Gold playoffs: Semifinal 2'],
      [3, 1, 'Gold playoffs: Final'],
    ]);
    expect(nodes.every((n) => !n.published)).toBe(true);
    const byPosition = new Map(nodes.map((n) => [`${n.round}:${n.slot}`, n]));
    expect(byPosition.get('2:1')?.sourceRule).toEqual({
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'winner_of', nodeId: byPosition.get('1:2')?.id },
    });
    expect(byPosition.get('3:1')?.sourceRule).toEqual({
      home: { kind: 'winner_of', nodeId: byPosition.get('2:1')?.id },
      away: { kind: 'winner_of', nodeId: byPosition.get('2:2')?.id },
    });
    // The season's bracket list shows them; a replay of the command returns the same answer.
    const listed = await t.http
      .get(`/v1/seasons/${seasonId}/bracket-nodes?divisionId=${divisionId}`)
      .set(leagueManager.header);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(5);
    const replay = await generate(
      divisionId,
      leagueManager,
      { structure: { kind: 'single_elimination', teams: 6 }, namePrefix: 'Gold playoffs' },
      k,
    );
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((replay.body as Node[]).map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });

  it('SPK-AT-014: a division with a bracket is never given a second one', async () => {
    const divisionId = await createDivisionFixture(t, { seasonId, name: 'Silver' });
    expect(
      (
        await generate(divisionId, leagueManager, {
          structure: { kind: 'single_elimination', teams: 4 },
        })
      ).status,
    ).toBe(201);
    const again = await generate(divisionId, leagueManager, {
      structure: { kind: 'single_elimination', teams: 8 },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RESOURCE_CONFLICT');
    expect(again.body.details).toMatchObject({ code: 'BRACKET_EXISTS', divisionId });
  });

  it('§4.14: only league administration generates brackets; an unknown division is not found', async () => {
    const divisionId = await createDivisionFixture(t, { seasonId, name: 'Bronze' });
    const denied = await generate(divisionId, desk, {
      structure: { kind: 'single_elimination', teams: 4 },
    });
    expect(denied.status).toBe(403);
    const missing = await generate('01a1c000-0000-7000-8000-000000000999', leagueManager, {
      structure: { kind: 'single_elimination', teams: 4 },
    });
    expect(missing.status).toBe(404);
    const invalid = await generate(divisionId, leagueManager, {
      structure: { kind: 'single_elimination', teams: 1 },
    });
    expect(invalid.status).toBe(400);
  });
});
