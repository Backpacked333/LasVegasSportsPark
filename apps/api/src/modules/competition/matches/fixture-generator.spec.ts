import { newId, type SearchSettings } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  generateFixtures,
  roundRobin,
  validateCompleteness,
  type GeneratorInput,
} from './fixture-generator';

const utc = (date: string, time: string): Date => new Date(`${date}T${time}:00Z`);
const settings: SearchSettings = { maxCandidates: 20, timeLimitMs: 5_000, seed: 7 };
const frozen = () => 0;

function input(overrides: Partial<GeneratorInput> = {}): GeneratorInput {
  const teams = overrides.teamEntryIds ?? [newId(), newId(), newId(), newId(), newId()].sort();
  return {
    teamEntryIds: teams,
    gamesPerTeam: (teams.length - 1) * (overrides.opponentFrequency ?? 2),
    opponentFrequency: 2,
    startsOn: '2027-01-04', // a Monday
    endsOn: '2027-04-30',
    blackouts: [],
    byesAllowed: true,
    minimumRestMinutes: 60,
    allowedStartTimes: [
      { weekday: 6, time: '09:00' },
      { weekday: 6, time: '11:00' },
      { weekday: 6, time: '13:00' },
    ],
    matchDurationMinutes: 60,
    resourceIds: [newId()],
    fairnessPreferences: [],
    playoffStructure: null,
    resolveInstant: utc,
    obligationDeadline: '2027-01-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('fixture generator (SPK-FIX-001..004)', () => {
  it('SPK-AT-010: five teams in a double round robin give 20 games, one bye per team per cycle, and a complete obligation set', () => {
    const spec = input();
    const result = generateFixtures(spec, settings, frozen);
    expect(['feasible', 'proven_optimal']).toContain(result.outcome);
    const games = result.proposal?.games ?? [];
    const real = games.filter((g) => g.awayEntryId !== null);
    const byes = games.filter((g) => g.awayEntryId === null);
    expect(real).toHaveLength(20);
    expect(byes).toHaveLength(10);
    for (const team of spec.teamEntryIds) {
      expect(real.filter((g) => g.homeEntryId === team || g.awayEntryId === team)).toHaveLength(8);
      // one bye per cycle: two cycles → two byes (5 teams, one sits out each round)
      expect(byes.filter((g) => g.homeEntryId === team)).toHaveLength(2);
      const home = real.filter((g) => g.homeEntryId === team).length;
      expect(Math.abs(home - (8 - home))).toBeLessThanOrEqual(1);
    }
    expect(real.every((g) => g.scheduledStart !== null && g.resourceId !== null)).toBe(true);
    expect(result.completeness).toMatchObject({
      complete: true,
      expectedGames: 20,
      proposedGames: 20,
      scheduledGames: 20,
      issues: [],
      remainingObligations: [],
    });
    expect(result.completeness.byes.every((b) => b.count === 2)).toBe(true);
    // each pair meets exactly twice, once at each venue
    const pairs = new Map<string, string[]>();
    for (const g of real) {
      const key = [g.homeEntryId, g.awayEntryId].sort().join('|');
      pairs.set(key, [...(pairs.get(key) ?? []), g.homeEntryId]);
    }
    expect(pairs.size).toBe(10);
    for (const homes of pairs.values()) {
      expect(homes).toHaveLength(2);
      expect(homes[0]).not.toBe(homes[1]);
    }
    // hard constraints hold: one game per slot, minimum rest, rounds in order
    const slots = new Set(real.map((g) => `${g.scheduledStart}|${g.resourceId}`));
    expect(slots.size).toBe(20);
    for (const team of spec.teamEntryIds) {
      const mine = real
        .filter((g) => g.homeEntryId === team || g.awayEntryId === team)
        .sort((a, b) => a.round - b.round);
      for (let i = 1; i < mine.length; i += 1) {
        const previous = mine[i - 1];
        const current = mine[i];
        expect(new Date(current?.scheduledStart ?? 0).getTime()).toBeGreaterThanOrEqual(
          new Date(previous?.scheduledEnd ?? 0).getTime() + 60 * 60_000,
        );
      }
    }
  });

  it('SPK-FIX-002: the completeness validator detects missing, duplicate, excess and unscheduled games, wrong frequency, invalid byes and playoff requirements', () => {
    const [a, b, c, d] = [newId(), newId(), newId(), newId()].sort() as [
      string,
      string,
      string,
      string,
    ];
    const game = (
      key: string,
      round: number,
      home: string,
      away: string | null,
      scheduled = true,
    ) => ({
      key,
      round,
      homeEntryId: home,
      awayEntryId: away,
      fixtureId: null,
      scheduledStart: scheduled ? '2027-02-01T10:00:00.000Z' : null,
      scheduledEnd: scheduled ? '2027-02-01T11:00:00.000Z' : null,
      resourceId: scheduled ? newId() : null,
    });
    const report = validateCompleteness(
      {
        teamEntryIds: [a, b, c, d],
        gamesPerTeam: 3,
        opponentFrequency: 1,
        playoffStructure: { kind: 'single_elimination', teams: 8 },
        obligationDeadline: '2027-01-01T00:00:00.000Z',
      },
      [
        game('r1-g1', 1, a, b),
        game('r1-g2', 1, a, b), // duplicate in the same round and third meeting overall
        game('r2-g1', 2, b, a),
        game('r2-g2', 2, c, d, false), // unscheduled
        game('r3-g1', 3, a, c),
        game('r3-bye', 3, c, null), // bye with an even team count
      ],
    );
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('missing_fixture'); // a-d, b-c, b-d never meet
    expect(codes).toContain('duplicate_fixture');
    expect(codes).toContain('opponent_frequency');
    expect(codes).toContain('excess_games'); // a plays four games, three were specified
    expect(codes).toContain('unscheduled_game');
    expect(codes).toContain('invalid_bye');
    expect(codes).toContain('playoff_unfulfilled');
    expect(report.complete).toBe(false);
    expect(report.remainingObligations.map((o) => o.code)).toEqual([
      'unscheduled_games',
      'playoff_bracket',
    ]);
    expect(report.remainingObligations[0]).toMatchObject({
      owner: 'league_manager',
      deadline: '2027-01-01T00:00:00.000Z',
      gameKeys: ['r2-g2'],
    });
  });

  it('SPK-FIX-004: a provable capacity shortage is proven infeasible, a hard availability preference without matching slots is proven infeasible', () => {
    const tooFewSlots = generateFixtures(
      input({ startsOn: '2027-01-04', endsOn: '2027-01-10', opponentFrequency: 1 }),
      settings,
      frozen,
    );
    expect(tooFewSlots.outcome).toBe('proven_infeasible');
    expect(tooFewSlots.proposal).toBeNull();
    expect(tooFewSlots.explanation.stoppedBy).toBe('proof');
    expect(tooFewSlots.explanation.summary).toMatch(/slot/);

    const teams = [newId(), newId(), newId(), newId()].sort();
    const neverAvailable = generateFixtures(
      input({
        teamEntryIds: teams,
        opponentFrequency: 1,
        fairnessPreferences: [
          {
            kind: 'preferred_availability',
            hard: true,
            weight: 5,
            teamEntryId: teams[0],
            startTimes: [{ weekday: 2, time: '19:00' }], // Tuesdays are not allowed start times
          },
        ],
      }),
      settings,
      frozen,
    );
    expect(neverAvailable.outcome).toBe('proven_infeasible');
    expect(neverAvailable.explanation.hardViolations[0]?.constraint).toBe('preferred_availability');

    const odd = generateFixtures(input({ byesAllowed: false }), settings, frozen);
    expect(odd.outcome).toBe('proven_infeasible');
  });

  it('SPK-AT-011: conflicting hard fairness preferences give no_proposal_within_limit with the conflict explained, never a false infeasibility or optimality claim', () => {
    // Four teams, Saturdays only with three slots on one pitch, hard "no consecutive games" is
    // satisfiable, but a hard "rest distribution" spread of one match length cannot be met together
    // with hard early/late balance when every weekend has exactly three slots for two games.
    const teams = [newId(), newId(), newId(), newId()].sort();
    const result = generateFixtures(
      input({
        teamEntryIds: teams,
        opponentFrequency: 1,
        startsOn: '2027-01-04',
        endsOn: '2027-01-31', // four Saturdays → 12 slots for 6 games
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '10:00' },
          { weekday: 6, time: '11:00' },
        ],
        minimumRestMinutes: 0,
        fairnessPreferences: [
          { kind: 'no_consecutive_games', hard: true, weight: 1 },
          {
            kind: 'preferred_availability',
            hard: true,
            weight: 1,
            teamEntryId: teams[0],
            startTimes: [{ weekday: 6, time: '09:00' }],
          },
          {
            kind: 'preferred_availability',
            hard: true,
            weight: 1,
            teamEntryId: teams[1],
            startTimes: [{ weekday: 6, time: '09:00' }],
          },
          {
            kind: 'preferred_availability',
            hard: true,
            weight: 1,
            teamEntryId: teams[2],
            startTimes: [{ weekday: 6, time: '09:00' }],
          },
        ],
      }),
      { ...settings, maxCandidates: 10 },
      frozen,
    );
    // teams 0, 1 and 2 each insist on the single 09:00 slot each Saturday: three teams, four
    // Saturdays, but team 0 v team 1, 0 v 2 and 1 v 2 plus each of their games against team 3 need
    // 09:00 — six games for four 09:00 slots.
    expect(result.outcome).toBe('no_proposal_within_limit');
    expect(result.explanation.candidatesTried).toBe(10);
    expect(result.explanation.stoppedBy).toBe('candidate_limit');
    expect(result.explanation.summary).toMatch(/Infeasibility is not proven/);
    expect(result.completeness.complete).toBe(false);
    expect(result.completeness.issues.some((i) => i.code === 'unscheduled_game')).toBe(true);
    expect(result.completeness.remainingObligations[0]).toMatchObject({
      code: 'unscheduled_games',
      owner: 'league_manager',
    });
    expect(result.proposal?.games.some((g) => g.scheduledStart === null)).toBe(true);
  });

  it('SPK-FIX-003: soft preferences are scored and reported separately from hard constraints; a zero-penalty proposal is reported optimal', () => {
    const teams = [newId(), newId(), newId(), newId()].sort();
    const result = generateFixtures(
      input({
        teamEntryIds: teams,
        opponentFrequency: 1,
        fairnessPreferences: [
          { kind: 'home_away_balance', hard: false, weight: 3 },
          { kind: 'no_consecutive_games', hard: false, weight: 2 },
          { kind: 'no_repeated_opponents', hard: false, weight: 1 },
        ],
      }),
      settings,
      frozen,
    );
    expect(result.outcome).toBe('proven_optimal');
    expect(result.explanation.totalPenalty).toBe(0);
    expect(result.explanation.stoppedBy).toBe('proof');
    expect(result.explanation.preferenceScores.map((s) => [s.kind, s.hard, s.penalty])).toEqual([
      ['home_away_balance', false, 0],
      ['no_consecutive_games', false, 0],
      ['no_repeated_opponents', false, 0],
    ]);
    expect(result.explanation.hardViolations).toEqual([]);
  });

  it('venues stay within one game of an even split per cycle for every team count (and balance exactly over two cycles)', () => {
    for (let n = 2; n <= 14; n += 1) {
      const teams = Array.from({ length: n }, (_, i) => `t${String(i).padStart(2, '0')}`);
      for (const cycles of [1, 2]) {
        const { games } = roundRobin(teams, cycles);
        for (const team of teams) {
          const real = games.filter(
            (g) => g.awayEntryId !== null && (g.homeEntryId === team || g.awayEntryId === team),
          );
          const home = real.filter((g) => g.homeEntryId === team).length;
          const diff = Math.abs(home - (real.length - home));
          // an odd team count balances exactly (the bye is the fixed position); an even count is
          // off by one per cycle and exact over two cycles
          expect(diff).toBeLessThanOrEqual(cycles === 2 || n % 2 === 1 ? 0 : 1);
        }
      }
    }
  });

  it('round robin by the circle method pairs every team once per cycle and alternates venues between cycles', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { games, rounds } = roundRobin(teams, 2);
    expect(rounds).toBe(10);
    expect(games).toHaveLength(30);
    for (let round = 1; round <= rounds; round += 1) {
      const inRound = games.filter((g) => g.round === round);
      expect(inRound).toHaveLength(3);
      const seen = new Set(inRound.flatMap((g) => [g.homeEntryId, g.awayEntryId]));
      expect(seen.size).toBe(6);
    }
    for (const a of teams) {
      for (const b of teams) {
        if (a >= b) continue;
        const meetings = games.filter(
          (g) =>
            (g.homeEntryId === a && g.awayEntryId === b) ||
            (g.homeEntryId === b && g.awayEntryId === a),
        );
        expect(meetings).toHaveLength(2);
        expect(meetings[0]?.homeEntryId).not.toBe(meetings[1]?.homeEntryId);
      }
    }
  });
  it('SPK-FIX-004 / SPK-AT-011: a resource holds one game at a time, turnover included; start times closer than a match are flexibility, not capacity, so optimality is never claimed over a double booking', () => {
    type Game = NonNullable<ReturnType<typeof generateFixtures>['proposal']>['games'][number];
    const overlaps = (games: Game[], buffers: { setup: number; cleanup: number }) => {
      const placed = games.filter((g) => g.scheduledStart && g.scheduledEnd && g.resourceId);
      const span = (g: Game) => [
        new Date(g.scheduledStart as string).getTime() - buffers.setup * 60_000,
        new Date(g.scheduledEnd as string).getTime() + buffers.cleanup * 60_000,
      ];
      const found: string[] = [];
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const a = placed[i] as Game;
          const b = placed[j] as Game;
          if (a.resourceId !== b.resourceId) continue;
          const [as, ae] = span(a) as [number, number];
          const [bs, be] = span(b) as [number, number];
          if (as < be && bs < ae) found.push(`${a.key} vs ${b.key}`);
        }
      }
      return found;
    };
    const resourceId = newId();
    const fourTeams = [newId(), newId(), newId(), newId()].sort();
    // Saturday 09:00 and 09:30 with a 60-minute match on one pitch
    const close = generateFixtures(
      input({
        teamEntryIds: fourTeams,
        opponentFrequency: 1,
        gamesPerTeam: 3,
        minimumRestMinutes: 0,
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '09:30' },
        ],
        resourceIds: [resourceId],
      }),
      settings,
      frozen,
    );
    expect(['feasible', 'proven_optimal']).toContain(close.outcome);
    expect(close.completeness.complete).toBe(true);
    expect(overlaps(close.proposal?.games ?? [], { setup: 0, cleanup: 0 })).toEqual([]);

    // hourly starts, a 60-minute match and 10 minutes of cleanup: back-to-back games would collide
    const turnover = generateFixtures(
      input({
        teamEntryIds: fourTeams,
        opponentFrequency: 1,
        gamesPerTeam: 3,
        minimumRestMinutes: 0,
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '10:00' },
          { weekday: 6, time: '11:00' },
        ],
        resourceIds: [resourceId],
        resourceBuffers: { [resourceId]: { setupMinutes: 0, cleanupMinutes: 10 } },
      }),
      settings,
      frozen,
    );
    expect(['feasible', 'proven_optimal']).toContain(turnover.outcome);
    expect(overlaps(turnover.proposal?.games ?? [], { setup: 0, cleanup: 10 })).toEqual([]);

    // three start times 20 minutes apart hold one 60-minute game per day: 2 Saturdays, 6 games
    const short = generateFixtures(
      input({
        teamEntryIds: fourTeams,
        opponentFrequency: 1,
        gamesPerTeam: 3,
        minimumRestMinutes: 0,
        startsOn: '2027-01-04',
        endsOn: '2027-01-16',
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '09:20' },
          { weekday: 6, time: '09:40' },
        ],
        resourceIds: [resourceId],
      }),
      settings,
      frozen,
    );
    expect(short.outcome).toBe('proven_infeasible');
    expect(short.proposal).toBeNull();
    expect(short.explanation.hardViolations).toEqual([
      expect.objectContaining({ constraint: 'capacity', message: '6 games, capacity for 2.' }),
    ]);
  });
});
