import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  TEAM_PLAYER_COMMITMENTS_IMPL,
  type TeamPlayerCommitments,
  type TeamPlayerCommitmentsPort,
} from '../competition-matches.ports';
import { WAITING_ENTRY_PLAYER_COMMITMENTS } from '../competition.policy';
import {
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

/**
 * SPK-COMP-006 (QA M-5): a team moved onto the waiting list keeps what its players bought. The
 * move changes no money; the command's answer says how many registrations and uniform orders
 * there are and one operational exception asks finance to decide. Enrollment answers the counts
 * in the assembled application (`enrollment/__tests__/team-player-commitments.spec.ts`); here a
 * double stands in for it, as competition never reads enrollment's tables.
 */
describe('a team moved to waiting while its players hold registrations (SPK-COMP-006, QA M-5)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  const held = new Map<string, TeamPlayerCommitments>();
  const asked: string[] = [];
  const enrollment: TeamPlayerCommitmentsPort = {
    commitmentsOfEntry: async (_organizationId, teamEntryId) => {
      asked.push(teamEntryId);
      return held.get(teamEntryId) ?? { confirmedRegistrations: 0, uniformOrders: 0 };
    },
  };

  beforeAll(async () => {
    t = await competitionTestApp({
      capabilities: ['team_waitlist'],
      providers: [{ provide: TEAM_PLAYER_COMMITMENTS_IMPL, useValue: enrollment }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);

  /** A season whose only division is full. */
  async function fullSeason(): Promise<{ seasonId: string; divisionId: string }> {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 1,
    });
    await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId,
    });
    return { seasonId: season.seasonId, divisionId };
  }

  async function enter(seasonId: string, name: string): Promise<{ id: string; revision: number }> {
    const captain = await adultCustomer(t);
    const res = await post('/team-entries', captain, { seasonId, team: { name } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.entry.id as string, revision: res.body.entry.revision as number };
  }

  const exceptionsOf = (entryId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select([
        'category',
        'severity',
        'owner_queue',
        'status',
        'title',
        'affected_type',
        'details',
      ])
      .where('organization_id', '=', t.organizationId)
      .where('affected_id', '=', entryId)
      .orderBy('id')
      .execute();

  it('SPK-COMP-006: moving an entry to waiting whose players hold confirmed registrations and uniform orders says how many in the answer and raises one exception for finance; no money changes and nobody is named', async () => {
    const { seasonId, divisionId } = await fullSeason();
    const bravo = await enter(seasonId, 'Bravo');
    held.set(bravo.id, { confirmedRegistrations: 3, uniformOrders: 2 });

    const waited = await post(`/team-entries/${bravo.id}/wait`, leagueManager, {
      divisionId,
      expectedRevision: bravo.revision,
    });
    expect(waited.status, JSON.stringify(waited.body)).toBe(200);
    expect(waited.body).toMatchObject({
      id: bravo.id,
      status: 'waiting',
      // a waiting entry still owes nothing itself
      financialStatusRef: null,
      playerCommitments: { confirmedRegistrations: 3, uniformOrders: 2 },
    });
    expect(asked).toContain(bravo.id);

    const raised = await exceptionsOf(bravo.id);
    expect(raised).toEqual([
      {
        category: WAITING_ENTRY_PLAYER_COMMITMENTS.category,
        severity: 'warning',
        owner_queue: 'finance_operator',
        status: 'open',
        title:
          'Team moved to the waiting list: 3 confirmed player registrations and 2 uniform orders to decide',
        affected_type: 'team_entry',
        details: {
          teamEntryId: bravo.id,
          seasonId,
          waitingDivisionId: divisionId,
          cause: 'staff',
          confirmedRegistrations: 3,
          uniformOrders: 2,
        },
      },
    ]);

    // The counts belong to the command's answer only: a later read of the entry does not carry them.
    const read = await t.http.get(`/v1/team-entries/${bravo.id}`).set(leagueManager.header);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.entry.status).toBe('waiting');
    expect(read.body.entry).not.toHaveProperty('playerCommitments');
  });

  it('SPK-COMP-006: the automatic wait of a placement into a full division says the same and raises the same exception', async () => {
    const { seasonId, divisionId } = await fullSeason();
    const charlie = await enter(seasonId, 'Charlie');
    held.set(charlie.id, { confirmedRegistrations: 1, uniformOrders: 0 });

    const placed = await post(`/team-entries/${charlie.id}/approve`, leagueManager, {
      divisionId,
      expectedRevision: charlie.revision,
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body).toMatchObject({
      status: 'waiting',
      playerCommitments: { confirmedRegistrations: 1, uniformOrders: 0 },
    });
    const raised = await exceptionsOf(charlie.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      owner_queue: 'finance_operator',
      title:
        'Team moved to the waiting list: 1 confirmed player registration and 0 uniform orders to decide',
      details: { cause: 'division_full', confirmedRegistrations: 1, uniformOrders: 0 },
    });
  });

  it('SPK-COMP-006: a team whose players hold nothing waits with zero counts in the answer and no exception', async () => {
    const { seasonId, divisionId } = await fullSeason();
    const delta = await enter(seasonId, 'Delta');

    const waited = await post(`/team-entries/${delta.id}/wait`, leagueManager, {
      divisionId,
      expectedRevision: delta.revision,
    });
    expect(waited.status, JSON.stringify(waited.body)).toBe(200);
    expect(waited.body.playerCommitments).toEqual({ confirmedRegistrations: 0, uniformOrders: 0 });
    expect(await exceptionsOf(delta.id)).toEqual([]);
  });

  it('SPK-COMP-006: a refused move asks nothing and raises nothing', async () => {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 2,
    });
    const echo = await enter(season.seasonId, 'Echo');
    held.set(echo.id, { confirmedRegistrations: 4, uniformOrders: 4 });
    const before = asked.length;

    const refused = await post(`/team-entries/${echo.id}/wait`, leagueManager, {
      divisionId,
      expectedRevision: echo.revision,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details).toMatchObject({ code: 'DIVISION_HAS_ROOM' });
    expect(asked.length).toBe(before);
    expect(await exceptionsOf(echo.id)).toEqual([]);
  });
});
