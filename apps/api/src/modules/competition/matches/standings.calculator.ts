import type {
  CardKind,
  ResultCard,
  ResultClassification,
  RuleSetContent,
  StandingsRow,
  TiebreakExplanation,
} from '@sportspark/contracts';

/**
 * Pure standings computation (SPK-RESULT-001: official results only — the caller passes nothing
 * else; SPK-RESULT-003: the versioned rule set decides points, forfeits, abandonment and the
 * ordered tiebreakers, and every tie is explained step by step). Deterministic: no clock, no
 * randomness; a draw of lots or play-off is reported as unresolved, never simulated.
 */

export interface StandingsEntry {
  teamEntryId: string;
  teamName: string;
}

export interface OfficialResultInput {
  id: string;
  fixtureId: string;
  homeEntryId: string;
  awayEntryId: string;
  homeScore: number | null;
  awayScore: number | null;
  classification: ResultClassification;
  forfeitingEntryId: string | null;
  cards: ResultCard[];
  abandonmentMinutePlayed: number | null;
}

export interface StandingsComputation {
  rows: StandingsRow[];
  tiebreakExplanations: TiebreakExplanation[];
  /** Results that counted toward the table (completed, forfeits and abandonments that stand). */
  countedResultIds: string[];
}

type Tiebreaker = RuleSetContent['tiebreakers'][number];
type Step = TiebreakExplanation['steps'][number];

interface Tally {
  teamEntryId: string;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  fairPlayPoints: number;
  forfeits: number;
}

interface CountedGame {
  homeEntryId: string;
  awayEntryId: string;
  homeScore: number;
  awayScore: number;
  homePoints: number;
  awayPoints: number;
}

export function computeStandings(
  rules: RuleSetContent,
  entries: StandingsEntry[],
  results: OfficialResultInput[],
  fairPlayPoints: Readonly<Record<CardKind, number>>,
): StandingsComputation {
  const tallies = new Map<string, Tally>();
  for (const entry of entries) {
    tallies.set(entry.teamEntryId, {
      teamEntryId: entry.teamEntryId,
      teamName: entry.teamName,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      fairPlayPoints: 0,
      forfeits: 0,
    });
  }
  const games: CountedGame[] = [];
  const countedResultIds: string[] = [];

  for (const result of results) {
    const home = tallies.get(result.homeEntryId);
    const away = tallies.get(result.awayEntryId);
    if (!home || !away) continue;
    const counted = countedGame(rules, result);
    if (!counted) continue;
    countedResultIds.push(result.id);
    games.push(counted);
    apply(home, counted.homeScore, counted.awayScore, counted.homePoints);
    apply(away, counted.awayScore, counted.homeScore, counted.awayPoints);
    if (result.classification === 'forfeit') {
      if (result.forfeitingEntryId === home.teamEntryId) home.forfeits += 1;
      if (result.forfeitingEntryId === away.teamEntryId) away.forfeits += 1;
    }
    for (const card of result.cards) {
      const tally = tallies.get(card.teamEntryId);
      if (tally) tally.fairPlayPoints += fairPlayPoints[card.kind] ?? 0;
    }
  }

  const explanations: TiebreakExplanation[] = [];
  const byPoints = [...tallies.values()].sort(
    (a, b) => b.points - a.points || a.teamEntryId.localeCompare(b.teamEntryId),
  );
  const ordered: Tally[] = [];
  for (const group of groupBy(byPoints, (t) => String(t.points))) {
    if (group.length === 1) {
      ordered.push(...group);
      continue;
    }
    const steps: Step[] = [];
    let resolved = true;
    const result = resolveTie(group, rules.tiebreakers, 0, games, steps, () => {
      resolved = false;
    });
    explanations.push({
      teamEntryIds: group.map((t) => t.teamEntryId),
      points: group[0]?.points ?? 0,
      steps,
      resolved,
    });
    ordered.push(...result);
  }

  const rows: StandingsRow[] = ordered.map((t, index) => ({
    position: index + 1,
    teamEntryId: t.teamEntryId,
    teamName: t.teamName,
    played: t.played,
    won: t.won,
    drawn: t.drawn,
    lost: t.lost,
    goalsFor: t.goalsFor,
    goalsAgainst: t.goalsAgainst,
    goalDifference: t.goalsFor - t.goalsAgainst,
    points: t.points,
    fairPlayPoints: t.fairPlayPoints,
    forfeits: t.forfeits,
  }));
  return { rows, tiebreakExplanations: explanations, countedResultIds };
}

/** Whether and how a result counts (SPK-RESULT-002 classifications under the rule set). */
function countedGame(rules: RuleSetContent, result: OfficialResultInput): CountedGame | null {
  const { scoring } = rules;
  switch (result.classification) {
    case 'completed':
      return scored(result.homeEntryId, result.awayEntryId, result, scoring);
    case 'forfeit': {
      const forfeitingHome = result.forfeitingEntryId === result.homeEntryId;
      const homeScore = forfeitingHome ? rules.forfeit.scoreAgainst : rules.forfeit.scoreFor;
      const awayScore = forfeitingHome ? rules.forfeit.scoreFor : rules.forfeit.scoreAgainst;
      return {
        homeEntryId: result.homeEntryId,
        awayEntryId: result.awayEntryId,
        homeScore,
        awayScore,
        homePoints: forfeitingHome ? scoring.forfeitLoss : scoring.forfeitWin,
        awayPoints: forfeitingHome ? scoring.forfeitWin : scoring.forfeitLoss,
      };
    }
    case 'abandoned': {
      const minimum = rules.abandonment.minimumMinutesForResult;
      if (
        rules.abandonment.policy === 'result_stands_if_minimum_played' &&
        minimum !== null &&
        result.abandonmentMinutePlayed !== null &&
        result.abandonmentMinutePlayed >= minimum
      ) {
        return scored(result.homeEntryId, result.awayEntryId, result, scoring);
      }
      return null;
    }
    case 'canceled':
    case 'postponed':
    case 'disputed':
      return null;
  }
}

function scored(
  homeEntryId: string,
  awayEntryId: string,
  result: OfficialResultInput,
  scoring: RuleSetContent['scoring'],
): CountedGame | null {
  if (result.homeScore === null || result.awayScore === null) return null;
  const homeScore = result.homeScore;
  const awayScore = result.awayScore;
  const homePoints =
    homeScore > awayScore ? scoring.win : homeScore === awayScore ? scoring.draw : scoring.loss;
  const awayPoints =
    awayScore > homeScore ? scoring.win : homeScore === awayScore ? scoring.draw : scoring.loss;
  return { homeEntryId, awayEntryId, homeScore, awayScore, homePoints, awayPoints };
}

function apply(tally: Tally, goalsFor: number, goalsAgainst: number, points: number): void {
  tally.played += 1;
  tally.goalsFor += goalsFor;
  tally.goalsAgainst += goalsAgainst;
  tally.points += points;
  if (goalsFor > goalsAgainst) tally.won += 1;
  else if (goalsFor === goalsAgainst) tally.drawn += 1;
  else tally.lost += 1;
}

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let currentKey: string | null = null;
  for (const item of items) {
    const k = key(item);
    if (currentKey === null || k !== currentKey) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentKey = k;
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Orders a tied group by applying the rule set's tiebreakers in order; sub-ties continue with the
 * next tiebreaker. Head-to-head is evaluated among the teams still tied at that step.
 */
function resolveTie(
  group: Tally[],
  tiebreakers: readonly Tiebreaker[],
  index: number,
  games: CountedGame[],
  steps: Step[],
  markUnresolved: () => void,
): Tally[] {
  if (group.length <= 1) return group;
  const tiebreaker = tiebreakers[index];
  if (tiebreaker === undefined) {
    markUnresolved();
    steps.push({
      tiebreaker: 'exhausted',
      outcome: 'unresolved',
      values: group.map((t) => ({ teamEntryId: t.teamEntryId, value: '' })),
      explanation: `${group.length} teams remain level after every tiebreaker in the rule set; a league decision is required.`,
    });
    return [...group].sort((a, b) => a.teamEntryId.localeCompare(b.teamEntryId));
  }
  if (tiebreaker === 'draw_of_lots' || tiebreaker === 'play_off') {
    markUnresolved();
    steps.push({
      tiebreaker,
      outcome: 'unresolved',
      values: group.map((t) => ({ teamEntryId: t.teamEntryId, value: '' })),
      explanation:
        tiebreaker === 'draw_of_lots'
          ? `${group.length} teams remain level; the rule set requires a draw of lots, which is recorded by the league manager, not computed.`
          : `${group.length} teams remain level; the rule set requires a play-off, which must be scheduled and played.`,
    });
    return [...group].sort((a, b) => a.teamEntryId.localeCompare(b.teamEntryId));
  }
  const values = new Map<string, { sortValue: number; display: string }>();
  for (const team of group) values.set(team.teamEntryId, valueFor(tiebreaker, team, group, games));
  const sorted = [...group].sort(
    (a, b) =>
      (values.get(b.teamEntryId)?.sortValue ?? 0) - (values.get(a.teamEntryId)?.sortValue ?? 0) ||
      a.teamEntryId.localeCompare(b.teamEntryId),
  );
  const subgroups = groupBy(sorted, (t) => String(values.get(t.teamEntryId)?.sortValue ?? 0));
  const outcome: Step['outcome'] =
    subgroups.length === group.length
      ? 'resolved'
      : subgroups.length === 1
        ? 'not_separating'
        : 'partially_resolved';
  steps.push({
    tiebreaker,
    outcome,
    values: sorted.map((t) => ({
      teamEntryId: t.teamEntryId,
      value: values.get(t.teamEntryId)?.display ?? '',
    })),
    explanation: explain(tiebreaker, outcome, subgroups),
  });
  const out: Tally[] = [];
  for (const sub of subgroups) {
    out.push(...resolveTie(sub, tiebreakers, index + 1, games, steps, markUnresolved));
  }
  return out;
}

function valueFor(
  tiebreaker: Exclude<Tiebreaker, 'draw_of_lots' | 'play_off'>,
  team: Tally,
  group: Tally[],
  games: CountedGame[],
): { sortValue: number; display: string } {
  switch (tiebreaker) {
    case 'points':
      return { sortValue: team.points, display: `${team.points} pts` };
    case 'head_to_head': {
      const ids = new Set(group.map((t) => t.teamEntryId));
      let points = 0;
      let played = 0;
      for (const game of games) {
        if (!ids.has(game.homeEntryId) || !ids.has(game.awayEntryId)) continue;
        if (game.homeEntryId === team.teamEntryId) {
          points += game.homePoints;
          played += 1;
        } else if (game.awayEntryId === team.teamEntryId) {
          points += game.awayPoints;
          played += 1;
        }
      }
      return { sortValue: points, display: `${points} pts in ${played} head-to-head game(s)` };
    }
    case 'goal_difference': {
      const gd = team.goalsFor - team.goalsAgainst;
      return { sortValue: gd, display: `${gd >= 0 ? '+' : ''}${gd}` };
    }
    case 'goals_for':
      return { sortValue: team.goalsFor, display: `${team.goalsFor} scored` };
    case 'goals_against':
      return { sortValue: -team.goalsAgainst, display: `${team.goalsAgainst} conceded` };
    case 'wins':
      return { sortValue: team.won, display: `${team.won} win(s)` };
    case 'fair_play':
      return {
        sortValue: -team.fairPlayPoints,
        display: `${team.fairPlayPoints} fair-play penalty point(s)`,
      };
  }
}

function explain(tiebreaker: Tiebreaker, outcome: Step['outcome'], subgroups: Tally[][]): string {
  const label = tiebreaker.replaceAll('_', ' ');
  switch (outcome) {
    case 'resolved':
      return `${label} separates every team in the group.`;
    case 'partially_resolved':
      return `${label} separates the group into ${subgroups.length} levels; remaining ties continue with the next tiebreaker.`;
    case 'not_separating':
      return `${label} is identical for every team in the group; the next tiebreaker applies.`;
    case 'unresolved':
      return `${label} cannot be computed.`;
  }
}
