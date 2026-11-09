/**
 * Single-elimination bracket plan (SPK-COMP-001 bracket progression, SPK-AT-014): the nodes a
 * playoff of `teams` entries needs, from a playoff structure the league manager specifies.
 *
 * Seeds are paired in the standard order (1 v N, then the order that keeps seeds 1 and 2 apart
 * until the final). When `teams` is not a power of two, the top seeds take the byes: a pairing
 * whose second seed does not exist creates no node, and the next round's slot takes the seed
 * directly, so every node is a real game and progression never waits on a bye.
 */
export type PlannedSource =
  { kind: 'seed'; seed: number } | { kind: 'winner_of'; round: number; slot: number };

export interface PlannedNode {
  round: number;
  slot: number;
  name: string;
  home: PlannedSource;
  away: PlannedSource;
}

/** Seed positions in bracket order: [1, 8, 4, 5, 2, 7, 3, 6] for 8 places. */
export function bracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

function roundName(round: number, rounds: number, slot: number, slotsInRound: number): string {
  const fromEnd = rounds - round;
  const base =
    fromEnd === 0
      ? 'Final'
      : fromEnd === 1
        ? 'Semifinal'
        : fromEnd === 2
          ? 'Quarterfinal'
          : `Round of ${2 ** (fromEnd + 1)}`;
  return slotsInRound > 1 ? `${base} ${slot}` : base;
}

export function planSingleElimination(teams: number): PlannedNode[] {
  if (!Number.isInteger(teams) || teams < 2) {
    throw new Error('a single-elimination bracket needs at least two entries');
  }
  let size = 1;
  while (size < teams) size *= 2;
  const rounds = Math.log2(size);
  const order = bracketOrder(size);
  const nodes: PlannedNode[] = [];
  // What each position of the previous round hands to the next: a node's winner or a seed.
  let feeders: PlannedSource[] = [];
  for (let slot = 1; slot <= size / 2; slot += 1) {
    const high = order[(slot - 1) * 2] as number;
    const low = order[(slot - 1) * 2 + 1] as number;
    if (low > teams) {
      feeders.push({ kind: 'seed', seed: high });
      continue;
    }
    nodes.push({
      round: 1,
      slot,
      name: roundName(1, rounds, slot, size / 2),
      home: { kind: 'seed', seed: high },
      away: { kind: 'seed', seed: low },
    });
    feeders.push({ kind: 'winner_of', round: 1, slot });
  }
  for (let round = 2; round <= rounds; round += 1) {
    const slots = feeders.length / 2;
    const next: PlannedSource[] = [];
    for (let slot = 1; slot <= slots; slot += 1) {
      nodes.push({
        round,
        slot,
        name: roundName(round, rounds, slot, slots),
        home: feeders[(slot - 1) * 2] as PlannedSource,
        away: feeders[(slot - 1) * 2 + 1] as PlannedSource,
      });
      next.push({ kind: 'winner_of', round, slot });
    }
    feeders = next;
  }
  return nodes;
}
