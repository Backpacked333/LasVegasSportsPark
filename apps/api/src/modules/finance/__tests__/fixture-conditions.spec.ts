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
 * The finding names the team entry, which competition needs to scope it by viewer, and today
 * competition passes it through unchanged. The tests named "KNOWN GAP R3-TRACE-B-01b" record what
 * that still discloses (which entry has a balance) and what it still withholds from admitted
 * viewers (the deadline, SPK-READY-003). They are not the intended behaviour: they change when the
 * deferred competition change lands, and are then replaced by its target, written in each test.
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
      expect(issue.severity).toBe('unknown');
      expectNoBalanceFacts(issue);
    }
  });

  it('KNOWN GAP R3-TRACE-B-01b (deferred competition change): opposing players and guardians still learn which entry has an open balance', async () => {
    // Today: competition passes finance's entry-scoped finding to every readiness viewer, so the
    // home team's player and guardian, who may not read the away entry's obligation
    // (finance.read_obligation) nor open its workspace, see that the away entry has a balance.
    // Target once competition scopes the finding by viewer: they get one fixture-level finding
    // (source { type: 'fixture', id: fixtureId }) that names no entry and states no balance, the
    // same whether or not any entry has one; replace these assertions with that.
    for (const viewer of [homePlayer, homeGuardian]) {
      const issue = await balanceIssue(viewer);
      expect(issue.source).toEqual({ type: 'team_entry', id: awayEntryId });
      expect(issue.message).toContain('open balance');
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

  it('KNOWN GAP R3-TRACE-B-01b (deferred competition change): viewers finance.read_obligation admits get no amount and no deadline in readiness (SPK-READY-003)', async () => {
    // Today: the league manager and the away captain may read the away obligation, but the
    // readiness finding has no amount and a null deadline for them as for everyone.
    // Target once competition adds the details for admitted viewers: the message carries the
    // formatted amount ($600.00) and `deadline` is the next due date (2027-01-20T18:00:00.000Z);
    // replace these assertions with that.
    for (const viewer of [leagueManager, awayCaptain]) {
      expectNoBalanceFacts(await balanceIssue(viewer));
    }
  });
});
