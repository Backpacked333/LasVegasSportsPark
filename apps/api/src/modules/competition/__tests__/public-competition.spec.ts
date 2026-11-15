import { newId } from '@sportspark/contracts';
import { isCheckViolation, isUniqueViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOutboxChecked, setCapability, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { seedResource } from '../../scheduling';
import { divisionAudience, minorWording, publicationBlockers } from '../public/publication-rule';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import {
  createBracketNodeFixture,
  createResultRevisionFixture,
} from '../testing/competition-matches-fixtures';
import { competitionTestApp, key, staffMember, type Actor } from './support';

type Json = Record<string, unknown>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOUR = 3_600_000;
const ADULTS = { ageBand: { minAge: 18, maxAge: null } };

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      into.add(name);
      keysOf(inner, into);
    }
  }
  return into;
}

const answerOf = (res: { status: number; body: Json; headers: Record<string, string> }) => ({
  status: res.status,
  code: res.body['code'],
  message: res.body['message'],
  details: res.body['details'],
  cache: res.headers['cache-control'],
});
const NOT_AVAILABLE = {
  status: 404,
  code: 'NOT_FOUND',
  message: 'This view is not available.',
  details: { code: 'PUBLIC_VIEW_NOT_AVAILABLE' },
  cache: 'no-store',
};

/**
 * Public competition views (SPK-SCHED-010, proposed amendment PA-06; capability `public_schedule`;
 * ADR-005). The values an operator has not decided (DEC-100) are the proposed defaults: a
 * competition is private until staff publish it, and it can be published only when every division
 * of its seasons is positively known to be an adult division (the rule fails closed; security
 * review M-2).
 */
describe('public competition views (SPK-SCHED-010)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  const slug = 'desert-park';
  const people = { captain: 'Marisol', family: 'Quintanilla', player: 'Bartholomew' };

  beforeAll(async () => {
    t = await competitionTestApp({
      capabilities: ['public_schedule'],
      clockStart: '2026-11-02T17:00:00Z',
    });
    await t.db
      .updateTable('organizations')
      .set({ slug, name: 'Desert Park' })
      .where('id', '=', t.organizationId)
      .execute();
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);
  const anonymous = (path: string) => t.http.get(`/v1/public/${path}`);

  /** A league season with one adult division, two approved teams and one game on a field. */
  async function league(name: string, start: Date) {
    const competitionId = await createCompetitionFixture(t, { name, status: 'active' });
    const season = await createSeasonFixture(t, {
      competitionId,
      name: `${name} winter`,
      status: 'active',
    });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Open',
      criteria: ADULTS,
    });
    const captainId = await createPersonFixture(t, {
      kind: 'adult',
      givenName: people.captain,
      familyName: people.family,
    });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainId,
      teamName: `${name} Comets`,
      divisionId,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
      teamName: `${name} Rockets`,
      divisionId,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: home.teamEntryId,
      personId: await createPersonFixture(t, { kind: 'adult', givenName: people.player }),
    });
    const field = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: `${name} field`,
    });
    const game = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      round: 1,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [field.resourceId],
        scheduledStart: start.toISOString(),
        scheduledEnd: new Date(start.getTime() + HOUR).toISOString(),
      },
    });
    expect(game.status, JSON.stringify(game.body)).toBe(201);
    const fixtureId = game.body.fixture.id as string;
    // The fixture's venue (zone and field names) follows its scheduling event through the outbox.
    await drainOutboxChecked(t);
    await createResultRevisionFixture(t, { fixtureId, homeScore: 5, awayScore: 3 });
    return { competitionId, seasonId: season.seasonId, divisionId, home, away, fixtureId, start };
  }

  const publish = async (competitionId: string) => {
    const before = await get(`/competitions/${competitionId}/publication`, leagueManager);
    return post(`/competitions/${competitionId}/publish`, leagueManager, {
      expectedRevision: before.body.revision,
    });
  };

  it('SPK-SCHED-010: fixtures, results and standings of a competition the operator has made public are read without sign-in; it is private until then', async () => {
    const start = new Date('2026-11-17T03:00:00Z');
    const data = await league('Monday', start);
    const before = await get(`/competitions/${data.competitionId}/publication`, leagueManager);
    expect(before.body).toMatchObject({
      visibility: 'private',
      publicCode: null,
      organizationSlug: slug,
      blockers: [],
      minorDivisions: [],
      seasons: [{ seasonId: data.seasonId, hasDivisions: true }],
    });
    const published = await publish(data.competitionId);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ visibility: 'public', changedAt: expect.any(String) });
    const code = published.body.publicCode as string;
    const seasonCode = published.body.seasons[0].publicCode as string;
    expect(code).toMatch(/^[a-z0-9]{24}$/);
    expect(seasonCode).toMatch(/^[a-z0-9]{24}$/);
    expect(seasonCode).not.toBe(code);

    const competition = await anonymous(`${slug}/competitions/${code}`);
    expect(competition.status, JSON.stringify(competition.body)).toBe(200);
    expect(competition.headers['cache-control']).toBe('public, max-age=30');
    expect(competition.body).toMatchObject({
      organizationName: 'Desert Park',
      name: 'Monday',
      kind: 'league',
      seasons: [{ code: seasonCode, name: 'Monday winter' }],
      computedAt: t.clock.now().toISOString(),
      cacheSeconds: 30,
    });

    const season = await anonymous(`${slug}/seasons/${seasonCode}`);
    expect(season.status, JSON.stringify(season.body)).toBe(200);
    expect(season.headers['cache-control']).toBe('public, max-age=30');
    expect(season.body).toMatchObject({
      competitionName: 'Monday',
      competitionKind: 'league',
      seasonName: 'Monday winter',
      bracket: null,
      otherFixtures: [],
      computedAt: t.clock.now().toISOString(),
    });
    expect(season.body.divisions).toEqual([
      {
        name: 'Open',
        fixtures: [
          {
            round: 1,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + HOUR).toISOString(),
            timezone: 'America/Los_Angeles',
            fields: ['Monday field'],
            status: 'scheduled',
            home: 'Monday Comets',
            away: 'Monday Rockets',
            score: { home: 5, away: 3 },
          },
        ],
        standings: [
          {
            position: 1,
            team: 'Monday Comets',
            played: 1,
            won: 1,
            drawn: 0,
            lost: 0,
            goalsFor: 5,
            goalsAgainst: 3,
            goalDifference: 2,
            points: 3,
          },
          {
            position: 2,
            team: 'Monday Rockets',
            played: 1,
            won: 0,
            drawn: 0,
            lost: 1,
            goalsFor: 3,
            goalsAgainst: 5,
            goalDifference: -2,
            points: 0,
          },
        ],
      },
    ]);

    // The staff standings route still needs sign-in.
    const staffRoute = `/v1/seasons/${data.seasonId}/standings?divisionId=${data.divisionId}`;
    expect((await t.http.get(staffRoute)).status).toBe(401);

    // No field for a person, a contact or an internal id: every key of both answers, exhaustively.
    expect([...keysOf(season.body)].sort()).toEqual(
      [
        'away',
        'bracket',
        'cacheSeconds',
        'competitionKind',
        'competitionName',
        'computedAt',
        'divisions',
        'drawn',
        'endsAt',
        'endsOn',
        'fields',
        'fixtures',
        'goalDifference',
        'goalsAgainst',
        'goalsFor',
        'home',
        'lost',
        'name',
        'organizationName',
        'otherFixtures',
        'played',
        'points',
        'position',
        'round',
        'score',
        'seasonName',
        'sportFormat',
        'standings',
        'startsAt',
        'startsOn',
        'status',
        'team',
        'timezone',
        'won',
      ].sort(),
    );
    expect([...keysOf(competition.body)].sort()).toEqual(
      [
        'cacheSeconds',
        'code',
        'computedAt',
        'endsOn',
        'kind',
        'name',
        'organizationName',
        'seasons',
        'sportFormat',
        'startsOn',
      ].sort(),
    );
    const text = JSON.stringify([season.body, competition.body]);
    expect(text).not.toMatch(UUID);
    for (const secret of [
      ...Object.values(people),
      data.competitionId,
      data.seasonId,
      data.fixtureId,
      data.home.teamEntryId,
      data.home.teamId,
    ]) {
      expect(text).not.toContain(secret);
    }

    // Private again: the same links answer "not available"; publishing again restores them.
    const unpublished = await post(`/competitions/${data.competitionId}/unpublish`, leagueManager, {
      expectedRevision: published.body.revision,
    });
    expect(unpublished.body).toMatchObject({ visibility: 'private', publicCode: code });
    expect(answerOf(await anonymous(`${slug}/seasons/${seasonCode}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`${slug}/competitions/${code}`))).toEqual(NOT_AVAILABLE);
    const again = await publish(data.competitionId);
    expect(again.body).toMatchObject({ visibility: 'public', publicCode: code });
    expect((await anonymous(`${slug}/seasons/${seasonCode}`)).status).toBe(200);
  });

  it('SPK-SCHED-010: on the facility schedule a game shows team names and score only when its competition is public; otherwise it reads "League game"', async () => {
    const day = '2026-11-18';
    const open = await league('Tuesday', new Date('2026-11-19T03:00:00Z'));
    const closed = await league('Wednesday', new Date('2026-11-19T05:00:00Z'));
    await publish(open.competitionId);
    const scheduler = await staffMember(t, ['scheduler']);
    const enabled = await post(
      `/facilities/${t.facilityId}/public-schedule-view/enable`,
      scheduler,
    );
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    const schedule = await anonymous(`${slug}/schedule/${enabled.body.publicCode}?date=${day}`);
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    expect(schedule.body.entries).toEqual([
      {
        startsAt: open.start.toISOString(),
        endsAt: new Date(open.start.getTime() + HOUR).toISOString(),
        fields: ['Tuesday field'],
        kind: 'game',
        title: 'Tuesday Comets vs Tuesday Rockets',
        score: { home: 5, away: 3 },
      },
      {
        startsAt: closed.start.toISOString(),
        endsAt: new Date(closed.start.getTime() + HOUR).toISOString(),
        fields: ['Wednesday field'],
        kind: 'game',
        title: 'League game',
        score: null,
      },
    ]);
    const text = JSON.stringify(schedule.body);
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain('Wednesday Comets');
    for (const name of Object.values(people)) expect(text).not.toContain(name);
  });

  it('SPK-SCHED-010: the directory of an organization lists only what it has made public, by name and public code', async () => {
    const before = await anonymous(`${slug}/directory`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const shown = await league('Sunday', new Date('2026-11-23T03:00:00Z'));
    const hidden = await league('Hidden', new Date('2026-11-23T05:00:00Z'));
    const published = await publish(shown.competitionId);
    const directory = await anonymous(`${slug}/directory`);
    expect(directory.status).toBe(200);
    expect(directory.headers['cache-control']).toBe('public, max-age=30');
    expect(directory.body.organizationName).toBe('Desert Park');
    expect(directory.body.competitions).toContainEqual({
      name: 'Sunday',
      kind: 'league',
      code: published.body.publicCode,
    });
    const text = JSON.stringify(directory.body);
    expect(text).not.toContain('Hidden');
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain(hidden.competitionId);
    expect([...keysOf(directory.body)].sort()).toEqual(
      [
        'cacheSeconds',
        'code',
        'competitions',
        'computedAt',
        'facilityName',
        'kind',
        'name',
        'organizationName',
        'schedules',
      ].sort(),
    );
    // A facility appears once its public schedule is enabled.
    for (const schedule of directory.body.schedules as Json[]) {
      expect(schedule).toEqual({ facilityName: 'Main complex', code: expect.any(String) });
    }
    expect(answerOf(await anonymous('nowhere/directory'))).toEqual(NOT_AVAILABLE);
    await setCapability(t.db, t.organizationId, 'public_schedule', false);
    try {
      expect(answerOf(await anonymous(`${slug}/directory`))).toEqual(NOT_AVAILABLE);
    } finally {
      await setCapability(t.db, t.organizationId, 'public_schedule', true);
    }
  });

  it('SPK-SCHED-010: an unknown organization, an unknown code, a record id used as a code, a private competition and the capability turned off all answer the same "not available"', async () => {
    const data = await league('Thursday', new Date('2026-11-21T03:00:00Z'));
    // Before the competition is published this season has no code at all.
    const privateSeason = await t.db
      .selectFrom('seasons')
      .select('public_code')
      .where('id', '=', data.seasonId)
      .executeTakeFirstOrThrow();
    const published = await publish(data.competitionId);
    const code = published.body.publicCode as string;
    const seasonCode = published.body.seasons[0].publicCode as string;
    expect(privateSeason.public_code).toBeNull();

    expect(answerOf(await anonymous(`nowhere/competitions/${code}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`nowhere/seasons/${seasonCode}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`${slug}/competitions/${'0'.repeat(24)}`))).toEqual(
      NOT_AVAILABLE,
    );
    expect(answerOf(await anonymous(`${slug}/seasons/${'0'.repeat(24)}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`${slug}/competitions/${data.competitionId}`))).toEqual(
      NOT_AVAILABLE,
    );
    expect(answerOf(await anonymous(`${slug}/seasons/${data.seasonId}`))).toEqual(NOT_AVAILABLE);
    // A season code is not a competition code and the reverse.
    expect(answerOf(await anonymous(`${slug}/competitions/${seasonCode}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`${slug}/seasons/${code}`))).toEqual(NOT_AVAILABLE);

    await setCapability(t.db, t.organizationId, 'public_schedule', false);
    try {
      expect(answerOf(await anonymous(`${slug}/competitions/${code}`))).toEqual(NOT_AVAILABLE);
      expect(answerOf(await anonymous(`${slug}/seasons/${seasonCode}`))).toEqual(NOT_AVAILABLE);
      // Publishing is refused while the switch is off; taking a competition private is not.
      const other = await createCompetitionFixture(t, { status: 'active' });
      const refused = await publish(other);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'CAPABILITY_DISABLED', capability: 'public_schedule' },
      });
      const down = await post(`/competitions/${data.competitionId}/unpublish`, leagueManager, {
        expectedRevision: published.body.revision,
      });
      expect(down.status, JSON.stringify(down.body)).toBe(200);
      expect(down.body.visibility).toBe('private');
    } finally {
      await setCapability(t.db, t.organizationId, 'public_schedule', true);
    }
    expect(answerOf(await anonymous(`${slug}/seasons/${seasonCode}`))).toEqual(NOT_AVAILABLE);
  });

  it("SPK-SCHED-010: publishing is refused when a division's criteria describe players under 18, and a public competition that gains one is no longer shown", async () => {
    const youth = await createCompetitionFixture(t, { name: 'Saturday youth', status: 'active' });
    const season = await createSeasonFixture(t, { competitionId: youth, status: 'active' });
    await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Under 12',
      criteria: { ageBand: { minAge: 10, maxAge: 12 } },
    });
    const refused = await publish(youth);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        code: 'COMPETITION_NOT_KNOWN_ADULT',
        divisions: [{ divisionName: 'Under 12' }],
      },
    });
    const state = await get(`/competitions/${youth}/publication`, leagueManager);
    expect(state.body).toMatchObject({
      visibility: 'private',
      minorDivisions: [{ divisionName: 'Under 12' }],
    });
    // Every reason is named, in a fixed order: the competition's own name, then the division's
    // age band, then the division's name.
    expect(
      state.body.blockers.map((b: Json) => [b['scope'], b['reason'], b['divisionName']]),
    ).toEqual([
      ['competition', 'name_suggests_minors', null],
      ['division', 'under_18', 'Under 12'],
      ['division', 'name_suggests_minors', 'Under 12'],
    ]);
    expect(refused.body.details.blockers).toEqual(state.body.blockers);
    // Only league management publishes.
    const frontDesk = await staffMember(t, ['front_desk']);
    const byFrontDesk = await post(`/competitions/${youth}/publish`, frontDesk, {
      expectedRevision: state.body.revision,
    });
    expect(byFrontDesk.status).toBe(403);

    // A public adult competition that later gains a youth division fails closed at every read.
    const data = await league('Friday', new Date('2026-11-22T03:00:00Z'));
    const published = await publish(data.competitionId);
    const seasonCode = published.body.seasons[0].publicCode as string;
    expect((await anonymous(`${slug}/seasons/${seasonCode}`)).status).toBe(200);
    await createDivisionFixture(t, {
      seasonId: data.seasonId,
      name: 'Girls U14',
      criteria: {},
    });
    expect(answerOf(await anonymous(`${slug}/seasons/${seasonCode}`))).toEqual(NOT_AVAILABLE);
    expect(answerOf(await anonymous(`${slug}/competitions/${published.body.publicCode}`))).toEqual(
      NOT_AVAILABLE,
    );
  });

  it('SPK-SCHED-010: publishing is allowed only when every division is positively known to be an adult division; a division that states no minimum age refuses it, with what to set', async () => {
    const competitionId = await createCompetitionFixture(t, { name: 'Aurora', status: 'active' });
    // No division at all: nothing says who plays.
    const empty = await publish(competitionId);
    expect(empty.status).toBe(400);
    expect(empty.body.details).toMatchObject({
      code: 'COMPETITION_NOT_KNOWN_ADULT',
      blockers: [{ scope: 'competition', reason: 'no_divisions' }],
    });
    const season = await createSeasonFixture(t, {
      competitionId,
      name: 'Aurora winter',
      status: 'active',
    });
    // Neutral names and no age information: under the old rule this published.
    const gold = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Gold' });
    const silver = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Silver',
      criteria: { ageBand: { minAge: null, maxAge: 40 } },
    });
    const bronze = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Bronze',
      criteria: ADULTS,
    });
    const refused = await publish(competitionId);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(refused.body.message).toMatch(/minimum age of 18 or more/);
    expect(refused.body.details.blockers).toEqual([
      {
        scope: 'division',
        reason: 'age_not_stated',
        seasonName: 'Aurora winter',
        divisionName: 'Gold',
        message:
          'Division "Gold" (Aurora winter) does not say its players are adults. Set its age band with a minimum age of 18 or more.',
      },
      {
        scope: 'division',
        reason: 'age_not_stated',
        seasonName: 'Aurora winter',
        divisionName: 'Silver',
        message:
          'Division "Silver" (Aurora winter) does not say its players are adults. Set its age band with a minimum age of 18 or more.',
      },
    ]);
    expect(
      (await get(`/competitions/${competitionId}/publication`, leagueManager)).body,
    ).toMatchObject({ visibility: 'private', publicCode: null });

    // Staff set what the message asks for, through the division's own command.
    for (const divisionId of [gold, silver]) {
      const division = await t.db
        .selectFrom('divisions')
        .select('revision')
        .where('id', '=', divisionId)
        .executeTakeFirstOrThrow();
      const updated = await t.http
        .patch(`/v1/divisions/${divisionId}`)
        .set(leagueManager.header)
        .set('Idempotency-Key', key())
        .send({ criteria: ADULTS, expectedRevision: division.revision });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    }
    const published = await publish(competitionId);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({ visibility: 'public', blockers: [] });
    expect(bronze).toEqual(expect.any(String));
  });

  it('SPK-SCHED-010: a competition, season or division name that suggests players under 18 refuses publication even when every age band says adult', async () => {
    // "Youth Spring League" with divisions "Gold" and "Silver": the names of the divisions are
    // neutral and their age bands say adult; the competition's name does not.
    const named = await createCompetitionFixture(t, {
      name: 'Youth Spring League',
      status: 'active',
    });
    const season = await createSeasonFixture(t, {
      competitionId: named,
      name: 'Spring',
      status: 'active',
    });
    for (const name of ['Gold', 'Silver']) {
      await createDivisionFixture(t, { seasonId: season.seasonId, name, criteria: ADULTS });
    }
    const byCompetition = await publish(named);
    expect(byCompetition.status).toBe(400);
    expect(byCompetition.body.details.blockers).toEqual([
      expect.objectContaining({ scope: 'competition', reason: 'name_suggests_minors' }),
    ]);

    // The season's name.
    const bySeasonName = await createCompetitionFixture(t, { name: 'Borealis', status: 'active' });
    const juniors = await createSeasonFixture(t, {
      competitionId: bySeasonName,
      name: 'U12s Fall',
      status: 'active',
    });
    await createDivisionFixture(t, { seasonId: juniors.seasonId, name: 'Gold', criteria: ADULTS });
    const bySeason = await publish(bySeasonName);
    expect(bySeason.status).toBe(400);
    expect(bySeason.body.details.blockers).toEqual([
      expect.objectContaining({
        scope: 'season',
        reason: 'name_suggests_minors',
        seasonName: 'U12s Fall',
      }),
    ]);

    // A division's name, level or category: every spelling the review found passing.
    const byDivision = await createCompetitionFixture(t, { name: 'Cascade', status: 'active' });
    const thursdays = await createSeasonFixture(t, {
      competitionId: byDivision,
      name: 'Cascade autumn',
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
      status: 'active',
    });
    const names = [
      '12U',
      '2015 Coed',
      'Boys A',
      'Girls A',
      'High School',
      'Kids',
      'Teen',
      'U-12',
      'U12s',
      'Under 12',
    ];
    for (const name of names) {
      await createDivisionFixture(t, { seasonId: thursdays.seasonId, name, criteria: ADULTS });
    }
    await createDivisionFixture(t, {
      seasonId: thursdays.seasonId,
      name: 'Zeta',
      criteria: { ...ADULTS, category: 'Junior' },
    });
    const byNames = await publish(byDivision);
    expect(byNames.status).toBe(400);
    expect(
      byNames.body.details.blockers.map((b: Json) => [b['reason'], b['divisionName']]),
    ).toEqual([...names, 'Zeta'].map((name) => ['name_suggests_minors', name]));
    // Nothing became public on the way.
    for (const id of [named, bySeasonName, byDivision]) {
      expect((await get(`/competitions/${id}/publication`, leagueManager)).body.visibility).toBe(
        'private',
      );
    }
  });

  it('SPK-SCHED-010: a public competition whose divisions later change to youth or unknown, or whose names change, stops being served on every public read; a season without a division is not shown', async () => {
    const start = new Date('2026-11-24T03:00:00Z');
    const data = await league('Dune', start);
    const published = await publish(data.competitionId);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const code = published.body.publicCode as string;
    const seasonCode = published.body.seasons[0].publicCode as string;
    const competitionPath = `${slug}/competitions/${code}`;
    const seasonPath = `${slug}/seasons/${seasonCode}`;
    const listed = async () =>
      ((await anonymous(`${slug}/directory`)).body.competitions as Json[]).some(
        (c) => c['code'] === code,
      );
    const served = async () => {
      const [competition, season] = [await anonymous(competitionPath), await anonymous(seasonPath)];
      return [competition.status, season.status, await listed()];
    };
    const notServed = async () => {
      expect(answerOf(await anonymous(competitionPath))).toEqual(NOT_AVAILABLE);
      expect(answerOf(await anonymous(seasonPath))).toEqual(NOT_AVAILABLE);
      expect(await listed()).toBe(false);
    };
    const setCriteria = (criteria: Json) =>
      t.db
        .updateTable('divisions')
        .set({
          criteria: json({ ageBand: null, level: null, category: null, format: null, ...criteria }),
        })
        .where('id', '=', data.divisionId)
        .execute();
    expect(await served()).toEqual([200, 200, true]);

    // unknown: the division no longer says anything about age
    await setCriteria({});
    await notServed();
    // the staff read says why, and the competition is still recorded as public
    const state = await get(`/competitions/${data.competitionId}/publication`, leagueManager);
    expect(state.body).toMatchObject({
      visibility: 'public',
      blockers: [{ scope: 'division', reason: 'age_not_stated', divisionName: 'Open' }],
    });
    // youth: the age band starts under 18
    await setCriteria({ ageBand: { minAge: 16, maxAge: null } });
    await notServed();
    await setCriteria(ADULTS);
    expect(await served()).toEqual([200, 200, true]);

    // the division is renamed to a youth name
    await t.db
      .updateTable('divisions')
      .set({ name: '14U' })
      .where('id', '=', data.divisionId)
      .execute();
    await notServed();
    await t.db
      .updateTable('divisions')
      .set({ name: 'Open' })
      .where('id', '=', data.divisionId)
      .execute();
    // the season is renamed
    await t.db
      .updateTable('seasons')
      .set({ name: 'Junior winter' })
      .where('id', '=', data.seasonId)
      .execute();
    await notServed();
    await t.db
      .updateTable('seasons')
      .set({ name: 'Dune winter' })
      .where('id', '=', data.seasonId)
      .execute();
    // the competition is renamed
    await t.db
      .updateTable('competitions')
      .set({ name: 'Dune kids' })
      .where('id', '=', data.competitionId)
      .execute();
    await notServed();
    await t.db
      .updateTable('competitions')
      .set({ name: 'Dune' })
      .where('id', '=', data.competitionId)
      .execute();
    expect(await served()).toEqual([200, 200, true]);

    // A later season with no division yet: the competition stays public, the season is not shown.
    const next = await createSeasonFixture(t, {
      competitionId: data.competitionId,
      name: 'Dune spring',
      status: 'active',
    });
    const nextCode = 'nextseasoncode0123456789';
    await t.db
      .updateTable('seasons')
      .set({ public_code: nextCode })
      .where('id', '=', next.seasonId)
      .execute();
    expect(answerOf(await anonymous(`${slug}/seasons/${nextCode}`))).toEqual(NOT_AVAILABLE);
    const competition = await anonymous(competitionPath);
    expect(competition.status).toBe(200);
    expect(competition.body.seasons.map((s: Json) => s['code'])).toEqual([seasonCode]);
    const withNext = await get(`/competitions/${data.competitionId}/publication`, leagueManager);
    expect(withNext.body.seasons.map((s: Json) => [s['name'], s['hasDivisions']]).sort()).toEqual([
      ['Dune spring', false],
      ['Dune winter', true],
    ]);
    // Once it has an adult division it is shown; a youth one takes the whole competition down.
    const nextDivision = await createDivisionFixture(t, {
      seasonId: next.seasonId,
      name: 'Open',
      criteria: ADULTS,
    });
    expect((await anonymous(`${slug}/seasons/${nextCode}`)).status).toBe(200);
    await t.db
      .updateTable('divisions')
      .set({ criteria: json({ ageBand: { minAge: 8, maxAge: 10 } }) })
      .where('id', '=', nextDivision)
      .execute();
    expect(answerOf(await anonymous(`${slug}/seasons/${nextCode}`))).toEqual(NOT_AVAILABLE);
    await notServed();
  });

  it('SPK-SCHED-010: the under-18 rule fails closed: only a stated minimum age of 18 or more makes a division adult, and wording is only ever a further refusal', () => {
    const criteria = (over: Json = {}) => ({
      ageBand: null,
      level: null,
      category: null,
      format: null,
      ...over,
    });
    // The structured fact, and nothing else, gives permission.
    expect(divisionAudience(criteria({ ageBand: { minAge: 18, maxAge: null } }))).toBe('adult');
    expect(divisionAudience(criteria({ ageBand: { minAge: 35, maxAge: 99 } }))).toBe('adult');
    expect(divisionAudience(criteria({ ageBand: { minAge: 16, maxAge: null } }))).toBe('under_18');
    expect(divisionAudience(criteria({ ageBand: { minAge: null, maxAge: 12 } }))).toBe('under_18');
    // No age band, one open at the bottom, and criteria that cannot be read: not known adult.
    expect(divisionAudience(criteria())).toBe('age_not_stated');
    expect(divisionAudience({})).toBe('age_not_stated');
    expect(divisionAudience(criteria({ ageBand: { minAge: null, maxAge: null } }))).toBe(
      'age_not_stated',
    );
    expect(divisionAudience(criteria({ ageBand: { minAge: null, maxAge: 40 } }))).toBe(
      'age_not_stated',
    );
    expect(divisionAudience('broken')).toBe('age_not_stated');
    expect(divisionAudience(null)).toBe('age_not_stated');

    const context = { referenceYear: 2026, seasonYears: new Set([2026, 2027]) };
    const flagged = [
      '12U',
      '12-U',
      'U12',
      'U-12',
      'U 12',
      'U12s',
      'U12B',
      'GU14',
      'Under 12',
      'Under-12s',
      'under12',
      '12 and under',
      '10 & Under',
      'U19',
      'Ages 8-10',
      'age 16+',
      '12 year olds',
      '2015 Coed',
      'B2012',
      'Youth',
      'Junior',
      'Juniors',
      'Jr. Division',
      'Teen',
      'Teens',
      'Teenagers',
      'High School',
      'Middle school',
      'Elementary School',
      'Kids',
      'Boys',
      'Girls',
      'Children',
      'Minors',
      'Academy',
      'Grade 5',
      '5th grade',
      'Pee Wee',
      'Little League',
    ];
    for (const name of flagged) {
      expect(minorWording(name, context), name).toEqual(expect.any(String));
    }
    const silent = [
      'Open',
      'Gold',
      'Division 2',
      'Over 35',
      '35+',
      'U23 development',
      'U21',
      'Ages 18+',
      'Coed A',
      'Spring 2026',
      'Winter 2026/2027',
      'Legends 1990',
      'Group 4',
      'Stage 2',
      'Termites',
      'Menu 12',
    ];
    for (const name of silent) expect(minorWording(name, context), name).toBeNull();
    // A year is the season's own year or a birth year, by its distance from the season.
    expect(minorWording('Fall 2015', { referenceYear: 2015, seasonYears: new Set([2015]) })).toBe(
      null,
    );
    expect(minorWording('Fall 2015', { referenceYear: 2026 })).toBe('2015');

    // Silence of the wording is not permission: a neutral name without an age band is refused,
    // and an adult age band with a youth name is refused too.
    const season = { id: 's1', name: 'Spring 2026', years: [2026] };
    const blockers = (divisions: Array<{ name: string; criteria: unknown }>, competition = 'Cup') =>
      publicationBlockers({
        competitionName: competition,
        seasons: [season],
        divisions: divisions.map((division) => ({ seasonId: 's1', ...division })),
        currentYear: 2026,
      }).map((blocker) => blocker.reason);
    const adult = criteria({ ageBand: { minAge: 18, maxAge: null } });
    expect(blockers([{ name: 'Open', criteria: adult }])).toEqual([]);
    expect(blockers([])).toEqual(['no_divisions']);
    expect(blockers([{ name: 'Open', criteria: criteria() }])).toEqual(['age_not_stated']);
    expect(blockers([{ name: 'Open', criteria: 'broken' }])).toEqual(['age_not_stated']);
    expect(blockers([{ name: 'U12', criteria: adult }])).toEqual(['name_suggests_minors']);
    expect(blockers([{ name: 'U12', criteria: criteria() }])).toEqual([
      'age_not_stated',
      'name_suggests_minors',
    ]);
    expect(blockers([{ name: 'Open', criteria: { ...adult, level: 'Boys U-16' } }])).toEqual([
      'name_suggests_minors',
    ]);
    expect(blockers([{ name: 'Open', criteria: adult }], 'Youth Spring League')).toEqual([
      'name_suggests_minors',
    ]);
  });

  it('SPK-SCHED-010 (migration 0471): the database refuses to make a competition public while it has no division, or a division that does not state a minimum age of 18 or more', async () => {
    const competitionId = await createCompetitionFixture(t, { name: 'Ember', status: 'active' });
    const season = await createSeasonFixture(t, { competitionId, status: 'active' });
    const makePublic = (id: string = competitionId) =>
      t.db
        .updateTable('competitions')
        .set({
          public_visibility: 'public',
          public_code: `direct${id.replace(/-/g, '').slice(-18)}`,
          public_changed_at: t.clock.now(),
          public_changed_by: json({ kind: 'system', actorLabel: 'schema-test' }),
        })
        .where('id', '=', id)
        .execute();
    // no division
    await expect(makePublic()).rejects.toSatisfy(isCheckViolation);
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Open' });
    const setCriteria = (criteria: unknown) =>
      t.db
        .updateTable('divisions')
        .set({ criteria: json(criteria as object) })
        .where('id', '=', divisionId)
        .execute();
    // no age band; a band open at the bottom; a band under 18; a minimum age that is not a number
    for (const criteria of [
      { ageBand: null, level: null, category: null, format: null },
      {},
      { ageBand: { minAge: null, maxAge: 40 } },
      { ageBand: { minAge: 17, maxAge: null } },
      { ageBand: { minAge: '18', maxAge: null } },
    ]) {
      await setCriteria(criteria);
      await expect(makePublic(), JSON.stringify(criteria)).rejects.toSatisfy(isCheckViolation);
    }
    // one adult division beside one that says nothing: still refused
    const second = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Second',
      criteria: ADULTS,
    });
    await expect(makePublic()).rejects.toSatisfy(isCheckViolation);
    expect(second).toEqual(expect.any(String));
    expect(
      await t.db
        .selectFrom('competitions')
        .select('public_visibility')
        .where('id', '=', competitionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ public_visibility: 'private' });
    // every division states an adult minimum age: accepted
    await setCriteria({ ageBand: { minAge: 18, maxAge: null } });
    await makePublic();
    // a competition inserted as public is judged the same way
    const { id: _id, ...row } = await t.db
      .selectFrom('competitions')
      .selectAll()
      .where('id', '=', competitionId)
      .executeTakeFirstOrThrow();
    await expect(
      t.db
        .insertInto('competitions')
        .values({
          ...row,
          id: newId(),
          name: 'Inserted public',
          public_code: 'insertedpubliccode012345',
          created_by: json(row.created_by),
          public_changed_by: json({ kind: 'system', actorLabel: 'schema-test' }),
        } as never)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-SCHED-010: in a tournament the published bracket is shown with team names and scores only', async () => {
    const competitionId = await createCompetitionFixture(t, {
      name: 'Winter cup',
      kind: 'tournament',
      status: 'active',
    });
    const season = await createSeasonFixture(t, { competitionId, status: 'active' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Cup',
      criteria: ADULTS,
    });
    const entry = async (teamName: string) =>
      (
        await createTeamEntryFixture(t, {
          seasonId: season.seasonId,
          captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
          teamName,
          divisionId,
        })
      ).teamEntryId;
    const lions = await entry('Lions');
    const tigers = await entry('Tigers');
    const fixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: lions,
      awayEntryId: tigers,
      scheduledStart: new Date('2026-12-01T03:00:00Z'),
      scheduledEnd: new Date('2026-12-01T04:00:00Z'),
    });
    await createResultRevisionFixture(t, { fixtureId, homeScore: 2, awayScore: 1 });
    const final = await createBracketNodeFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      round: 1,
      slot: 1,
      fixtureId,
      homeEntryId: lions,
      awayEntryId: tigers,
      published: true,
    });
    await t.db
      .updateTable('bracket_nodes')
      .set({ winner_entry_id: lions })
      .where('id', '=', final)
      .execute();
    // A node that is not published yet is not part of the public bracket.
    await createBracketNodeFixture(t, { seasonId: season.seasonId, divisionId, round: 2, slot: 1 });
    const published = await publish(competitionId);
    const view = await anonymous(`${slug}/seasons/${published.body.seasons[0].publicCode}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.bracket).toEqual([
      {
        round: 1,
        slot: 1,
        division: 'Cup',
        home: 'Lions',
        away: 'Tigers',
        score: { home: 2, away: 1 },
        winner: 'home',
        startsAt: '2026-12-01T03:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(view.body)).not.toMatch(UUID);
  });

  it('SPK-SCHED-010: the database keeps a public competition with a code and the fact of the change, well-formed codes, and one record per code', async () => {
    const competitionId = await createCompetitionFixture(t);
    const actor = json({ kind: 'system' });
    // public without a code
    await expect(
      t.db
        .updateTable('competitions')
        .set({
          public_visibility: 'public',
          public_changed_at: t.clock.now(),
          public_changed_by: actor,
        })
        .where('id', '=', competitionId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // public without the fact of who made it so
    await expect(
      t.db
        .updateTable('competitions')
        .set({ public_visibility: 'public', public_code: 'd'.repeat(24) })
        .where('id', '=', competitionId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // a visibility the model does not have, and a guessable code
    await expect(
      t.db
        .updateTable('competitions')
        .set({ public_visibility: 'unlisted' as 'public' })
        .where('id', '=', competitionId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      t.db
        .updateTable('competitions')
        .set({ public_code: 'league' })
        .where('id', '=', competitionId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // one competition, and one season, per code
    await t.db
      .updateTable('competitions')
      .set({ public_code: 'e'.repeat(24) })
      .where('id', '=', competitionId)
      .execute();
    const other = await createCompetitionFixture(t);
    await expect(
      t.db
        .updateTable('competitions')
        .set({ public_code: 'e'.repeat(24) })
        .where('id', '=', other)
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    const one = await createSeasonFixture(t, { competitionId });
    const two = await createSeasonFixture(t, { competitionId });
    await t.db
      .updateTable('seasons')
      .set({ public_code: 'f'.repeat(24) })
      .where('id', '=', one.seasonId)
      .execute();
    await expect(
      t.db
        .updateTable('seasons')
        .set({ public_code: 'f'.repeat(24) })
        .where('id', '=', two.seasonId)
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
  });
});

describe('public competition views rate limit (SPK-SCHED-010, §4.14)', () => {
  it('SPK-SCHED-010: competition reads share the `public_views` limit per address', async () => {
    const t = await competitionTestApp({
      capabilities: ['public_schedule'],
      clockStart: '2026-11-02T17:00:05Z',
      env: { RATE_LIMITS: 'public_views=2/60' },
    });
    try {
      const code = '0'.repeat(24);
      expect((await t.http.get(`/v1/public/nowhere/competitions/${code}`)).status).toBe(404);
      expect((await t.http.get(`/v1/public/nowhere/seasons/${code}`)).status).toBe(404);
      for (const path of ['competitions', 'seasons', 'schedule']) {
        const refused = await t.http.get(`/v1/public/nowhere/${path}/${code}`);
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('RATE_LIMITED');
        expect(refused.headers['retry-after']).toBe('55');
      }
    } finally {
      await t.close();
    }
  });
});
