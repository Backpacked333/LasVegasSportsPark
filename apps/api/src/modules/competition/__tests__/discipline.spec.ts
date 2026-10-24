import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

interface Team {
  teamEntryId: string;
  captain: Actor;
}

describe('discipline and disputes (SPK-DISC-001..005, SPK-RESULT-005, SPK-AT-013)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let generalManager: Actor;
  let frontDesk: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let otherSeason: SeasonFixture;
  let divisionId: string;
  let player: Actor;
  let a: Team;
  let b: Team;
  let elsewhere: Team;

  async function teamOf(s: SeasonFixture, name: string, division: string | null): Promise<Team> {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: s.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId: division,
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    return { teamEntryId: entry.teamEntryId, captain };
  }

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    generalManager = await staffMember(t, ['general_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, { status: 'active' });
    otherSeason = await createSeasonFixture(t, { status: 'active' });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    player = await adultCustomer(t);
    a = await teamOf(season, 'Aces', divisionId);
    b = await teamOf(season, 'Bolts', divisionId);
    elsewhere = await teamOf(otherSeason, 'Elsewhere', null);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const patch = (path: string, actor: Actor, body: object) =>
    t.http.patch(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);
  const eligibility = (entryId: string, personId: string, actor: Actor, status = 'substitute') =>
    get(`/team-entries/${entryId}/eligibility?personId=${personId}&status=${status}`, actor);

  let suspensionId: string;

  it('SPK-AT-013 / SPK-DISC-002/003: a proposed suspension does not restrict; once approved it blocks the player as a substitute in the scoped competition only (never every program)', async () => {
    const byFrontDesk = await post('/suspensions', frontDesk, {
      subjectPersonId: player.personId,
      basis: 'violent conduct',
      terms: { scope: 'all', matchCount: 2, completionCriteria: 'two matches served' },
    });
    expect(byFrontDesk.status).toBe(403);
    const proposed = await post('/suspensions', leagueManager, {
      subjectPersonId: player.personId,
      basis: 'violent conduct (red card)',
      terms: {
        scope: 'competitions',
        competitionIds: [season.competitionId],
        matchCount: 2,
        completionCriteria: 'two competition matches of the subject team served',
      },
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      status: 'proposed',
      scope: 'competitions',
      competitionIds: [season.competitionId],
      matchCount: 2,
      matchesServed: 0,
      appealStatus: 'none',
      approvedAt: null,
    });
    suspensionId = proposed.body.id;
    const whileProposed = await eligibility(a.teamEntryId, player.personId, a.captain);
    expect(whileProposed.status).toBe(200);
    expect(whileProposed.body.eligible).toBe(true);

    const approved = await patch(`/suspensions/${suspensionId}`, leagueManager, {
      action: 'approve',
      expectedRevision: proposed.body.revision,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'active' });
    expect(approved.body.approvedBy.personId).toBe(leagueManager.personId);
    const stale = await patch(`/suspensions/${suspensionId}`, leagueManager, {
      action: 'approve',
      expectedRevision: proposed.body.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    // the captain tries to add the suspended player as a substitute (SPK-AT-013)
    const asSubstitute = await post(`/team-entries/${a.teamEntryId}/roster`, a.captain, {
      changes: [{ action: 'add', personId: player.personId, status: 'substitute' }],
    });
    expect(asSubstitute.status).toBe(422);
    expect(asSubstitute.body.code).toBe('ELIGIBILITY_FAILED');
    expect(asSubstitute.body.details.reasons.map((r: { code: string }) => r.code)).toContain(
      'suspended',
    );
    const reason = asSubstitute.body.details.reasons.find(
      (r: { code: string }) => r.code === 'suspended',
    );
    expect(reason).toMatchObject({
      severity: 'blocking',
      source: { type: 'suspension', id: suspensionId },
      responsibleRole: 'league_manager',
    });
    // staff cannot bypass it either
    const byStaff = await post(`/team-entries/${a.teamEntryId}/roster`, leagueManager, {
      changes: [{ action: 'add', personId: player.personId, status: 'guest' }],
    });
    expect(byStaff.status).toBe(422);
    // another competition is unaffected (SPK-DISC-002 "do not assume every suspension applies across every program")
    const otherCompetition = await eligibility(
      elsewhere.teamEntryId,
      player.personId,
      elsewhere.captain,
    );
    expect(otherCompetition.body.eligible).toBe(true);
    const added = await post(`/team-entries/${elsewhere.teamEntryId}/roster`, elsewhere.captain, {
      changes: [{ action: 'add', personId: player.personId, status: 'substitute' }],
    });
    expect(added.status).toBe(200);
  });

  it('SPK-DISC-002 completion criteria: published results serve a match-count suspension until it is served, after which the player is eligible again', async () => {
    // the player is on Bolts' roster (added before the suspension took effect) and Bolts play twice
    await addRosterMemberFixture(t, {
      teamEntryId: b.teamEntryId,
      personId: player.personId,
      effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    });
    const fixtureIds: string[] = [];
    for (const [date, home, away] of [
      ['2027-01-16', a, b],
      ['2027-01-23', b, a],
    ] as const) {
      const created = await post('/fixtures', leagueManager, {
        seasonId: season.seasonId,
        divisionId,
        homeEntryId: home.teamEntryId,
        awayEntryId: away.teamEntryId,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at(date, '18:00'),
          scheduledEnd: at(date, '19:00'),
        },
      });
      expect(created.status).toBe(201);
      fixtureIds.push(created.body.fixture.id);
    }
    for (const [index, fixtureId] of fixtureIds.entries()) {
      const submitted = await post(`/fixtures/${fixtureId}/results`, leagueManager, {
        classification: 'completed',
        homeScore: 1,
        awayScore: 0,
      });
      expect(submitted.status).toBe(201);
      const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
        expectedRevision: submitted.body.revision,
      });
      expect(published.status).toBe(200);
      const suspension = await get(`/suspensions/${suspensionId}`, leagueManager);
      expect(suspension.body).toMatchObject({
        matchesServed: index + 1,
        status: index === 1 ? 'served' : 'active',
      });
      expect(suspension.body.servedFixtureIds).toContain(fixtureId);
    }
    // the suspension no longer applies (the player now plays for Bolts in the same division, which
    // is the multi-team rule's concern, not discipline's)
    const afterwards = await eligibility(a.teamEntryId, player.personId, a.captain);
    expect(afterwards.body.reasons.map((r: { code: string }) => r.code)).not.toContain('suspended');
    const forBolts = await eligibility(b.teamEntryId, player.personId, b.captain, 'active');
    expect(forBolts.body.reasons.map((r: { code: string }) => r.code)).not.toContain('suspended');
    const list = await get(`/suspensions?subjectPersonId=${player.personId}`, leagueManager);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    // the subject reads their own suspension; a stranger cannot
    expect((await get(`/suspensions/${suspensionId}`, player)).status).toBe(200);
    expect((await get(`/suspensions/${suspensionId}`, await adultCustomer(t))).status).toBe(404);
    expect((await get(`/suspensions/${suspensionId}`, frontDesk)).status).toBe(404);
  });

  it('SPK-DISC-001/004/005: incidents are restricted records; the narrative is visible to league management only', async () => {
    const byCaptain = await post('/incidents', a.captain, {
      kind: 'complaint',
      severity: 'low',
      summary: 'Complaint about parking',
    });
    expect(byCaptain.status).toBe(403);
    const created = await post('/incidents', leagueManager, {
      kind: 'injury',
      subjectPersonId: player.personId,
      teamEntryId: b.teamEntryId,
      severity: 'high',
      summary: 'Player left the field after a collision',
      narrative:
        'Operational facts only: first aid called at 18:40, guardian informed. No diagnosis recorded.',
      evidence: [{ kind: 'report', reference: 'incident-form-17' }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'injury',
      status: 'open',
      narrative: expect.any(String),
    });
    const incidentId = created.body.id;
    expect((await get(`/incidents/${incidentId}`, generalManager)).status).toBe(200);
    expect((await get(`/incidents/${incidentId}`, frontDesk)).status).toBe(404);
    expect((await get(`/incidents/${incidentId}`, b.captain)).status).toBe(404);
    expect((await get(`/incidents/${incidentId}`, player)).status).toBe(404);
    expect((await get('/incidents', frontDesk)).status).toBe(403);
    const listed = await get(`/incidents?subjectPersonId=${player.personId}`, leagueManager);
    expect(listed.body.map((i: { id: string }) => i.id)).toContain(incidentId);
    // the audit trail carries identifiers and the safe summary, never the narrative (§4.14)
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', incidentId)
      .execute();
    expect(JSON.stringify(audit)).not.toContain('first aid');
    const reviewed = await patch(`/incidents/${incidentId}`, leagueManager, {
      action: 'review',
      expectedRevision: created.body.revision,
    });
    expect(reviewed.body.status).toBe('under_review');
    const closed = await patch(`/incidents/${incidentId}`, leagueManager, {
      action: 'close',
      expectedRevision: reviewed.body.revision,
      closureNote: 'Reported to the facility per procedure.',
    });
    expect(closed.body).toMatchObject({ status: 'closed', closureNote: expect.any(String) });
    expect(closed.body.closedAt).not.toBeNull();
    const reopen = await patch(`/incidents/${incidentId}`, leagueManager, {
      action: 'review',
      expectedRevision: closed.body.revision,
    });
    expect(reopen.status).toBe(409);
  });

  it('SPK-DISC-003: a decision applying the rule set proposes a suspension; overturning the decision ends it with history kept; appeals by the subject can overturn an active suspension', async () => {
    const other = await adultCustomer(t);
    const decision = await post('/disciplinary-decisions', leagueManager, {
      subjectPersonId: other.personId,
      ruleSetId: season.ruleSetId,
      basis: 'yellow card accumulation (rule set cards.yellowAccumulationThreshold)',
      decision: 'suspension',
      suspension: {
        scope: 'competitions',
        competitionIds: [season.competitionId],
        matchCount: 1,
        completionCriteria: 'one match served',
      },
      policyReferences: ['POL-029'],
    });
    expect(decision.status).toBe(201);
    expect(decision.body).toMatchObject({
      decision: 'suspension',
      status: 'issued',
      ruleSetId: season.ruleSetId,
    });
    expect(decision.body.suspensionId).toEqual(expect.any(String));
    const suspension = await get(`/suspensions/${decision.body.suspensionId}`, leagueManager);
    expect(suspension.body).toMatchObject({ status: 'proposed', decisionId: decision.body.id });
    const overturned = await post(
      `/disciplinary-decisions/${decision.body.id}/overturn`,
      generalManager,
      {
        expectedRevision: decision.body.revision,
        reason: 'The second yellow card was recorded against the wrong player.',
      },
    );
    expect(overturned.status).toBe(200);
    expect(overturned.body).toMatchObject({
      status: 'overturned',
      overturnReason: expect.any(String),
    });
    const ended = await get(`/suspensions/${decision.body.suspensionId}`, leagueManager);
    expect(ended.body).toMatchObject({ status: 'overturned', overturnReason: expect.any(String) });
    // the records remain readable history
    expect((await get(`/disciplinary-decisions/${decision.body.id}`, other)).status).toBe(200);

    // an appeal by the subject against an active suspension
    const active = await post('/suspensions', leagueManager, {
      subjectPersonId: other.personId,
      basis: 'dissent',
      terms: {
        scope: 'all',
        effectiveFrom: '2026-10-23T00:00:00.000Z',
        effectiveTo: '2026-11-23T00:00:00.000Z',
        completionCriteria: 'period elapses',
      },
    });
    const approved = await patch(`/suspensions/${active.body.id}`, leagueManager, {
      action: 'approve',
      expectedRevision: active.body.revision,
    });
    expect(approved.body.status).toBe('active');
    const strangerAppeal = await post('/appeals', await adultCustomer(t), {
      suspensionId: active.body.id,
      grounds: 'not mine',
    });
    expect(strangerAppeal.status).toBe(404);
    const appeal = await post('/appeals', other, {
      suspensionId: active.body.id,
      grounds: 'The referee report names a different player.',
      evidence: [{ kind: 'video', reference: 'clip-12' }],
    });
    expect(appeal.status).toBe(201);
    expect(appeal.body).toMatchObject({ status: 'submitted', subjectPersonId: other.personId });
    const duplicate = await post('/appeals', other, {
      suspensionId: active.body.id,
      grounds: 'again',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');
    expect((await get(`/suspensions/${active.body.id}`, other)).body.appealStatus).toBe('pending');
    const granted = await post(`/appeals/${appeal.body.id}/decide`, leagueManager, {
      action: 'grant',
      expectedRevision: appeal.body.revision,
      reason: 'Video confirms the mistaken identity.',
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ status: 'granted', decisionReason: expect.any(String) });
    const lifted = await get(`/suspensions/${active.body.id}`, leagueManager);
    expect(lifted.body).toMatchObject({ status: 'overturned', appealStatus: 'granted' });

    // SPK-DISC-002 "appeal status": an appeal against a decision shows on the suspension it
    // created; a withdrawn appeal leaves none pending; a denied one is recorded there
    const second = await post('/disciplinary-decisions', leagueManager, {
      subjectPersonId: other.personId,
      basis: 'violent conduct',
      decision: 'suspension',
      suspension: {
        scope: 'competitions',
        competitionIds: [season.competitionId],
        matchCount: 2,
        completionCriteria: 'two matches served',
      },
    });
    expect(second.status).toBe(201);
    const appealStatus = async () =>
      (await get(`/suspensions/${second.body.suspensionId}`, leagueManager)).body.appealStatus;
    const decisionAppeal = await post('/appeals', other, {
      decisionId: second.body.id,
      grounds: 'Self-defence.',
    });
    expect(decisionAppeal.status).toBe(201);
    expect(await appealStatus()).toBe('pending');
    const withdrawn = await post(`/appeals/${decisionAppeal.body.id}/decide`, leagueManager, {
      action: 'withdraw',
      expectedRevision: decisionAppeal.body.revision,
    });
    expect(withdrawn.body.status).toBe('withdrawn');
    expect(await appealStatus()).toBe('none');
    const renewed = await post('/appeals', other, {
      decisionId: second.body.id,
      grounds: 'Self-defence, with a witness statement.',
    });
    expect(renewed.status).toBe(201);
    const denied = await post(`/appeals/${renewed.body.id}/decide`, leagueManager, {
      action: 'deny',
      expectedRevision: renewed.body.revision,
      reason: 'The referee report stands.',
    });
    expect(denied.body.status).toBe('denied');
    expect(await appealStatus()).toBe('denied');
    expect(
      (await get(`/disciplinary-decisions/${second.body.id}`, leagueManager)).body.status,
    ).toBe('issued');
  });

  it('SPK-RESULT-005: a captain of a competing entry disputes within the protest window; the reviewer decides with a publication consequence; outsiders and late disputes are refused', async () => {
    const fixture = await t.db
      .selectFrom('fixtures')
      .select('id')
      .where('season_id', '=', season.seasonId)
      .where('status', '=', 'played')
      .orderBy('scheduled_start')
      .executeTakeFirstOrThrow();
    const stranger = await teamOf(season, 'Strangers', divisionId);
    const byStranger = await post(`/fixtures/${fixture.id}/disputes`, stranger.captain, {
      teamEntryId: stranger.teamEntryId,
      reason: 'not our game',
    });
    expect(byStranger.status).toBe(404);
    const byFrontDesk = await post(`/fixtures/${fixture.id}/disputes`, frontDesk, { reason: 'x' });
    expect(byFrontDesk.status).toBe(403);
    const dispute = await post(`/fixtures/${fixture.id}/disputes`, b.captain, {
      teamEntryId: b.teamEntryId,
      reason: 'The home team fielded an ineligible player.',
      evidence: [{ kind: 'photo', reference: 'team-sheet-3' }],
    });
    expect(dispute.status).toBe(201);
    expect(dispute.body).toMatchObject({
      fixtureId: fixture.id,
      submittingTeamEntryId: b.teamEntryId,
      submittingRole: 'captain',
      status: 'submitted',
      resultRevisionId: expect.any(String),
      appealStatus: 'none',
    });
    const official = await t.db
      .selectFrom('result_revisions')
      .select('published_at')
      .where('id', '=', dispute.body.resultRevisionId)
      .executeTakeFirstOrThrow();
    expect(new Date(dispute.body.submissionDeadlineAt).getTime()).toBe(
      new Date(official.published_at ?? 0).getTime() +
        season.ruleSet.protestDeadlineHours * 3600_000,
    );
    expect((await get(`/disputes/${dispute.body.id}`, b.captain)).status).toBe(200);
    expect((await get(`/disputes/${dispute.body.id}`, a.captain)).status).toBe(404);
    expect((await get(`/fixtures/${fixture.id}/disputes`, leagueManager)).body).toHaveLength(1);
    // readiness lists the pending dispute as a warning on the fixture
    const reviewing = await post(`/disputes/${dispute.body.id}/decide`, leagueManager, {
      action: 'review',
      expectedRevision: dispute.body.revision,
    });
    expect(reviewing.body.status).toBe('under_review');
    const decided = await post(`/disputes/${dispute.body.id}/decide`, leagueManager, {
      action: 'decide',
      expectedRevision: reviewing.body.revision,
      decision: 'upheld',
      publicationConsequence: 'correction_required',
      reason: 'The player was suspended for this competition.',
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({
      status: 'decided',
      decision: 'upheld',
      publicationConsequence: 'correction_required',
    });
    expect(decided.body.reviewer.personId).toBe(leagueManager.personId);
    // the official result itself is untouched: the consequence is carried out by a correction revision
    const stillOfficial = await t.db
      .selectFrom('result_revisions')
      .select('status')
      .where('id', '=', dispute.body.resultRevisionId)
      .executeTakeFirstOrThrow();
    expect(stillOfficial.status).toBe('official');
    // the captain of the other competing entry appeals the dispute outcome; outsiders cannot
    const outsider = await post('/appeals', stranger.captain, {
      disputeId: dispute.body.id,
      grounds: 'not involved',
    });
    expect(outsider.status).toBe(404);
    const appeal = await post('/appeals', a.captain, {
      disputeId: dispute.body.id,
      grounds: 'The player had served the suspension.',
    });
    expect(appeal.status).toBe(201);
    expect(appeal.body.subjectPersonId).toBe(a.captain.personId);
    expect((await get(`/disputes/${dispute.body.id}`, leagueManager)).body.appealStatus).toBe(
      'pending',
    );

    t.clock.advance((season.ruleSet.protestDeadlineHours + 1) * 3600_000);
    const late = await post(`/fixtures/${fixture.id}/disputes`, a.captain, {
      teamEntryId: a.teamEntryId,
      reason: 'too late',
    });
    expect(late.status).toBe(400);
    expect(late.body.details.code).toBe('protest_window_closed');
  });
});
