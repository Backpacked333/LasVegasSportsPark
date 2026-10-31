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
 * is read by players and guardians of both teams, and competition passes finance's condition
 * through as it is. A team balance's count, amounts and due date go only to viewers finance lets
 * read the team obligation (the team entry workspace, R2-JOURNEYS-05), so the readiness finding
 * names the team entry and the pending policy, never the balance.
 */
describe('fixture readiness never shows a team balance (R3-TRACE-B-01, SPK-READY-001)', () => {
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

  async function balanceIssue(actor: Actor): Promise<ReadinessIssue> {
    const res = await t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(actor.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const issues = (res.body.issues as ReadinessIssue[]).filter(
      (i) => i.code === 'team_balance_policy_pending',
    );
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
      expect(issue).toMatchObject({
        severity: 'unknown',
        source: { type: 'team_entry', id: awayEntryId },
      });
      expectNoBalanceFacts(issue);
    }
  });

  it("SPK-CAP-002: the team's own non-captain player sees no amount, count or due date", async () => {
    expectNoBalanceFacts(await balanceIssue(awayPlayer));
  });

  it('SPK-READY-001 / POL-017: the condition stays unknown for staff too, never a pass or a block, with the same wording', async () => {
    const asStaff = await balanceIssue(leagueManager);
    expect(asStaff).toMatchObject({ severity: 'unknown', responsibleRole: 'finance_operator' });
    expectNoBalanceFacts(asStaff);
    // The amount and due date stay where finance's read rule applies: the captain's workspace.
    const workspace = await t.http.get(`/v1/team-entries/${awayEntryId}`).set(awayCaptain.header);
    expect(workspace.status).toBe(200);
    expect(JSON.stringify(workspace.body)).toContain('$600.00');
  });
});
