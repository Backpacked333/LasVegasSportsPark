import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { proposedRuleSetContent } from '../competition.policy';
import { SUSPENSION_CHECK_IMPL, type SuspensionCheckPort } from '../ports';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import { competitionTestApp, key, staffMember, type Actor } from './support';

/**
 * R3-TRACE-A-01 (§2.1 "access depends on the specific action and scope, not merely a role label";
 * SPK-CAP-004, SPK-CAP-005, SPK-CAP-002, SPK-DISC-004; §3.1 "a coach who is also a parent receives
 * each permission only in its proper scope"). Identity marks anyone holding any staff role as kind
 * `staff`. Competition grants staff powers only through a staff role that holds the action: a
 * captain who is also a referee or a coach acts on the customer path everywhere else.
 */
describe('R3-TRACE-A-01: staff powers follow the action’s staff roles, never the principal kind', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  const suspended = new Set<string>();
  const suspensions: SuspensionCheckPort = {
    activeSuspensions: async (_organizationId, personId) =>
      suspended.has(personId)
        ? [{ id: 'suspension-77', reason: 'dissent', scope: 'competition', until: null }]
        : [],
  };

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: SUSPENSION_CHECK_IMPL, useValue: suspensions }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor, query: Record<string, string> = {}) =>
    t.http.get(`/v1${path}`).set(actor.header).query(query);

  /** A referee (staff role `official`, no league authority) who captains a prior-season entry. */
  async function officialCaptainOfPriorEntry() {
    const official = await staffMember(t, ['official']);
    const prior = await createSeasonFixture(t, {
      status: 'completed',
      startsOn: '2026-01-10',
      endsOn: '2026-04-10',
    });
    const entry = await createTeamEntryFixture(t, {
      seasonId: prior.seasonId,
      captainPersonId: official.personId,
    });
    return { official, priorEntryId: entry.teamEntryId };
  }

  it('SPK-CAP-005: a captain who is also an official renews only inside the registration window, as their own captain, unplaced', async () => {
    const { official, priorEntryId } = await officialCaptainOfPriorEntry();
    const closedWindow = await createSeasonFixture(t, {
      status: 'open',
      registrationOpensAt: new Date('2026-09-01T00:00:00Z'),
      registrationClosesAt: new Date('2026-10-01T00:00:00Z'),
    });
    const division = await createDivisionFixture(t, { seasonId: closedWindow.seasonId });
    const otherAdult = await createPersonFixture(t, { kind: 'adult' });

    const late = await post('/team-entries', official, {
      seasonId: closedWindow.seasonId,
      renewFromEntryId: priorEntryId,
    });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('ELIGIBILITY_FAILED');
    expect(late.body.details).toMatchObject({ registrationClosesAt: '2026-10-01T00:00:00.000Z' });

    for (const extra of [{ captainPersonId: otherAdult }, { divisionId: division }]) {
      const res = await post('/team-entries', official, {
        seasonId: closedWindow.seasonId,
        renewFromEntryId: priorEntryId,
        ...extra,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
    }
    const entries = await t.db
      .selectFrom('team_entries')
      .select('id')
      .where('season_id', '=', closedWindow.seasonId)
      .execute();
    expect(entries).toEqual([]);

    // league management keeps its staff powers: outside the window, for a named captain, placed
    const byManager = await post('/team-entries', leagueManager, {
      seasonId: closedWindow.seasonId,
      renewFromEntryId: priorEntryId,
      captainPersonId: otherAdult,
      divisionId: division,
    });
    expect(byManager.status).toBe(201);
    expect(byManager.body.entry).toMatchObject({ divisionId: division, status: 'applied' });
  });

  it('SPK-COMP-004: placing an entry in a division at creation is the approval action’s power, not front desk’s', async () => {
    const season = await createSeasonFixture(t, { status: 'open' });
    const division = await createDivisionFixture(t, { seasonId: season.seasonId });
    const captain = await createPersonFixture(t, { kind: 'adult' });
    const placed = await post('/team-entries', frontDesk, {
      seasonId: season.seasonId,
      team: { name: 'Desk placed' },
      captainPersonId: captain,
      divisionId: division,
    });
    expect(placed.status).toBe(403);
    expect(placed.body.details).toMatchObject({ action: 'competition.approve_team_entry' });
    const unplaced = await post('/team-entries', frontDesk, {
      seasonId: season.seasonId,
      team: { name: 'Desk entered' },
      captainPersonId: captain,
    });
    expect(unplaced.status).toBe(201);
    expect(unplaced.body.entry.divisionId).toBeNull();
  });

  it('SPK-CAP-004: a captain who is also an official cannot add a guest the rule set holds for league approval; the row is a captain addition', async () => {
    const official = await staffMember(t, ['official']);
    const gated = await createSeasonFixture(t, {
      ruleSet: {
        roster: {
          ...proposedRuleSetContent('small_sided_other').roster,
          guestOrSubstituteRequiresApproval: true,
        },
      },
    });
    const entry = await createTeamEntryFixture(t, {
      seasonId: gated.seasonId,
      captainPersonId: official.personId,
    });
    const guest = await createPersonFixture(t, { kind: 'adult' });
    const asGuest = await post(`/team-entries/${entry.teamEntryId}/roster`, official, {
      changes: [{ action: 'add', personId: guest, status: 'guest' }],
    });
    expect(asGuest.status).toBe(422);
    expect(asGuest.body.details.reasons).toEqual([
      expect.objectContaining({ code: 'approval_required', responsibleRole: 'league_manager' }),
    ]);
    const regular = await createPersonFixture(t, { kind: 'adult' });
    const added = await post(`/team-entries/${entry.teamEntryId}/roster`, official, {
      changes: [{ action: 'add', personId: regular }],
    });
    expect(added.status).toBe(200);
    expect(added.body.members).toEqual([
      expect.objectContaining({ personId: regular, source: 'captain' }),
    ]);
    // a past roster stays league management's correction (SPK-COMP-005)
    const backdated = await post(`/team-entries/${entry.teamEntryId}/roster`, official, {
      changes: [
        {
          action: 'add',
          personId: await createPersonFixture(t, { kind: 'adult' }),
          effectiveFrom: '2026-10-01T00:00:00.000Z',
        },
      ],
      reason: 'played last week',
    });
    expect(backdated.status).toBe(400);
    expect(backdated.body.details.code).toBe('retroactive_roster_change');
    const byManager = await post(`/team-entries/${entry.teamEntryId}/roster`, leagueManager, {
      changes: [{ action: 'add', personId: guest, status: 'guest' }],
    });
    expect(byManager.status).toBe(200);
    expect(byManager.body.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ personId: guest, source: 'staff' })]),
    );
  });

  it('SPK-CAP-002 / SPK-DISC-004: explain-eligibility stays redacted for a captain who is also an official; a member who is a scheduler gets the teammate view', async () => {
    const official = await staffMember(t, ['official']);
    const season = await createSeasonFixture(t, { status: 'open' });
    const u11 = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      criteria: { ageBand: { minAge: null, maxAge: 11 } },
    });
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: official.personId,
      divisionId: u11,
    });
    const tooOld = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2012-06-01' });
    suspended.add(tooOld);
    try {
      const asOfficialCaptain = await get(
        `/team-entries/${entry.teamEntryId}/eligibility`,
        official,
        { personId: tooOld },
      );
      expect(asOfficialCaptain.status).toBe(200);
      const age = asOfficialCaptain.body.reasons.find(
        (r: { code: string }) => r.code === 'above_division_age',
      );
      expect(age.message).toMatch(/^Above the division maximum age of 11 on /);
      expect(age.message).not.toMatch(/Age \d+/);
      expect(
        asOfficialCaptain.body.reasons.find((r: { code: string }) => r.code === 'suspended').source,
      ).toEqual({ type: 'suspension', id: null });

      const asManager = await get(`/team-entries/${entry.teamEntryId}/eligibility`, leagueManager, {
        personId: tooOld,
      });
      expect(
        asManager.body.reasons.find((r: { code: string }) => r.code === 'suspended').source,
      ).toEqual({ type: 'suspension', id: 'suspension-77' });
    } finally {
      suspended.delete(tooOld);
    }

    // a rostered scheduler is an ordinary member: no history, no explanations
    const scheduler = await staffMember(t, ['scheduler']);
    await addRosterMemberFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: scheduler.personId,
    });
    expect(
      (
        await get(`/team-entries/${entry.teamEntryId}/roster`, scheduler, {
          includeHistory: 'true',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await get(`/team-entries/${entry.teamEntryId}/eligibility`, scheduler, {
          personId: scheduler.personId,
        })
      ).status,
    ).toBe(404);
    expect((await get(`/team-entries/${entry.teamEntryId}/roster`, scheduler)).status).toBe(200);
  });

  it('§3.1 / SPK-CAP-001: a captain who is also a coach edits their team as its captain but cannot archive it', async () => {
    const coach = await staffMember(t, ['coach']);
    const season = await createSeasonFixture(t, { status: 'open' });
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: coach.personId,
    });
    const renamed = await t.http
      .patch(`/v1/teams/${entry.teamId}`)
      .set(coach.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Coached Captains', expectedRevision: 1 });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Coached Captains');
    const archived = await t.http
      .patch(`/v1/teams/${entry.teamId}`)
      .set(coach.header)
      .set('Idempotency-Key', key())
      .send({ status: 'archived', expectedRevision: renamed.body.revision });
    expect(archived.status).toBe(403);
  });

  it('§3.1 / SPK-DISC-002: a coach who is also a parent lists their child’s suspensions as the parent, not as discipline staff', async () => {
    const coach = await staffMember(t, ['coach']);
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: coach.personId,
      subjectPersonId: child,
      permissions: ['view', 'register'],
    });
    const own = await get('/suspensions', coach, { subjectPersonId: child });
    expect(own.status).toBe(200);
    expect(own.body).toEqual([]);
    // without a subject the restricted list is for discipline staff only
    expect((await get('/suspensions', coach)).status).toBe(400);
    const stranger = await createPersonFixture(t, { kind: 'child' });
    expect((await get('/suspensions', coach, { subjectPersonId: stranger })).status).toBe(404);
  });

  it('SPK-RESULT-005 / SPK-DISC-002: an official may not appeal a dispute outcome they neither submitted nor competed in', async () => {
    const official = await staffMember(t, ['official']);
    const season = await createSeasonFixture(t, { status: 'active' });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
    });
    const fixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
    });
    const now = t.clock.now();
    const disputeId = newId();
    await t.db
      .insertInto('disputes')
      .values({
        id: disputeId,
        organization_id: t.organizationId,
        fixture_id: fixtureId,
        submitting_team_entry_id: home.teamEntryId,
        submitting_role: 'captain',
        submitted_by: json({ kind: 'customer' }),
        submitted_at: now,
        submission_deadline_at: new Date(now.getTime() + 3600_000),
        reason: 'ineligible player',
        status: 'decided',
        decision: 'rejected',
        decided_at: now,
        decision_reason: 'not proven',
        publication_consequence: 'result_stands',
      })
      .execute();
    const res = await post('/appeals', official, {
      disputeId,
      grounds: 'I disagree with the decision.',
    });
    expect(res.status).toBe(404);
    const appeals = await t.db
      .selectFrom('appeals')
      .select('id')
      .where('dispute_id', '=', disputeId)
      .execute();
    expect(appeals).toEqual([]);
  });
});
