import { isCheckViolation, isUniqueViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOutboxChecked, setCapability, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { seedResource } from '../../scheduling';
import { describesMinors } from '../public/public-competition.service';
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
 * competition is private until staff publish it, and one with a division for players under 18
 * cannot be published.
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
      minorDivisions: [],
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
        code: 'COMPETITION_HAS_MINOR_DIVISION',
        divisions: [{ divisionName: 'Under 12' }],
      },
    });
    const state = await get(`/competitions/${youth}/publication`, leagueManager);
    expect(state.body).toMatchObject({
      visibility: 'private',
      minorDivisions: [{ divisionName: 'Under 12' }],
    });
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

  it('SPK-SCHED-010: the rule for "describes players under 18" errs towards private', () => {
    const division = (name: string, criteria: Json = {}) => ({
      name,
      criteria: { ageBand: null, level: null, category: null, format: null, ...criteria },
    });
    expect(describesMinors(division('Open'))).toBe(false);
    expect(describesMinors(division('Open', { ageBand: { minAge: 18, maxAge: null } }))).toBe(
      false,
    );
    expect(describesMinors(division('Over 35', { ageBand: { minAge: 35, maxAge: 99 } }))).toBe(
      false,
    );
    expect(describesMinors(division('Open', { ageBand: { minAge: 16, maxAge: null } }))).toBe(true);
    // Open at the bottom: nothing says the players are adults.
    expect(describesMinors(division('Open', { ageBand: { minAge: null, maxAge: 40 } }))).toBe(true);
    expect(describesMinors(division('U12'))).toBe(true);
    expect(describesMinors(division('Division 2', { category: 'Youth' }))).toBe(true);
    expect(describesMinors(division('Division 2', { level: 'Boys U-16' }))).toBe(true);
    expect(describesMinors(division('U23 development'))).toBe(false);
    // Criteria that cannot be read are not evidence of an adult division.
    expect(describesMinors({ name: 'Open', criteria: 'broken' })).toBe(true);
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
