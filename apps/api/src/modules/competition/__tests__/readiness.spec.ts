import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  ClosuresService,
  EventsService,
  at,
  createAppliedClosure,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { READINESS_CHECK_REGISTRY, type ReadinessCheckRegistry } from '../ports';
import { createSuspensionFixture } from '../testing/competition-matches-fixtures';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

interface Team {
  teamEntryId: string;
  captain: Actor;
  players: Actor[];
}

describe('match readiness (SPK-READY-001..004, §4.8 GET /fixtures/{id}/readiness)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let home: Team;
  let away: Team;
  let thin: Team;

  async function teamOf(name: string, players: number): Promise<Team> {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId,
    });
    const roster: Actor[] = [];
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    for (let i = 1; i < players; i += 1) {
      const player = await adultCustomer(t);
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: player.personId,
      });
      roster.push(player);
    }
    return { teamEntryId: entry.teamEntryId, captain, players: roster };
  }

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, { status: 'active' });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    const minimum = season.ruleSet.minimumPlayers;
    home = await teamOf('Home', minimum + 1);
    away = await teamOf('Away', minimum);
    thin = await teamOf('Thin', Math.max(1, minimum - 2));
  });
  afterAll(async () => {
    await t.close();
  });

  const readiness = (fixtureId: string, actor: Actor) =>
    t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(actor.header);
  const codes = (body: { issues: Array<{ code: string; severity: string }> }) =>
    Object.fromEntries(body.issues.map((i) => [i.code, i.severity]));

  async function scheduled(h: Team, a: Team, date: string, from = '18:00', to = '19:00') {
    const res = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        divisionId,
        homeEntryId: h.teamEntryId,
        awayEntryId: a.teamEntryId,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at(date, from),
          scheduledEnd: at(date, to),
        },
      });
    expect(res.status).toBe(201);
    return res.body.fixture.id as string;
  }

  it('SPK-READY-002: an unscheduled fixture is blocked by the missing publication, while unknown evidence (officials, forms, finance) stays unknown and a missing RSVP is informational', async () => {
    const fixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
    });
    const res = await readiness(fixtureId, leagueManager);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('blocked');
    expect(res.body.fixtureStatus).toBe('unscheduled');
    const severities = codes(res.body);
    expect(severities).toMatchObject({
      not_scheduled: 'blocking',
      officials_unknown: 'unknown',
      required_forms_unknown: 'unknown',
      financial_conditions_unknown: 'unknown',
      rsvp_missing: 'info',
    });
    // SPK-READY-003: every issue names reason, source, responsible role, action and evaluation
    for (const issue of res.body.issues) {
      expect(issue).toMatchObject({
        message: expect.any(String),
        source: { type: expect.any(String) },
        responsibleRole: expect.any(String),
        requiredAction: expect.any(String),
        lastEvaluatedAt: res.body.evaluatedAt,
      });
    }
    expect(res.body.checks.find((c: { name: string }) => c.name === 'schedule')).toMatchObject({
      status: 'blocked',
    });
    expect(res.body.checks.find((c: { name: string }) => c.name === 'availability')).toMatchObject({
      status: 'ready',
    });
    expect(res.body.sides).toHaveLength(2);
    expect(res.body.sides[0]).toMatchObject({
      teamEntryId: home.teamEntryId,
      entryStatus: 'approved',
      rosterSize: season.ruleSet.minimumPlayers + 1,
      eligiblePlayers: season.ruleSet.minimumPlayers + 1,
      minimumPlayers: season.ruleSet.minimumPlayers,
    });
  });

  it('SPK-READY-001/004: a published fixture with approved entries and enough eligible players is unknown (not ready, not blocked) until the registered authorities report; nothing is stored or editable', async () => {
    const fixtureId = await scheduled(home, away, '2027-01-16');
    const res = await readiness(fixtureId, leagueManager);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.scheduledStart).toBe(at('2027-01-16', '18:00'));
    const severities = codes(res.body);
    expect(Object.values(severities)).not.toContain('blocking');
    expect(severities).toMatchObject({
      officials_unknown: 'unknown',
      required_forms_unknown: 'unknown',
      financial_conditions_unknown: 'unknown',
      rsvp_missing: 'info',
    });
    expect(
      res.body.issues.find((i: { code: string }) => i.code === 'officials_unknown').deadline,
    ).toBe(at('2027-01-16', '18:00'));
    // derived on read: a second read evaluates again with the current clock, no cached row exists
    t.clock.advance(60_000);
    const later = await readiness(fixtureId, leagueManager);
    expect(later.body.evaluatedAt).not.toBe(res.body.evaluatedAt);
    expect(later.body.issues.map((i: { code: string }) => i.code)).toEqual(
      res.body.issues.map((i: { code: string }) => i.code),
    );
    // the responding players make the RSVP note disappear while nothing else changes
    for (const player of [home.captain, ...home.players, away.captain, ...away.players]) {
      await t.http
        .post(`/v1/fixtures/${fixtureId}/availability`)
        .set(player.header)
        .set('Idempotency-Key', key())
        .send({ state: 'available' });
    }
    const responded = await readiness(fixtureId, leagueManager);
    expect(codes(responded.body)).not.toHaveProperty('rsvp_missing');
    expect(responded.body.status).toBe('unknown');
  });

  it('SPK-READY-002 / SPK-READY-004: when the scheduling event moved and the fixture copy has not caught up, readiness says the schedule evidence is stale and evaluates at the event time', async () => {
    const fixtureId = await scheduled(home, away, '2027-01-30');
    const fixture = await t.http.get(`/v1/fixtures/${fixtureId}`).set(leagueManager.header);
    const eventId = fixture.body.schedulingEventId as string;
    const inSync = await readiness(fixtureId, leagueManager);
    expect(codes(inSync.body)).not.toHaveProperty('schedule_out_of_sync');
    // the scheduler moves the event directly; the competition follow-up has not run yet
    const events = t.app.get(EventsService);
    const moved = await events.moveEvent(systemPrincipal(t.organizationId, 'test'), eventId, {
      scheduledStart: at('2027-01-31', '10:00'),
      scheduledEnd: at('2027-01-31', '11:00'),
      expectedRevision: (await events.getEvent(systemPrincipal(t.organizationId, 'test'), eventId))
        .revision,
    });
    expect(
      (await t.http.get(`/v1/fixtures/${fixtureId}`).set(leagueManager.header)).body.scheduledStart,
    ).toBe(at('2027-01-30', '18:00'));
    const stale = await readiness(fixtureId, leagueManager);
    expect(stale.status).toBe(200);
    expect(stale.body.status).not.toBe('ready');
    expect(stale.body.scheduledStart).toBe(moved.scheduledStart);
    const issue = stale.body.issues.find(
      (i: { code: string }) => i.code === 'schedule_out_of_sync',
    );
    expect(issue).toMatchObject({
      severity: 'unknown',
      source: { type: 'event', id: eventId },
      deadline: moved.scheduledStart,
    });
    expect(stale.body.checks.find((c: { name: string }) => c.name === 'schedule')).toMatchObject({
      status: 'unknown',
    });
  });

  it('a registered readiness check replaces the unknown officials verdict; its blocking issue blocks the fixture; the minimum roster is a blocking condition', async () => {
    const fixtureId = await scheduled(home, thin, '2027-01-23');
    const before = await readiness(fixtureId, leagueManager);
    expect(before.body.status).toBe('blocked');
    expect(codes(before.body)).toMatchObject({
      insufficient_eligible_roster: 'blocking',
      officials_unknown: 'unknown',
    });
    expect(before.body.sides[1]).toMatchObject({
      teamEntryId: thin.teamEntryId,
      eligiblePlayers: Math.max(1, season.ruleSet.minimumPlayers - 2),
    });

    const registry = t.app.get<ReadinessCheckRegistry>(READINESS_CHECK_REGISTRY);
    let blocking = true;
    registry.registerCheck('workforce.officials', async ({ fixtureId: id }) =>
      blocking
        ? [
            {
              code: 'official_not_accepted',
              severity: 'blocking',
              message: 'No official has accepted this fixture.',
              source: { type: 'assignment', id: null },
              responsibleRole: 'league_manager',
              requiredAction: 'Offer the assignment and obtain acceptance.',
              deadline: id ? null : null,
            },
          ]
        : [],
    );
    const withCheck = await readiness(fixtureId, leagueManager);
    expect(codes(withCheck.body)).not.toHaveProperty('officials_unknown');
    expect(codes(withCheck.body)).toMatchObject({ official_not_accepted: 'blocking' });
    expect(
      withCheck.body.checks.find((c: { name: string }) => c.name === 'workforce.officials'),
    ).toMatchObject({ status: 'blocked', issueCount: 1 });
    blocking = false;
    const accepted = await readiness(fixtureId, leagueManager);
    expect(codes(accepted.body)).not.toHaveProperty('official_not_accepted');
    expect(
      accepted.body.checks.find((c: { name: string }) => c.name === 'workforce.officials'),
    ).toMatchObject({ status: 'ready', issueCount: 0 });
  });

  it('field operational status comes from scheduling closures: an applied closure over the game blocks it', async () => {
    const fixtureId = await scheduled(home, away, '2027-01-30');
    const closures = t.app.get(ClosuresService);
    await createAppliedClosure(closures, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceId: pitch.pitchId,
      start: at('2027-01-30', '12:00'),
      end: at('2027-01-30', '22:00'),
      reason: 'Turf repair',
      mode: 'leave_for_resolution',
    });
    const res = await readiness(fixtureId, leagueManager);
    expect(res.body.status).toBe('blocked');
    const closed = res.body.issues.find((i: { code: string }) => i.code === 'field_closed');
    expect(closed).toMatchObject({
      severity: 'blocking',
      source: { type: 'closure', id: expect.any(String) },
      responsibleRole: 'scheduler',
    });
  });

  it('SPK-READY-002/003 / SPK-DISC-004: a check that cannot answer is unknown, never a pass; a pending suspension is unknown with its source for staff, while customers see the issue without the restricted record id', async () => {
    const fixtureId = await scheduled(home, away, '2027-02-13');
    const registry = t.app.get<ReadinessCheckRegistry>(READINESS_CHECK_REGISTRY);
    registry.registerCheck('facilities.lighting', async () => {
      throw new Error('lighting controller offline');
    });
    const suspensionId = await createSuspensionFixture(t, {
      subjectPersonId: (home.players[0] as Actor).personId,
      status: 'proposed',
      scope: 'competitions',
      competitionIds: [season.competitionId],
      matchCount: 1,
    });
    const staff = await readiness(fixtureId, leagueManager);
    expect(staff.status).toBe(200);
    const lighting = staff.body.issues.find(
      (i: { code: string }) => i.code === 'check_unavailable',
    );
    expect(lighting).toMatchObject({
      severity: 'unknown',
      source: { type: 'readiness_check', id: 'facilities.lighting' },
    });
    expect(
      staff.body.checks.find((c: { name: string }) => c.name === 'facilities.lighting'),
    ).toMatchObject({ status: 'unknown', issueCount: 1 });
    const pending = staff.body.issues.find(
      (i: { code: string }) => i.code === 'suspension_pending_approval',
    );
    // SPK-READY-003: reason, source record, responsible role, required action, last evaluation, deadline
    expect(pending).toEqual({
      code: 'suspension_pending_approval',
      severity: 'unknown',
      message: expect.any(String),
      source: { type: 'suspension', id: suspensionId },
      responsibleRole: 'league_manager',
      requiredAction: expect.any(String),
      lastEvaluatedAt: staff.body.evaluatedAt,
      deadline: staff.body.scheduledStart,
    });
    // readiness is derived on read: nothing is stored for the fixture (SPK-READY-004)
    expect(staff.body.status).not.toBe('ready');
    const asPlayer = await readiness(fixtureId, away.players[0] as Actor);
    expect(asPlayer.status).toBe(200);
    const redacted = asPlayer.body.issues.find(
      (i: { code: string }) => i.code === 'suspension_pending_approval',
    );
    expect(redacted.source).toEqual({ type: 'suspension', id: null });
    expect(JSON.stringify(asPlayer.body)).not.toContain(suspensionId);
  });

  it('§4.10: roster players and captains read readiness; outsiders get NOT_FOUND', async () => {
    const fixtureId = await scheduled(away, home, '2027-02-06');
    expect((await readiness(fixtureId, home.captain)).status).toBe(200);
    expect((await readiness(fixtureId, away.players[0] as Actor)).status).toBe(200);
    expect((await readiness(fixtureId, await adultCustomer(t))).status).toBe(404);
  });
});
