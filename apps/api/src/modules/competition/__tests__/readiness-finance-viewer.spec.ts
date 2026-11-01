import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
// Finance's read rule for a team obligation is the one readiness follows (READ_TEAM_OBLIGATION_ACTION).
import { FinanceActions } from '../../finance/finance.actions';
import {
  FINANCIAL_CONDITIONS_IMPL,
  type ConditionFinding,
  type FinancialConditionsPort,
} from '../competition-matches.ports';
import { READ_TEAM_OBLIGATION_ACTION } from '../services/team-entries.service';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, staffMember, type Actor } from './support';

interface Issue {
  code: string;
  severity: string;
  message: string;
  source: { type: string; id: string | null };
  deadline: string | null;
}

/**
 * R3-TRACE-B-01b (§4.14 field-level authorization, §4.7 invariant 1, SPK-READY-001/003,
 * SPK-PAY-004, SPK-CAP-002): finance reports a team balance per team entry (here a deterministic
 * fake of its port). Readiness hands an entry-level finding, with the amount and the next due date
 * as its deadline, only to a viewer finance lets read that entry's obligation; every other viewer
 * gets one fixture-level finding that names no entry and is the same with or without a balance.
 */
describe('readiness scopes team-balance findings by viewer (R3-TRACE-B-01b)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let homePlayer: Actor;
  let awayCaptain: Actor;
  let awayEntryId: string;
  let fixtureId: string;
  const owing = new Set<string>();
  const finance: FinancialConditionsPort = {
    fixtureConditions: async (_organizationId, context) =>
      context.teamEntryIds
        .filter((id) => owing.has(id))
        .map((id): ConditionFinding => ({
          status: 'unknown',
          code: 'team_balance_policy_pending',
          message: 'This team has an open balance.',
          source: { type: 'team_entry', id },
          responsibleRole: 'finance_operator',
          requiredAction: 'The team settles its balance.',
          deadline: null,
        })),
    entryFinancialStatus: async (_organizationId, teamEntryId) =>
      owing.has(teamEntryId)
        ? {
            status: 'outstanding',
            openObligations: 1,
            outstanding: [{ amountMinor: 60_000, currency: 'USD' }],
            nextDueAt: '2027-01-20T18:00:00.000Z',
          }
        : { status: 'none' },
  };

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: FINANCIAL_CONDITIONS_IMPL, useValue: finance }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    const season = await createSeasonFixture(t, { status: 'active' });
    // the division plays at the test facility (America/Los_Angeles)
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    const homeCaptain = await adultCustomer(t);
    homePlayer = await adultCustomer(t);
    awayCaptain = await adultCustomer(t);
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: homeCaptain.personId,
      teamName: 'Home',
      divisionId,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: awayCaptain.personId,
      teamName: 'Away',
      divisionId,
    });
    awayEntryId = away.teamEntryId;
    await addRosterMemberFixture(t, {
      teamEntryId: home.teamEntryId,
      personId: homePlayer.personId,
    });
    await addRosterMemberFixture(t, { teamEntryId: awayEntryId, personId: awayCaptain.personId });
    fixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId,
      scheduledStart: '2027-01-17T02:00:00.000Z',
      scheduledEnd: '2027-01-17T03:00:00.000Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function financeIssues(actor: Actor): Promise<Issue[]> {
    const res = await t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(actor.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.issues as Issue[]).filter((i) => i.code === 'team_balance_policy_pending');
  }

  it('follows finance’s read rule for the team obligation', () => {
    expect(READ_TEAM_OBLIGATION_ACTION).toBe(FinanceActions.readObligation.id);
  });

  it('§4.14: a player of the other team gets one fixture-level finding, the same with or without a balance', async () => {
    owing.clear();
    const withoutBalance = await financeIssues(homePlayer);
    owing.add(awayEntryId);
    const withBalance = await financeIssues(homePlayer);
    expect(withBalance).toHaveLength(1);
    expect(withBalance[0]).toMatchObject({
      code: 'team_balance_policy_pending',
      severity: 'unknown',
      source: { type: 'fixture', id: fixtureId },
      deadline: null,
    });
    expect(withBalance[0]?.message).not.toMatch(/\$|USD|2027|open balance/);
    expect(withBalance).toEqual(withoutBalance);
  });

  it('SPK-READY-003: the league manager and the owing team’s captain see the amount and the due date as deadline', async () => {
    owing.clear();
    owing.add(awayEntryId);
    const asLeague = await financeIssues(leagueManager);
    expect(asLeague).toHaveLength(1);
    expect(asLeague[0]).toMatchObject({
      severity: 'unknown',
      source: { type: 'team_entry', id: awayEntryId },
      deadline: '2027-01-20T18:00:00.000Z',
    });
    expect(asLeague[0]?.message).toContain('$600.00');
    // the due date in the division facility's time zone (SPK-SCHED-008)
    expect(asLeague[0]?.message).toContain('America/Los_Angeles');

    const asCaptain = await financeIssues(awayCaptain);
    const own = asCaptain.filter((i) => i.source.type === 'team_entry');
    expect(own).toHaveLength(1);
    expect(own[0]?.deadline).toBe('2027-01-20T18:00:00.000Z');
    // the captain does not read the other team's obligation, so the fixture-level finding stays
    expect(asCaptain.filter((i) => i.source.type === 'fixture')).toHaveLength(1);
  });
});
