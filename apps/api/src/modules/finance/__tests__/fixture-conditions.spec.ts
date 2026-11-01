import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { at, seedPitchWithHalves } from '../../scheduling';
import { createObligationFixture } from '../testing/finance-fixtures';
import { adult, child, drain, financeTestApp, key, staff, type Actor } from './support';

interface ReadinessIssue {
  code: string;
  severity: string;
  message: string;
  source: { type: string; id: string | null };
  requiredAction: string;
  deadline: string | null;
}

/**
 * R3-TRACE-B-01 (§4.14 object- and field-level authorization, §4.7 invariant 1, SPK-READY-001
 * "applicable financial conditions", SPK-PAY-004, SPK-CAP-002): `GET /v1/fixtures/{id}/readiness`
 * is read by players and guardians of both teams. A team balance's count, amounts and due date go
 * only to viewers finance lets read the team obligation (the team entry workspace,
 * R2-JOURNEYS-05), and finance's condition port does not know the viewer, so the finding carries
 * none of them for anyone.
 *
 * The finding names the team entry, and competition scopes it by viewer (R3-TRACE-B-01b): a
 * viewer finance.read_obligation admits for that entry gets it with the amount and, as its
 * deadline, the next due date (SPK-READY-003); every other viewer gets one fixture-level finding
 * that names no entry and states no balance, the same whether or not any entry has one.
 */
describe('fixture readiness never shows a team balance amount, count or due date (R3-TRACE-B-01, SPK-READY-001)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let homeCaptain: Actor;
  let homePlayer: Actor;
  let homeGuardian: Actor;
  let awayCaptain: Actor;
  let awayPlayer: Actor;
  let homeEntryId: string;
  let awayEntryId: string;
  let fixtureId: string;
  let clearFixtureId: string;

  beforeAll(async () => {
    t = await financeTestApp();
    leagueManager = await staff(t, ['league_manager']);
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    const season = await createSeasonFixture(t, { status: 'active' });
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    homeCaptain = await adult(t);
    homePlayer = await adult(t);
    homeGuardian = await adult(t);
    const homeChild = await child(t, [homeGuardian]);
    awayCaptain = await adult(t);
    awayPlayer = await adult(t);
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
    homeEntryId = home.teamEntryId;
    awayEntryId = away.teamEntryId;
    for (const personId of [homeCaptain.personId, homePlayer.personId, homeChild]) {
      await addRosterMemberFixture(t, { teamEntryId: homeEntryId, personId });
    }
    for (const personId of [awayCaptain.personId, awayPlayer.personId]) {
      await addRosterMemberFixture(t, { teamEntryId: awayEntryId, personId });
    }
    const created = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        divisionId,
        homeEntryId,
        awayEntryId,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-01-16', '18:00'),
          scheduledEnd: at('2027-01-16', '19:00'),
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    fixtureId = created.body.fixture.id as string;
    // A second fixture between two entries that owe nothing.
    const clearHome = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: 'Clear home',
      divisionId,
    });
    const clearAway = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: 'Clear away',
      divisionId,
    });
    for (const personId of [homePlayer.personId, homeChild]) {
      await addRosterMemberFixture(t, { teamEntryId: clearHome.teamEntryId, personId });
    }
    const clear = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        divisionId,
        homeEntryId: clearHome.teamEntryId,
        awayEntryId: clearAway.teamEntryId,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-01-17', '18:00'),
          scheduledEnd: at('2027-01-17', '19:00'),
        },
      });
    expect(clear.status, JSON.stringify(clear.body)).toBe(201);
    clearFixtureId = clear.body.fixture.id as string;
    await drain(t);
    // The away team owes 600.00 USD, due 2027-01-20.
    await createObligationFixture(t, {
      debtorTeamEntryId: awayEntryId,
      amountMinor: 60_000,
      dueAt: new Date('2027-01-20T18:00:00Z'),
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  async function balanceIssues(actor: Actor, id: string = fixtureId): Promise<ReadinessIssue[]> {
    const res = await t.http.get(`/v1/fixtures/${id}/readiness`).set(actor.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.issues as ReadinessIssue[]).filter(
      (i) => i.code === 'team_balance_policy_pending',
    );
  }

  async function balanceIssue(actor: Actor): Promise<ReadinessIssue> {
    const issues = await balanceIssues(actor);
    expect(issues).toHaveLength(1);
    return issues[0] as ReadinessIssue;
  }

  /** The away entry's own finding, for a viewer finance lets read its obligation. */
  async function awayEntryIssue(actor: Actor): Promise<ReadinessIssue> {
    const issues = (await balanceIssues(actor)).filter((i) => i.source.type === 'team_entry');
    expect(issues).toHaveLength(1);
    return issues[0] as ReadinessIssue;
  }

  function expectNoBalanceFacts(issue: ReadinessIssue): void {
    const text = `${issue.message} ${issue.requiredAction}`;
    // No amount (raw minor units or formatted), no count, no due date, no record id.
    expect(text).not.toMatch(/60000|600(\.00)?|\$|USD|minor units/);
    expect(text).not.toMatch(/\d+ open obligation/);
    expect(text).not.toMatch(/2027|Jan/);
    expect(issue.deadline).toBeNull();
  }

  it('§4.14: an opposing player, an opposing guardian and the opposing captain see no amount, count or due date', async () => {
    for (const viewer of [homePlayer, homeGuardian, homeCaptain]) {
      const issue = await balanceIssue(viewer);
      expect(issue.severity).toBe('unknown');
      expectNoBalanceFacts(issue);
    }
  });

  it('§4.14 (R3-TRACE-B-01b): opposing players and guardians get one fixture-level finding naming no entry, the same as on a fixture without a balance', async () => {
    for (const viewer of [homePlayer, homeGuardian]) {
      const issue = await balanceIssue(viewer);
      expect(issue.source).toEqual({ type: 'fixture', id: fixtureId });
      expect(issue.message).not.toContain(awayEntryId);
      expect(issue.message).not.toContain('open balance');
      expect(issue.message).not.toContain('Away');
      const withoutBalance = await balanceIssues(viewer, clearFixtureId);
      expect(withoutBalance).toHaveLength(1);
      const { source: clearSource, ...clearRest } = withoutBalance[0] as ReadinessIssue;
      const { source, ...rest } = issue;
      expect(clearSource).toEqual({ type: 'fixture', id: clearFixtureId });
      expect(source).toEqual({ type: 'fixture', id: fixtureId });
      expect(clearRest).toEqual(rest);
    }
  });

  it("SPK-CAP-002: the team's own non-captain player sees no amount, count or due date", async () => {
    expectNoBalanceFacts(await balanceIssue(awayPlayer));
  });

  it('SPK-READY-001 / POL-017: the condition stays unknown for staff too, never a pass or a block', async () => {
    const asStaff = await balanceIssue(leagueManager);
    expect(asStaff).toMatchObject({
      severity: 'unknown',
      responsibleRole: 'finance_operator',
      source: { type: 'team_entry', id: awayEntryId },
    });
    // The amount and due date are on the workspace, where finance's read rule applies.
    const workspace = await t.http.get(`/v1/team-entries/${awayEntryId}`).set(awayCaptain.header);
    expect(workspace.status).toBe(200);
    expect(JSON.stringify(workspace.body)).toContain('$600.00');
  });

  it('SPK-READY-003 (R3-TRACE-B-01b): viewers finance.read_obligation admits see the amount and the next due date as the deadline', async () => {
    for (const viewer of [leagueManager, awayCaptain]) {
      const issue = await awayEntryIssue(viewer);
      expect(issue).toMatchObject({
        severity: 'unknown',
        source: { type: 'team_entry', id: awayEntryId },
        deadline: '2027-01-20T18:00:00.000Z',
      });
      expect(issue.message).toContain('$600.00');
      expect(issue.message).toContain('POL-017');
    }
    // The league manager reads both entries' obligations, so no fixture-level finding is added.
    expect(await balanceIssues(leagueManager)).toHaveLength(1);
  });
});
