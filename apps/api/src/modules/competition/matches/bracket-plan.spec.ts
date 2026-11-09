import { describe, expect, it } from 'vitest';
import { bracketOrder, planSingleElimination } from './bracket-plan';

describe('single-elimination bracket plan (SPK-COMP-001 bracket progression)', () => {
  it('SPK-COMP-001: eight entries give seven games in three rounds, 1 v 8 and 2 v 7 on opposite halves', () => {
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const plan = planSingleElimination(8);
    expect(plan).toHaveLength(7);
    expect(plan.filter((n) => n.round === 1).map((n) => [n.home, n.away])).toEqual([
      [
        { kind: 'seed', seed: 1 },
        { kind: 'seed', seed: 8 },
      ],
      [
        { kind: 'seed', seed: 4 },
        { kind: 'seed', seed: 5 },
      ],
      [
        { kind: 'seed', seed: 2 },
        { kind: 'seed', seed: 7 },
      ],
      [
        { kind: 'seed', seed: 3 },
        { kind: 'seed', seed: 6 },
      ],
    ]);
    expect(plan.find((n) => n.round === 2 && n.slot === 1)).toMatchObject({
      name: 'Semifinal 1',
      home: { kind: 'winner_of', round: 1, slot: 1 },
      away: { kind: 'winner_of', round: 1, slot: 2 },
    });
    expect(plan.at(-1)).toMatchObject({
      round: 3,
      slot: 1,
      name: 'Final',
      home: { kind: 'winner_of', round: 2, slot: 1 },
      away: { kind: 'winner_of', round: 2, slot: 2 },
    });
    expect(plan[0]?.name).toBe('Quarterfinal 1');
  });

  it('SPK-COMP-001: six entries give the top two seeds byes straight into the semifinals; no node waits on a bye', () => {
    const plan = planSingleElimination(6);
    expect(plan).toHaveLength(5);
    expect(plan.filter((n) => n.round === 1).map((n) => [n.slot, n.home, n.away])).toEqual([
      [2, { kind: 'seed', seed: 4 }, { kind: 'seed', seed: 5 }],
      [4, { kind: 'seed', seed: 3 }, { kind: 'seed', seed: 6 }],
    ]);
    expect(plan.filter((n) => n.round === 2).map((n) => [n.home, n.away])).toEqual([
      [
        { kind: 'seed', seed: 1 },
        { kind: 'winner_of', round: 1, slot: 2 },
      ],
      [
        { kind: 'seed', seed: 2 },
        { kind: 'winner_of', round: 1, slot: 4 },
      ],
    ]);
    // Every winner_of names a node that exists.
    for (const node of plan) {
      for (const source of [node.home, node.away]) {
        if (source.kind === 'winner_of') {
          expect(plan.some((n) => n.round === source.round && n.slot === source.slot)).toBe(true);
        }
      }
    }
  });

  it('two entries are a single final; fewer are refused', () => {
    expect(planSingleElimination(2)).toEqual([
      {
        round: 1,
        slot: 1,
        name: 'Final',
        home: { kind: 'seed', seed: 1 },
        away: { kind: 'seed', seed: 2 },
      },
    ]);
    expect(() => planSingleElimination(1)).toThrow(/at least two/);
    expect(planSingleElimination(64)).toHaveLength(63);
  });
});
