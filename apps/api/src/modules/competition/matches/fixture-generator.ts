import type {
  AllowedStartTime,
  Blackout,
  CompletenessIssue,
  CompletenessReport,
  ConstraintViolation,
  FairnessPreference,
  FairnessPreferenceKind,
  PlayoffStructure,
  PreferenceScore,
  ProposedGame,
  RemainingObligation,
  SearchSettings,
  SolverExplanation,
  SolverOutcome,
} from '@sportspark/contracts';

/**
 * Pure fixture generator (SPK-FIX-001..004, SPK-AT-010/011).
 *
 * 1. Round robin by the circle method, repeated `opponentFrequency` times with alternating venues;
 *    an odd team count gets one bye per team per cycle.
 * 2. Games are placed into candidate slots (allowed start times × dates outside blackouts ×
 *    required resources) under the hard constraints: one game per slot, a team plays once at a
 *    time, minimum rest, rounds in order for every team, and every fairness preference marked
 *    `hard`. Soft preferences are scored and reported (SPK-FIX-003: visibly distinct).
 * 3. Several seeded candidate orderings are tried within the search limits; the best valid one is
 *    the proposal. Outcomes are honest (SPK-FIX-004): `proven_optimal` only when the penalty is
 *    provably minimal (zero), `proven_infeasible` only for a proof (capacity, dates, preferences
 *    that can never be met), otherwise `feasible` or `no_proposal_within_limit`.
 * 4. A completeness validator (SPK-FIX-002) reports missing, duplicate and excess games,
 *    unscheduled games, wrong opponent frequency, invalid byes, unfulfilled playoff requirements
 *    and the remaining obligations with owner and deadline.
 *
 * Deterministic for a given seed; time comes from the injected `now`.
 */

export interface GeneratorInput {
  teamEntryIds: string[];
  gamesPerTeam: number;
  opponentFrequency: number;
  startsOn: string;
  endsOn: string;
  blackouts: Blackout[];
  byesAllowed: boolean;
  minimumRestMinutes: number;
  allowedStartTimes: AllowedStartTime[];
  matchDurationMinutes: number;
  resourceIds: string[];
  fairnessPreferences: FairnessPreference[];
  playoffStructure: PlayoffStructure | null;
  /** Facility-local wall clock to instant (DST-aware); null when the time does not exist. */
  resolveInstant: (date: string, time: string) => Date | null;
  /** Instant that unscheduled games must be scheduled by (season start) for remaining obligations. */
  obligationDeadline: string | null;
}

export interface GeneratorResult {
  outcome: SolverOutcome;
  proposal: { games: ProposedGame[] } | null;
  completeness: CompletenessReport;
  explanation: SolverExplanation;
}

export interface RoundRobinGame {
  key: string;
  round: number;
  homeEntryId: string;
  awayEntryId: string | null;
}

interface Slot {
  index: number;
  date: string;
  time: string;
  start: Date;
  end: Date;
  resourceId: string;
  isEarly: boolean;
  isLate: boolean;
}

interface Assignment {
  game: RoundRobinGame;
  slot: Slot | null;
}

interface Candidate {
  assignments: Assignment[];
  hardViolations: ConstraintViolation[];
  scores: PreferenceScore[];
  penalty: number;
  unscheduled: number;
}

const BYE = '__bye__';
const SLOT_WINDOW = 12;

// ---------------------------------------------------------------------------------------------
// Round robin (circle method)
// ---------------------------------------------------------------------------------------------
export function roundRobin(
  teamEntryIds: string[],
  opponentFrequency: number,
): { games: RoundRobinGame[]; rounds: number } {
  const teams = [...teamEntryIds].sort();
  // The bye is the fixed team of the circle so every real team rotates through all positions.
  if (teams.length % 2 === 1) teams.unshift(BYE);
  const n = teams.length;
  const roundsPerCycle = n - 1;
  const games: RoundRobinGame[] = [];
  let round = 0;
  for (let cycle = 0; cycle < opponentFrequency; cycle += 1) {
    const rotation = teams.slice(1);
    for (let r = 0; r < roundsPerCycle; r += 1) {
      round += 1;
      const lineup = [teams[0] as string, ...rotation];
      for (let i = 0; i < n / 2; i += 1) {
        const a = lineup[i] as string;
        const b = lineup[n - 1 - i] as string;
        // Venue by lineup position: the team at an even position is home, except the fixed team
        // (position 0) which alternates by round. The two positions of a pair (i, n-1-i) have
        // opposite parity because n-1 is odd, and every rotating team visits each position once
        // per cycle, so it is within one game of an even split (exactly even when the fixed team
        // is the bye). Odd cycles flip so pairs swap venues.
        const aHome = (i === 0 ? r % 2 === 0 : i % 2 === 0) !== (cycle % 2 === 1);
        const home = aHome ? a : b;
        const away = aHome ? b : a;
        if (home === BYE) {
          games.push({ key: `r${round}-bye`, round, homeEntryId: away, awayEntryId: null });
        } else if (away === BYE) {
          games.push({ key: `r${round}-bye`, round, homeEntryId: home, awayEntryId: null });
        } else {
          games.push({ key: `r${round}-g${i + 1}`, round, homeEntryId: home, awayEntryId: away });
        }
      }
      rotation.unshift(rotation.pop() as string);
    }
  }
  return { games, rounds: round };
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function inBlackout(date: string, blackouts: Blackout[]): boolean {
  return blackouts.some((b) => b.start <= date && date <= b.end);
}

function buildSlots(input: GeneratorInput): Slot[] {
  const slots: Slot[] = [];
  const timesByWeekday = new Map<number, string[]>();
  for (const t of input.allowedStartTimes) {
    const list = timesByWeekday.get(t.weekday) ?? [];
    if (!list.includes(t.time)) list.push(t.time);
    timesByWeekday.set(t.weekday, list);
  }
  for (const list of timesByWeekday.values()) list.sort();
  let date = input.startsOn;
  let guard = 0;
  while (date <= input.endsOn && guard < 5000) {
    guard += 1;
    if (!inBlackout(date, input.blackouts)) {
      const times = timesByWeekday.get(weekdayOf(date)) ?? [];
      times.forEach((time, position) => {
        const start = input.resolveInstant(date, time);
        if (!start) return;
        const end = new Date(start.getTime() + input.matchDurationMinutes * 60_000);
        for (const resourceId of input.resourceIds) {
          slots.push({
            index: slots.length,
            date,
            time,
            start,
            end,
            resourceId,
            isEarly: position === 0 && times.length > 1,
            isLate: position === times.length - 1 && times.length > 1,
          });
        }
      });
    }
    date = addDays(date, 1);
  }
  slots.sort((a, b) => a.start.getTime() - b.start.getTime() || a.index - b.index);
  slots.forEach((s, i) => {
    s.index = i;
  });
  return slots;
}

// ---------------------------------------------------------------------------------------------
// Seeded randomness (reproducible search; the seed is part of the recorded search settings)
// ---------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Assignment of games to slots
// ---------------------------------------------------------------------------------------------
interface TeamState {
  games: Array<{ slot: Slot; round: number; home: boolean; opponent: string | null }>;
}

function preference(
  input: GeneratorInput,
  kind: FairnessPreferenceKind,
): FairnessPreference | undefined {
  return input.fairnessPreferences.find((p) => p.kind === kind);
}

function preferredFor(input: GeneratorInput, teamEntryId: string): FairnessPreference[] {
  return input.fairnessPreferences.filter(
    (p) => p.kind === 'preferred_availability' && p.teamEntryId === teamEntryId,
  );
}

function matchesPreferred(slot: Slot, prefs: FairnessPreference[]): boolean {
  if (prefs.length === 0) return true;
  const weekday = weekdayOf(slot.date);
  return prefs.some((p) =>
    (p.startTimes ?? []).some((t) => t.weekday === weekday && t.time === slot.time),
  );
}

function feasibleForTeam(
  input: GeneratorInput,
  team: TeamState,
  teamId: string,
  slot: Slot,
  round: number,
  noConsecutiveHard: boolean,
): boolean {
  const rest = input.minimumRestMinutes * 60_000;
  for (const g of team.games) {
    const overlap = g.slot.start < slot.end && slot.start < g.slot.end;
    if (overlap) return false;
    const gap =
      g.slot.start < slot.start
        ? slot.start.getTime() - g.slot.end.getTime()
        : g.slot.start.getTime() - slot.end.getTime();
    if (gap < rest) return false;
    // rounds are played in order for every team
    if (g.round < round && g.slot.end > slot.start) return false;
    if (g.round > round && g.slot.start < slot.end) return false;
    if (noConsecutiveHard && g.slot.date === slot.date) return false;
  }
  const prefs = preferredFor(input, teamId);
  if (
    prefs.some((p) => p.hard) &&
    !matchesPreferred(
      slot,
      prefs.filter((p) => p.hard),
    )
  ) {
    return false;
  }
  return true;
}

/** Incremental soft penalty of placing the game in the slot (lower is better). */
function incrementalPenalty(
  input: GeneratorInput,
  states: Map<string, TeamState>,
  game: RoundRobinGame,
  slot: Slot,
): number {
  let penalty = 0;
  const teams = [game.homeEntryId, game.awayEntryId].filter((t): t is string => t !== null);
  const consecutive = preference(input, 'no_consecutive_games');
  const earlyLate = preference(input, 'early_late_distribution');
  const restPref = preference(input, 'rest_distribution');
  for (const teamId of teams) {
    const state = states.get(teamId);
    if (!state) continue;
    if (consecutive && state.games.some((g) => g.slot.date === slot.date)) {
      penalty += consecutive.weight;
    }
    if (earlyLate) {
      const early = state.games.filter((g) => g.slot.isEarly).length;
      const late = state.games.filter((g) => g.slot.isLate).length;
      if (slot.isEarly) penalty += earlyLate.weight * early * 0.5;
      if (slot.isLate) penalty += earlyLate.weight * late * 0.5;
    }
    if (restPref) {
      const previous = state.games.filter((g) => g.slot.end <= slot.start);
      const last = previous.sort((a, b) => b.slot.end.getTime() - a.slot.end.getTime())[0];
      if (last) {
        const hours = (slot.start.getTime() - last.slot.end.getTime()) / 3_600_000;
        if (hours < 24) penalty += restPref.weight * ((24 - hours) / 24);
      }
    }
    const prefs = preferredFor(input, teamId).filter((p) => !p.hard);
    if (prefs.length > 0 && !matchesPreferred(slot, prefs)) {
      penalty += Math.max(...prefs.map((p) => p.weight));
    }
  }
  return penalty;
}

function assign(
  input: GeneratorInput,
  games: RoundRobinGame[],
  slots: Slot[],
  random: () => number,
  jitter: boolean,
): Candidate {
  const states = new Map<string, TeamState>();
  for (const id of input.teamEntryIds) states.set(id, { games: [] });
  const used = new Set<number>();
  const assignments: Assignment[] = [];
  const noConsecutiveHard = preference(input, 'no_consecutive_games')?.hard ?? false;
  const rounds = groupRounds(games);
  for (const round of rounds) {
    const order = jitter ? shuffled(round, random) : round;
    for (const game of order) {
      if (game.awayEntryId === null) {
        assignments.push({ game, slot: null });
        continue;
      }
      const home = states.get(game.homeEntryId);
      const away = states.get(game.awayEntryId);
      if (!home || !away) {
        assignments.push({ game, slot: null });
        continue;
      }
      let best: { slot: Slot; score: number } | null = null;
      let considered = 0;
      for (const slot of slots) {
        if (used.has(slot.index)) continue;
        if (!feasibleForTeam(input, home, game.homeEntryId, slot, game.round, noConsecutiveHard)) {
          continue;
        }
        if (!feasibleForTeam(input, away, game.awayEntryId, slot, game.round, noConsecutiveHard)) {
          continue;
        }
        considered += 1;
        // earlier slots are preferred so the season progresses; the penalty steers fairness
        const score =
          incrementalPenalty(input, states, game, slot) * 1000 +
          considered +
          (jitter ? random() * 2 : 0);
        if (!best || score < best.score) best = { slot, score };
        if (considered >= SLOT_WINDOW) break;
      }
      if (!best) {
        assignments.push({ game, slot: null });
        continue;
      }
      used.add(best.slot.index);
      home.games.push({
        slot: best.slot,
        round: game.round,
        home: true,
        opponent: game.awayEntryId,
      });
      away.games.push({
        slot: best.slot,
        round: game.round,
        home: false,
        opponent: game.homeEntryId,
      });
      assignments.push({ game, slot: best.slot });
    }
  }
  const { violations, scores, penalty } = evaluate(input, states, assignments);
  return {
    assignments,
    hardViolations: violations,
    scores,
    penalty,
    unscheduled: assignments.filter((a) => a.game.awayEntryId !== null && a.slot === null).length,
  };
}

function groupRounds(games: RoundRobinGame[]): RoundRobinGame[][] {
  const byRound = new Map<number, RoundRobinGame[]>();
  for (const g of games) {
    const list = byRound.get(g.round) ?? [];
    list.push(g);
    byRound.set(g.round, list);
  }
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

/** Scores every fairness preference over the whole proposal; hard ones become violations. */
function evaluate(
  input: GeneratorInput,
  states: Map<string, TeamState>,
  assignments: Assignment[],
): { violations: ConstraintViolation[]; scores: PreferenceScore[]; penalty: number } {
  const violations: ConstraintViolation[] = [];
  const scores: PreferenceScore[] = [];
  let penalty = 0;
  const keysOf = (predicate: (a: Assignment) => boolean) =>
    assignments.filter((a) => a.slot !== null && predicate(a)).map((a) => a.game.key);
  const record = (
    pref: FairnessPreference,
    raw: number,
    explanation: string,
    violatingKeys: string[],
  ) => {
    const weighted = raw * pref.weight;
    scores.push({
      kind: pref.kind,
      hard: pref.hard,
      weight: pref.weight,
      penalty: weighted,
      explanation,
    });
    if (pref.hard && raw > 0) {
      violations.push({
        constraint: pref.kind,
        hard: true,
        message: explanation,
        gameKeys: violatingKeys,
      });
    } else {
      penalty += weighted;
    }
  };
  for (const pref of input.fairnessPreferences) {
    switch (pref.kind) {
      case 'home_away_balance': {
        let raw = 0;
        const imbalanced: string[] = [];
        for (const [teamId, state] of states) {
          const home = state.games.filter((g) => g.home).length;
          const away = state.games.length - home;
          const diff = Math.abs(home - away);
          if (diff > 1) {
            raw += diff - 1;
            imbalanced.push(teamId);
          }
        }
        record(
          pref,
          raw,
          raw === 0
            ? 'Every team is within one game of an even home/away split.'
            : `${imbalanced.length} team(s) have a home/away imbalance larger than one game.`,
          keysOf((a) => imbalanced.includes(a.game.homeEntryId)),
        );
        break;
      }
      case 'rest_distribution': {
        const shortest: number[] = [];
        for (const state of states.values()) {
          const sorted = [...state.games].sort(
            (a, b) => a.slot.start.getTime() - b.slot.start.getTime(),
          );
          let min = Number.POSITIVE_INFINITY;
          for (let i = 1; i < sorted.length; i += 1) {
            const gap =
              ((sorted[i] as TeamState['games'][number]).slot.start.getTime() -
                (sorted[i - 1] as TeamState['games'][number]).slot.end.getTime()) /
              3_600_000;
            min = Math.min(min, gap);
          }
          if (Number.isFinite(min)) shortest.push(min);
        }
        const spread = shortest.length > 1 ? Math.max(...shortest) - Math.min(...shortest) : 0;
        const matchHours = input.matchDurationMinutes / 60;
        const raw = pref.hard ? (spread > matchHours ? spread - matchHours : 0) : spread;
        record(
          pref,
          raw,
          `Shortest rests across teams spread over ${spread.toFixed(1)} hour(s)${pref.hard ? ` (hard limit: one match length, ${matchHours.toFixed(1)} h)` : ''}.`,
          [],
        );
        break;
      }
      case 'no_consecutive_games': {
        let raw = 0;
        const keys: string[] = [];
        for (const [teamId, state] of states) {
          const dates = new Map<string, number>();
          for (const g of state.games) dates.set(g.slot.date, (dates.get(g.slot.date) ?? 0) + 1);
          for (const [date, count] of dates) {
            if (count > 1) {
              raw += count - 1;
              keys.push(
                ...keysOf(
                  (a) =>
                    a.slot?.date === date &&
                    (a.game.homeEntryId === teamId || a.game.awayEntryId === teamId),
                ),
              );
            }
          }
        }
        record(
          pref,
          raw,
          raw === 0
            ? 'No team plays twice on one day.'
            : `${raw} occurrence(s) of a team playing twice on one day.`,
          [...new Set(keys)],
        );
        break;
      }
      case 'early_late_distribution': {
        const early: number[] = [];
        const late: number[] = [];
        for (const state of states.values()) {
          early.push(state.games.filter((g) => g.slot.isEarly).length);
          late.push(state.games.filter((g) => g.slot.isLate).length);
        }
        const spread = (xs: number[]) => (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0);
        const earlySpread = spread(early);
        const lateSpread = spread(late);
        const raw = Math.max(0, earlySpread - 1) + Math.max(0, lateSpread - 1);
        record(
          pref,
          raw,
          `Early-slot counts differ by ${earlySpread} and late-slot counts by ${lateSpread} across teams (balanced within one is the target).`,
          [],
        );
        break;
      }
      case 'no_repeated_opponents': {
        let raw = 0;
        const keys: string[] = [];
        for (const [teamId, state] of states) {
          const byRound = [...state.games].sort((a, b) => a.round - b.round);
          for (let i = 1; i < byRound.length; i += 1) {
            const current = byRound[i] as TeamState['games'][number];
            const previous = byRound[i - 1] as TeamState['games'][number];
            if (current.opponent !== null && current.opponent === previous.opponent) {
              raw += 1;
              keys.push(
                ...keysOf(
                  (a) =>
                    a.game.round === current.round &&
                    (a.game.homeEntryId === teamId || a.game.awayEntryId === teamId),
                ),
              );
            }
          }
        }
        record(
          pref,
          raw / 2,
          raw === 0
            ? 'No pair of teams meets in consecutive rounds.'
            : `${raw / 2} pairing(s) repeat in consecutive rounds.`,
          [...new Set(keys)],
        );
        break;
      }
      case 'preferred_availability': {
        const teamId = pref.teamEntryId;
        const state = teamId ? states.get(teamId) : undefined;
        if (!teamId || !state) {
          record(pref, 0, 'The preference names no competing team; nothing to score.', []);
          break;
        }
        const off = state.games.filter((g) => !matchesPreferred(g.slot, [pref])).length;
        record(
          pref,
          off,
          off === 0
            ? 'Every game of the team is at a preferred time.'
            : `${off} game(s) of the team are outside its preferred times.`,
          keysOf(
            (a) =>
              (a.game.homeEntryId === teamId || a.game.awayEntryId === teamId) &&
              a.slot !== null &&
              !matchesPreferred(a.slot, [pref]),
          ),
        );
        break;
      }
    }
  }
  return { violations, scores, penalty };
}

// ---------------------------------------------------------------------------------------------
// Completeness (SPK-FIX-002)
// ---------------------------------------------------------------------------------------------
export function validateCompleteness(
  input: Pick<
    GeneratorInput,
    | 'teamEntryIds'
    | 'gamesPerTeam'
    | 'opponentFrequency'
    | 'playoffStructure'
    | 'obligationDeadline'
  >,
  games: ProposedGame[],
): CompletenessReport {
  const issues: CompletenessIssue[] = [];
  const remaining: RemainingObligation[] = [];
  const teams = [...input.teamEntryIds].sort();
  const n = teams.length;
  const expectedPerTeam = (n - 1) * input.opponentFrequency;
  const expectedGames = (n * (n - 1) * input.opponentFrequency) / 2;
  const real = games.filter((g) => g.awayEntryId !== null);
  const byes = games.filter((g) => g.awayEntryId === null);

  if (input.gamesPerTeam !== expectedPerTeam) {
    issues.push({
      code: 'games_per_team_mismatch',
      message: `${input.gamesPerTeam} games per team were specified but ${n} teams meeting ${input.opponentFrequency} time(s) means ${expectedPerTeam} per team.`,
      teamEntryIds: teams,
      gameKeys: [],
    });
  }

  // meetings per pair
  const meetings = new Map<string, ProposedGame[]>();
  const pairKey = (a: string, b: string) => [a, b].sort().join('|');
  for (const g of real) {
    const key = pairKey(g.homeEntryId, g.awayEntryId as string);
    const list = meetings.get(key) ?? [];
    list.push(g);
    meetings.set(key, list);
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = teams[i] as string;
      const b = teams[j] as string;
      const list = meetings.get(pairKey(a, b)) ?? [];
      if (list.length < input.opponentFrequency) {
        issues.push({
          code: 'missing_fixture',
          message: `The pair meets ${list.length} time(s); ${input.opponentFrequency} required.`,
          teamEntryIds: [a, b],
          gameKeys: list.map((g) => g.key),
        });
      } else if (list.length > input.opponentFrequency) {
        issues.push({
          code: 'opponent_frequency',
          message: `The pair meets ${list.length} time(s); ${input.opponentFrequency} required.`,
          teamEntryIds: [a, b],
          gameKeys: list.map((g) => g.key),
        });
      }
      const rounds = new Map<number, ProposedGame[]>();
      for (const g of list) rounds.set(g.round, [...(rounds.get(g.round) ?? []), g]);
      for (const [round, dup] of rounds) {
        if (dup.length > 1) {
          issues.push({
            code: 'duplicate_fixture',
            message: `The pair is drawn ${dup.length} times in round ${round}.`,
            teamEntryIds: [a, b],
            gameKeys: dup.map((g) => g.key),
          });
        }
      }
    }
  }

  // games per team
  for (const team of teams) {
    const mine = real.filter((g) => g.homeEntryId === team || g.awayEntryId === team);
    if (mine.length > input.gamesPerTeam) {
      issues.push({
        code: 'excess_games',
        message: `The team has ${mine.length} games; ${input.gamesPerTeam} specified.`,
        teamEntryIds: [team],
        gameKeys: mine.map((g) => g.key),
      });
    }
  }

  // byes: odd counts need exactly one bye per team per cycle, none otherwise
  const expectedByes = n % 2 === 1 ? input.opponentFrequency : 0;
  const byeCounts = teams.map((team) => ({
    teamEntryId: team,
    count: byes.filter((g) => g.homeEntryId === team).length,
  }));
  for (const b of byeCounts) {
    if (b.count !== expectedByes) {
      issues.push({
        code: 'invalid_bye',
        message: `The team has ${b.count} bye(s); ${expectedByes} expected.`,
        teamEntryIds: [b.teamEntryId],
        gameKeys: byes.filter((g) => g.homeEntryId === b.teamEntryId).map((g) => g.key),
      });
    }
  }
  const byeRounds = new Map<number, ProposedGame[]>();
  for (const g of byes) byeRounds.set(g.round, [...(byeRounds.get(g.round) ?? []), g]);
  for (const [round, list] of byeRounds) {
    if (list.length > 1) {
      issues.push({
        code: 'invalid_bye',
        message: `Round ${round} has ${list.length} byes.`,
        teamEntryIds: list.map((g) => g.homeEntryId),
        gameKeys: list.map((g) => g.key),
      });
    }
  }

  // unscheduled games remain obligations with an owner and a deadline
  const unscheduled = real.filter((g) => g.scheduledStart === null);
  if (unscheduled.length > 0) {
    issues.push({
      code: 'unscheduled_game',
      message: `${unscheduled.length} game(s) have no slot.`,
      teamEntryIds: [
        ...new Set(unscheduled.flatMap((g) => [g.homeEntryId, g.awayEntryId as string])),
      ],
      gameKeys: unscheduled.map((g) => g.key),
    });
    remaining.push({
      code: 'unscheduled_games',
      message: `${unscheduled.length} game(s) must still be scheduled.`,
      owner: 'league_manager',
      deadline: input.obligationDeadline,
      gameKeys: unscheduled.map((g) => g.key),
    });
  }

  // playoffs
  if (input.playoffStructure) {
    if (input.playoffStructure.teams > n) {
      issues.push({
        code: 'playoff_unfulfilled',
        message: `${input.playoffStructure.teams} qualifiers are required but only ${n} teams compete.`,
        teamEntryIds: teams,
        gameKeys: [],
      });
    }
    remaining.push({
      code: 'playoff_bracket',
      message: `A ${input.playoffStructure.kind.replaceAll('_', ' ')} bracket for ${input.playoffStructure.teams} teams must be created once the league phase decides the seeds.`,
      owner: 'league_manager',
      deadline: null,
      gameKeys: [],
    });
  }

  return {
    complete: issues.length === 0 && remaining.length === 0,
    expectedGames,
    proposedGames: real.length,
    scheduledGames: real.length - unscheduled.length,
    byes: byeCounts,
    issues,
    remainingObligations: remaining,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
export function generateFixtures(
  input: GeneratorInput,
  settings: SearchSettings,
  now: () => number,
): GeneratorResult {
  const startedAt = now();
  const teamCount = input.teamEntryIds.length;
  const infeasible = (
    summary: string,
    violations: ConstraintViolation[] = [],
  ): GeneratorResult => ({
    outcome: 'proven_infeasible',
    proposal: null,
    completeness: validateCompleteness(input, []),
    explanation: {
      hardViolations: violations,
      preferenceScores: [],
      totalPenalty: 0,
      candidatesTried: 0,
      stoppedBy: 'proof',
      summary,
    },
  });

  if (teamCount < 2) return infeasible('Fewer than two teams: no fixture can be formed.');
  if (teamCount % 2 === 1 && !input.byesAllowed) {
    return infeasible(
      `${teamCount} teams is an odd count, so one team must sit out each round, but byes are not allowed.`,
    );
  }

  const { games } = roundRobin(input.teamEntryIds, input.opponentFrequency);
  const realGames = games.filter((g) => g.awayEntryId !== null);
  const slots = buildSlots(input);

  if (slots.length < realGames.length) {
    return infeasible(
      `${realGames.length} games need slots but only ${slots.length} slot(s) exist between ${input.startsOn} and ${input.endsOn} on ${input.resourceIds.length} resource(s) outside blackouts.`,
      [
        {
          constraint: 'capacity',
          hard: true,
          message: `${realGames.length} games, ${slots.length} slots.`,
          gameKeys: realGames.map((g) => g.key),
        },
      ],
    );
  }
  const gamesPerTeam = (teamCount - 1) * input.opponentFrequency;
  if (preference(input, 'no_consecutive_games')?.hard) {
    const dates = new Set(slots.map((s) => s.date)).size;
    if (dates < gamesPerTeam) {
      return infeasible(
        `Each team plays ${gamesPerTeam} games on distinct days (hard "no consecutive games") but only ${dates} playable day(s) exist.`,
        [
          {
            constraint: 'no_consecutive_games',
            hard: true,
            message: `${gamesPerTeam} games per team, ${dates} days.`,
            gameKeys: [],
          },
        ],
      );
    }
  }
  for (const pref of input.fairnessPreferences) {
    if (pref.kind !== 'preferred_availability' || !pref.hard || !pref.teamEntryId) continue;
    const matching = slots.filter((s) => matchesPreferred(s, [pref])).length;
    if (matching < gamesPerTeam) {
      return infeasible(
        `A hard availability preference leaves ${matching} matching slot(s) for a team that must play ${gamesPerTeam} games.`,
        [
          {
            constraint: 'preferred_availability',
            hard: true,
            message: `Team ${pref.teamEntryId}: ${matching} preferred slot(s) for ${gamesPerTeam} games.`,
            gameKeys: [],
          },
        ],
      );
    }
  }

  const random = mulberry32(settings.seed);
  let best: Candidate | null = null;
  let bestPartial: Candidate | null = null;
  let tried = 0;
  let stoppedBy: SolverExplanation['stoppedBy'] = 'candidate_limit';
  for (let i = 0; i < settings.maxCandidates; i += 1) {
    if (now() - startedAt > settings.timeLimitMs) {
      stoppedBy = 'time_limit';
      break;
    }
    tried += 1;
    const candidate = assign(input, games, slots, random, i > 0);
    const valid = candidate.unscheduled === 0 && candidate.hardViolations.length === 0;
    if (valid) {
      if (!best || candidate.penalty < best.penalty) best = candidate;
      if (best.penalty === 0) {
        stoppedBy = 'proof';
        break;
      }
    } else if (
      !bestPartial ||
      candidate.unscheduled < bestPartial.unscheduled ||
      (candidate.unscheduled === bestPartial.unscheduled &&
        candidate.hardViolations.length < bestPartial.hardViolations.length)
    ) {
      bestPartial = candidate;
    }
  }

  const toProposal = (candidate: Candidate): ProposedGame[] =>
    candidate.assignments.map((a) => ({
      key: a.game.key,
      round: a.game.round,
      homeEntryId: a.game.homeEntryId,
      awayEntryId: a.game.awayEntryId,
      fixtureId: null,
      scheduledStart: a.slot ? a.slot.start.toISOString() : null,
      scheduledEnd: a.slot ? a.slot.end.toISOString() : null,
      resourceId: a.slot ? a.slot.resourceId : null,
    }));

  if (best) {
    const proposalGames = toProposal(best);
    const completeness = validateCompleteness(input, proposalGames);
    const optimal = best.penalty === 0;
    return {
      outcome: optimal ? 'proven_optimal' : 'feasible',
      proposal: { games: proposalGames },
      completeness,
      explanation: {
        hardViolations: [],
        preferenceScores: best.scores,
        totalPenalty: best.penalty,
        candidatesTried: tried,
        stoppedBy,
        summary: optimal
          ? 'Every game is scheduled and no fairness preference is violated: the penalty of zero is the minimum possible, so the proposal is optimal.'
          : `Every game is scheduled with a fairness penalty of ${best.penalty.toFixed(2)} after ${tried} candidate(s); a better arrangement may exist, so optimality is not claimed.`,
      },
    };
  }

  const partial = bestPartial;
  const proposalGames = partial ? toProposal(partial) : [];
  const completeness = validateCompleteness(input, proposalGames);
  const conflicting = [...new Set((partial?.hardViolations ?? []).map((v) => v.constraint))];
  return {
    outcome: 'no_proposal_within_limit',
    proposal: partial ? { games: proposalGames } : null,
    completeness,
    explanation: {
      hardViolations: partial?.hardViolations ?? [],
      preferenceScores: partial?.scores ?? [],
      totalPenalty: partial?.penalty ?? 0,
      candidatesTried: tried,
      stoppedBy,
      summary: [
        `No proposal satisfied every hard constraint within ${tried} candidate(s)${stoppedBy === 'time_limit' ? ' before the time limit' : ''}.`,
        partial && partial.unscheduled > 0
          ? `${partial.unscheduled} game(s) could not be placed under the minimum rest, round order and allowed times.`
          : null,
        conflicting.length > 0
          ? `Hard preferences that could not be met together: ${conflicting.map((c) => c.replaceAll('_', ' ')).join(', ')}. Relax one of them or mark it as a preference.`
          : null,
        'Infeasibility is not proven: a larger search or different inputs may still find a proposal.',
      ]
        .filter((s): s is string => s !== null)
        .join(' '),
    },
  };
}
