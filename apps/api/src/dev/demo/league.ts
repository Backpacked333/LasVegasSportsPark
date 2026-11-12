import { proposedRuleSetContent } from '../../modules/competition';
import type { DemoSession } from './client';
import { localDate, localInstant, type DemoContext } from './context';
import type { DemoFacility } from './facility';
import { completeSeededPerson, createAccount, createPerson } from './people';

export interface DemoTeam {
  name: string;
  entryId: string;
  teamId: string;
  captain: DemoSession;
  playerIds: string[];
}

export interface DemoFixture {
  id: string;
  round: number;
  dayOffset: number;
  home: DemoTeam;
  away: DemoTeam;
  start: string;
  end: string;
  eventId: string | null;
}

export interface DemoLeague {
  competitionId: string;
  ruleSetId: string;
  seasonId: string;
  divisionId: string;
  teams: DemoTeam[];
  fixtures: DemoFixture[];
  /** Fixtures kicking off today in the facility's time zone. */
  todayFixtures: DemoFixture[];
  officialResults: number;
  players: number;
  /** The season's first and last day, as day offsets from today. */
  startDayOffset: number;
  endDayOffset: number;
}

/** Synthetic team names and colours. Six teams: five rounds to meet everyone once. */
const TEAMS: ReadonlyArray<{ name: string; primary: string; secondary: string }> = [
  { name: 'Demo United', primary: 'red', secondary: 'white' },
  { name: 'Sample Athletic', primary: 'blue', secondary: 'white' },
  { name: 'Placeholder Rovers', primary: 'green', secondary: 'black' },
  { name: 'Example City', primary: 'sky blue', secondary: 'navy' },
  { name: 'Mock Wanderers', primary: 'orange', secondary: 'black' },
  { name: 'Specimen Town', primary: 'purple', secondary: 'gold' },
];

const GIVEN_NAMES = ['Alex', 'Blake', 'Casey', 'Devon', 'Emery', 'Frankie', 'Gray', 'Harper'];
const FAMILY_NAMES = ['Sample', 'Example', 'Placeholder', 'Specimen', 'Mockford', 'Testwell'];

/** Weeks of play before today; the round after them is played today. */
const PAST_ROUNDS = 4;
const ROUNDS = 10;
const KICKOFFS = ['18:00', '19:00', '20:00'] as const;
const MATCH_MINUTES = 50;

/** Synthetic scores for the played rounds, by round then match (home, away). */
const SCORES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [4, 2],
    [1, 1],
    [3, 5],
  ],
  [
    [2, 3],
    [6, 3],
    [2, 2],
  ],
  [
    [1, 3],
    [4, 4],
    [5, 1],
  ],
  [
    [3, 3],
    [0, 2],
    [7, 4],
  ],
];

/**
 * Circle-method round robin for an even number of teams: `rounds` rounds of `teams / 2` pairings.
 * Home and away alternate by round and pairing, so a second cycle (rounds `teams - 1` and later,
 * an odd number further on) meets the same opponents with home and away reversed.
 */
export function roundRobin(teams: number, rounds: number): Array<Array<[number, number]>> {
  const order = Array.from({ length: teams }, (_, i) => i);
  const out: Array<Array<[number, number]>> = [];
  for (let round = 0; round < rounds; round += 1) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < teams / 2; i += 1) {
      const a = order[i] as number;
      const b = order[teams - 1 - i] as number;
      const flip = (round + i) % 2 === 1;
      pairs.push(flip ? [b, a] : [a, b]);
    }
    out.push(pairs);
    order.splice(1, 0, order.pop() as number);
  }
  return out;
}

function addMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

/**
 * An adult league in progress (SPK-COMP-001..005, SPK-RESULT-001..003): a competition with its own
 * rule-set version, a season started five weeks ago, one division, six teams with captains and
 * rosters, a weekly double round robin on the indoor court (four rounds played with official
 * results, one round today, five to come). Everything is synthetic: the rule values start from the
 * proposed defaults (DEC-002, pending) and are not the operator's rules.
 */
export async function seedLeague(
  ctx: DemoContext,
  facility: DemoFacility,
  parent: DemoSession,
): Promise<DemoLeague> {
  const { api } = ctx;
  const league = ctx.staff.league;

  const competition = await api.post<{ id: string; revision: number }>('/competitions', league, {
    name: 'Demo Indoor League (synthetic)',
    kind: 'league',
    sportFormat: 'indoor_boarded',
    description: 'Synthetic example league for demonstrations. Not a real competition.',
  });
  const ruleSet = await api.post<{ id: string }>('/rule-sets', league, {
    name: 'Demo indoor rules (synthetic)',
    format: 'indoor_boarded',
    content: {
      ...proposedRuleSetContent('indoor_boarded'),
      // Small synthetic squads: five on the court, four needed to start.
      playersOnField: 5,
      rosterMin: 4,
      rosterMax: 12,
      matchLengthMinutes: MATCH_MINUTES,
    },
  });
  let season = await api.post<{ id: string; revision: number }>('/seasons', league, {
    competitionId: competition.id,
    name: 'Demo Season (synthetic)',
    ruleSetId: ruleSet.id,
    startsOn: localDate(ctx, -(PAST_ROUNDS + 1) * 7),
    endsOn: localDate(ctx, (ROUNDS - PAST_ROUNDS) * 7),
  });
  const division = await api.post<{ id: string }>('/divisions', league, {
    seasonId: season.id,
    name: 'Demo Division A',
    criteria: {
      ageBand: { minAge: 18, maxAge: null },
      level: 'recreational',
      category: 'open',
      format: '5v5',
    },
    facilityId: ctx.facilityId,
    capacityTeamEntries: 8,
  });
  season = await api.patch(`/seasons/${season.id}`, league, {
    status: 'open',
    expectedRevision: season.revision,
  });

  // Teams: each with a captain who can sign in and four more adults. dev-parent captains the
  // first team, so the customer app's team screens have content.
  const rosterFrom = localInstant(ctx, -(PAST_ROUNDS + 1) * 7, '09:00');
  const teams: DemoTeam[] = [];
  let playerCount = 0;
  for (const [index, spec] of TEAMS.entries()) {
    let captain: DemoSession;
    if (index === 0) {
      captain = parent;
      // The division has an age band: the seeded parent needs a date of birth to be rostered.
      await completeSeededPerson(ctx, parent.personId, { dateOfBirth: '1988-04-12' });
    } else {
      const personId = await createPerson(ctx, {
        kind: 'adult',
        givenName: GIVEN_NAMES[index] as string,
        familyName: `${FAMILY_NAMES[index] as string} (demo captain)`,
        dateOfBirth: `198${index}-03-1${index}`,
      });
      captain = await createAccount(
        ctx,
        `demo-captain-${index + 1}`,
        personId,
        `customer: captain of ${spec.name}`,
      );
    }
    const created = await api.post<{
      entry: { id: string; revision: number };
      team: { id: string };
    }>('/team-entries', league, {
      seasonId: season.id,
      team: { name: spec.name, colors: { primary: spec.primary, secondary: spec.secondary } },
      captainPersonId: captain.personId,
    });
    await api.post(`/team-entries/${created.entry.id}/approve`, league, {
      expectedRevision: created.entry.revision,
      divisionId: division.id,
      note: 'Demo entry (synthetic example)',
    });
    const playerIds: string[] = [captain.personId];
    for (let p = 0; p < 4; p += 1) {
      playerIds.push(
        await createPerson(ctx, {
          kind: 'adult',
          givenName: GIVEN_NAMES[(index + p + 1) % GIVEN_NAMES.length] as string,
          familyName: `${FAMILY_NAMES[(index + p * 2) % FAMILY_NAMES.length] as string} (demo player ${index + 1}.${p + 1})`,
          dateOfBirth: `19${85 + ((index + p) % 10)}-0${(p % 9) + 1}-15`,
        }),
      );
    }
    await api.post(`/team-entries/${created.entry.id}/roster`, league, {
      changes: playerIds.map((personId, i) => ({
        action: 'add',
        personId,
        status: 'active',
        effectiveFrom: rosterFrom,
        jerseyNumber: i + 1,
      })),
      reason: 'Demo: squads recorded as of the season start (synthetic example)',
    });
    playerCount += playerIds.length;
    teams.push({
      name: spec.name,
      entryId: created.entry.id,
      teamId: created.team.id,
      captain,
      playerIds,
    });
  }

  season = await api.patch(`/seasons/${season.id}`, league, {
    status: 'active',
    expectedRevision: season.revision,
  });
  await api.patch(`/competitions/${competition.id}`, league, {
    status: 'active',
    expectedRevision: competition.revision,
  });

  // The weekly schedule on the indoor court: published fixtures, one game at a time.
  const fixtures: DemoFixture[] = [];
  for (const [roundIndex, pairs] of roundRobin(teams.length, ROUNDS).entries()) {
    const dayOffset = (roundIndex - PAST_ROUNDS) * 7;
    for (const [pair, [h, a]] of pairs.entries()) {
      // Kickoff slots rotate, so no team always plays first.
      const slot = (pair + roundIndex) % KICKOFFS.length;
      const home = teams[h] as DemoTeam;
      const away = teams[a] as DemoTeam;
      const start = localInstant(ctx, dayOffset, KICKOFFS[slot] as string);
      const end = addMinutes(start, MATCH_MINUTES);
      const created = await api.post<{
        fixture: { id: string; schedulingEventId: string | null };
      }>('/fixtures', league, {
        seasonId: season.id,
        divisionId: division.id,
        round: roundIndex + 1,
        homeEntryId: home.entryId,
        awayEntryId: away.entryId,
        schedule: {
          facilityId: ctx.facilityId,
          resourceIds: [facility.indoorCourt],
          scheduledStart: start,
          scheduledEnd: end,
        },
      });
      fixtures.push({
        id: created.fixture.id,
        round: roundIndex + 1,
        dayOffset,
        home,
        away,
        start,
        end,
        eventId: created.fixture.schedulingEventId,
      });
    }
  }
  await ctx.drain();

  // Official results for every game already played: submitted by the league manager, then
  // published (SPK-RESULT-001); standings follow from the official results only.
  let officialResults = 0;
  for (const fixture of fixtures) {
    if (fixture.dayOffset >= 0) continue;
    const score = SCORES[fixture.round - 1]?.[officialResults % KICKOFFS.length] ?? [1, 1];
    const submitted = await api.post<{ id: string; revision: number }>(
      `/fixtures/${fixture.id}/results`,
      league,
      { classification: 'completed', homeScore: score[0], awayScore: score[1] },
    );
    await api.post(`/results/${submitted.id}/publish`, league, {
      expectedRevision: submitted.revision,
    });
    officialResults += 1;
  }
  await ctx.drain();

  return {
    competitionId: competition.id,
    ruleSetId: ruleSet.id,
    seasonId: season.id,
    divisionId: division.id,
    teams,
    fixtures,
    todayFixtures: fixtures.filter((f) => f.dayOffset === 0),
    officialResults,
    players: playerCount,
    startDayOffset: -(PAST_ROUNDS + 1) * 7,
    endDayOffset: (ROUNDS - PAST_ROUNDS) * 7,
  };
}
