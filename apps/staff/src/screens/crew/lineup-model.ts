/**
 * The lineup's rules (staff redesign Phase 8 item 2), as pure functions the screen and its tests
 * share: formations and their places, the bench order (fewest minutes this season first, ▲ when
 * below the team average), placing or swapping a player, and "Auto-fill fairly".
 */
import type { Schema } from '@sportspark/api-client';

export type TeamSheetPlayer = Schema<'TeamSheetPlayer'>;

/** 7v7 shapes from the back (the goalkeeper is slot 1 and not written), then 5v5 and 9v9. */
export const FORMATIONS = ['2-3-1', '3-2-1', '2-2-2', '1-2-1', '3-3-2'] as const;
export const DEFAULT_FORMATION = '2-3-1';

/** Starting places of a formation: its outfield players plus the goalkeeper. */
export function placesOf(formation: string): number {
  return formation.split('-').reduce((sum, n) => sum + Number(n), 0) + 1;
}

export interface LineupRow {
  /** 0 is the goalkeeper's line; then the outfield lines from the back. */
  line: number;
  slots: number[];
}

/** The slots of each line: [1], then e.g. [2, 3], [4, 5, 6], [7] for 2-3-1. */
export function rowsOf(formation: string): LineupRow[] {
  const rows: LineupRow[] = [{ line: 0, slots: [1] }];
  let next = 2;
  formation.split('-').forEach((n, i) => {
    const count = Number(n);
    rows.push({ line: i + 1, slots: Array.from({ length: count }, (_, k) => next + k) });
    next += count;
  });
  return rows;
}

const LINE_NAMES = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];

/** "Goalkeeper", "Defender 2", "Forward": the place's name for screen readers and the hint. */
export function placeName(formation: string, slot: number): string {
  const rows = rowsOf(formation);
  const lines = rows.length - 1;
  const row = rows.find((r) => r.slots.includes(slot));
  if (!row) return `Place ${slot}`;
  if (row.line === 0) return 'Goalkeeper';
  // Two outfield lines: defence and attack; three: defence, midfield, attack; four: two midfields.
  const name =
    row.line === lines
      ? 'Forward'
      : row.line === 1
        ? 'Defender'
        : (LINE_NAMES[Math.min(row.line, 2)] ?? 'Midfielder');
  return row.slots.length > 1 ? `${name} ${row.slots.indexOf(slot) + 1}` : name;
}

/** "GK", "DEF", "MID", "FWD": the place's short label on the pitch. */
export function placeShort(formation: string, slot: number): string {
  const name = placeName(formation, slot);
  if (name === 'Goalkeeper') return 'GK';
  if (name.startsWith('Defender')) return 'DEF';
  if (name.startsWith('Forward')) return 'FWD';
  return 'MID';
}

/** slot → personId */
export type Placement = Readonly<Record<number, string>>;

export function placementOf(slots: readonly { slot: number; personId: string }[]): Placement {
  return Object.fromEntries(slots.map((s) => [s.slot, s.personId]));
}

export function slotsOf(
  placement: Placement,
  formation: string,
): { slot: number; personId: string }[] {
  const places = placesOf(formation);
  return Object.entries(placement)
    .map(([slot, personId]) => ({ slot: Number(slot), personId }))
    .filter((s) => s.slot >= 1 && s.slot <= places)
    .sort((a, b) => a.slot - b.slot);
}

/** Only the players who answered Going appear (Phase 8 item 2). */
export function goingPlayers(players: readonly TeamSheetPlayer[]): TeamSheetPlayer[] {
  return players.filter((p) => p.availability === 'available');
}

function fairOrder(a: TeamSheetPlayer, b: TeamSheetPlayer): number {
  return (
    a.minutesThisSeason - b.minutesThisSeason ||
    (a.jerseyNumber ?? 999) - (b.jerseyNumber ?? 999) ||
    a.displayName.localeCompare(b.displayName)
  );
}

/** The bench: Going players not on the pitch, fewest minutes this season first. */
export function benchOf(
  players: readonly TeamSheetPlayer[],
  placement: Placement,
): TeamSheetPlayer[] {
  const placed = new Set(Object.values(placement));
  return goingPlayers(players)
    .filter((p) => !placed.has(p.personId))
    .sort(fairOrder);
}

/** ▲ amber on the bench: fewer minutes this season than the team's average. */
export function belowAverage(player: TeamSheetPlayer, average: number): boolean {
  return player.minutesThisSeason < average;
}

export type Spot = { kind: 'slot'; slot: number } | { kind: 'bench'; personId: string };

/**
 * Drop `from` on `to`: a bench player onto a place takes it (whoever stood there goes to the
 * bench), two places swap their players, a place dropped on the bench is emptied.
 */
export function placeOrSwap(placement: Placement, from: Spot, to: Spot): Placement {
  const next: Record<number, string> = { ...placement };
  const personAt = (s: Spot) => (s.kind === 'slot' ? next[s.slot] : s.personId);
  const moving = personAt(from);
  if (!moving) return placement;
  if (to.kind === 'bench') {
    if (from.kind === 'slot') delete next[from.slot];
    return next;
  }
  const there = next[to.slot];
  if (from.kind === 'slot') {
    if (from.slot === to.slot) return placement;
    if (there) next[from.slot] = there;
    else delete next[from.slot];
  }
  for (const [slot, personId] of Object.entries(next)) {
    if (personId === moving) delete next[Number(slot)];
  }
  next[to.slot] = moving;
  return next;
}

/**
 * "Auto-fill fairly": the goalkeeper stays when one is placed; every other place goes to the
 * Going players with the fewest minutes this season (ties: jersey number, then name).
 */
export function autoFillFairly(
  players: readonly TeamSheetPlayer[],
  placement: Placement,
  formation: string,
): Placement {
  const places = placesOf(formation);
  const keeper = placement[1];
  const going = goingPlayers(players);
  const keeperGoing = keeper && going.some((p) => p.personId === keeper) ? keeper : undefined;
  const order = going.filter((p) => p.personId !== keeperGoing).sort(fairOrder);
  const next: Record<number, string> = {};
  let slot = 1;
  if (keeperGoing) {
    next[1] = keeperGoing;
    slot = 2;
  }
  for (const p of order) {
    if (slot > places) break;
    next[slot] = p.personId;
    slot += 1;
  }
  return next;
}

export function samePlacement(a: Placement, b: Placement): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[Number(k)] === b[Number(k)]);
}

/** "Ava K." */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0)}.`;
}
