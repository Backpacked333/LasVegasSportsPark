import { newId, type RuleSetContent } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { FAIR_PLAY_POINTS } from '../competition-matches.policy';
import { proposedRuleSetContent } from '../competition.policy';
import { computeStandings, type OfficialResultInput } from './standings.calculator';

const A = newId();
const B = newId();
const C = newId();
const D = newId();
const entries = [
  { teamEntryId: A, teamName: 'A' },
  { teamEntryId: B, teamName: 'B' },
  { teamEntryId: C, teamName: 'C' },
  { teamEntryId: D, teamName: 'D' },
];

function result(
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  extra: Partial<OfficialResultInput> = {},
): OfficialResultInput {
  return {
    id: newId(),
    fixtureId: newId(),
    homeEntryId: home,
    awayEntryId: away,
    homeScore,
    awayScore,
    classification: 'completed',
    forfeitingEntryId: null,
    cards: [],
    abandonmentMinutePlayed: null,
    ...extra,
  };
}

const rules = (overrides: Partial<RuleSetContent> = {}): RuleSetContent => ({
  ...proposedRuleSetContent('small_sided_other'),
  ...overrides,
});

describe('standings calculator (SPK-RESULT-001/002/003)', () => {
  it('SPK-RESULT-003: points come from the versioned rule set and every tie is explained step by step', () => {
    // A beat B 2-0, B beat C 1-0, C beat A 3-1: all on 3 points. D played nobody.
    const results = [result(A, B, 2, 0), result(B, C, 1, 0), result(C, A, 3, 1)];
    const table = computeStandings(
      rules({
        tiebreakers: ['points', 'head_to_head', 'goal_difference', 'goals_for', 'draw_of_lots'],
      }),
      entries,
      results,
      FAIR_PLAY_POINTS,
    );
    expect(table.rows.map((r) => r.points)).toEqual([3, 3, 3, 0]);
    // head-to-head among the three is a perfect cycle (3 points each) → not separating;
    // goal difference: C +2, A 0, B -2 → resolved
    expect(table.rows.map((r) => r.teamName)).toEqual(['C', 'A', 'B', 'D']);
    expect(table.tiebreakExplanations).toHaveLength(1);
    const explanation = table.tiebreakExplanations[0];
    expect(explanation?.resolved).toBe(true);
    expect(explanation?.steps.map((s) => [s.tiebreaker, s.outcome])).toEqual([
      ['points', 'not_separating'],
      ['head_to_head', 'not_separating'],
      ['goal_difference', 'resolved'],
    ]);
    expect(table.countedResultIds).toHaveLength(3);
    expect(table.rows[0]).toMatchObject({ position: 1, played: 2, won: 1, lost: 1, goalsFor: 3 });
  });

  it('SPK-RESULT-003: a draw of lots is reported as unresolved, never simulated; head-to-head separates when it can', () => {
    // A and B drew 1-1 with each other and both beat C and D identically: level on everything.
    const results = [
      result(A, B, 1, 1),
      result(A, C, 2, 0),
      result(B, D, 2, 0),
      result(C, D, 0, 0),
    ];
    const table = computeStandings(
      rules({ tiebreakers: ['points', 'head_to_head', 'goal_difference', 'draw_of_lots'] }),
      entries,
      results,
      FAIR_PLAY_POINTS,
    );
    const top = table.tiebreakExplanations.find((e) => e.points === 4);
    expect(top?.resolved).toBe(false);
    expect(top?.steps.at(-1)).toMatchObject({ tiebreaker: 'draw_of_lots', outcome: 'unresolved' });
    // C and D (1 point each): head-to-head was a draw, goal difference separates (C -2, D -2)… equal → draw of lots
    const bottom = table.tiebreakExplanations.find((e) => e.points === 1);
    expect(bottom?.resolved).toBe(false);
    // the rule set exhausted without a draw of lots is also honest
    const exhausted = computeStandings(
      rules({ tiebreakers: ['points'] }),
      entries,
      results,
      FAIR_PLAY_POINTS,
    );
    expect(exhausted.tiebreakExplanations[0]?.steps.at(-1)).toMatchObject({
      tiebreaker: 'exhausted',
      outcome: 'unresolved',
    });
  });

  it('SPK-RESULT-002: forfeits use the rule set forfeit score and points; cancellations, postponements, disputes and short abandonments do not count', () => {
    const r = rules({
      abandonment: { minimumMinutesForResult: 45, policy: 'result_stands_if_minimum_played' },
    });
    const results = [
      result(A, B, 0, 0, { classification: 'forfeit', forfeitingEntryId: B }),
      result(C, D, 5, 5, { classification: 'canceled' }),
      result(A, C, 4, 0, { classification: 'postponed' }),
      result(B, D, 9, 0, { classification: 'disputed' }),
      result(C, A, 1, 0, { classification: 'abandoned', abandonmentMinutePlayed: 20 }),
      result(D, B, 2, 1, { classification: 'abandoned', abandonmentMinutePlayed: 50 }),
    ];
    const table = computeStandings(r, entries, results, FAIR_PLAY_POINTS);
    const row = (id: string) => table.rows.find((x) => x.teamEntryId === id);
    expect(row(A)).toMatchObject({
      played: 1,
      won: 1,
      points: r.scoring.forfeitWin,
      goalsFor: r.forfeit.scoreFor,
      goalsAgainst: r.forfeit.scoreAgainst,
      forfeits: 0,
    });
    expect(row(B)).toMatchObject({
      played: 2,
      lost: 2,
      points: r.scoring.forfeitLoss,
      forfeits: 1,
    });
    expect(row(D)).toMatchObject({ played: 1, won: 1, points: r.scoring.win });
    expect(row(C)).toMatchObject({ played: 0, points: 0 });
    expect(table.countedResultIds).toHaveLength(2);
  });

  it('fair play uses card penalty points as a tiebreaker (lower is better) and results of teams outside the scope are ignored', () => {
    const results = [
      result(A, B, 1, 1, {
        cards: [{ personId: newId(), teamEntryId: A, kind: 'yellow', minute: 10 }],
      }),
      result(C, newId(), 3, 0),
    ];
    const table = computeStandings(
      rules({ tiebreakers: ['points', 'fair_play'] }),
      entries,
      results,
      FAIR_PLAY_POINTS,
    );
    expect(table.rows.slice(0, 2).map((r) => r.teamName)).toEqual(['B', 'A']);
    expect(table.rows[1]?.fairPlayPoints).toBe(FAIR_PLAY_POINTS.yellow);
    expect(table.rows.find((r) => r.teamName === 'C')?.played).toBe(0);
    expect(table.countedResultIds).toHaveLength(1);
  });
});
