/**
 * Pure rules of the coach's attendance tiles (staff S 2d; INTERACTIONS "2d · Coach: attendance";
 * SPK-ENTRY-005, §4.7 invariant 9) and of the coach's "now" session (SPK-UX-007).
 *
 * - A tap cycles Unmarked → ✓ Here → ◷ Late → Unmarked; a long press marks ✕ Absent; a tap on an
 *   absent child marks them here.
 * - Observations are never removed (append-only, corrections are new rows): once a mark has been
 *   sent, the cycle skips Unmarked (Here ↔ Late), and changing it is a correction. Before it is
 *   sent (within the Undo window) every step, Unmarked included, stays on the device.
 */
import type { Schema } from '@sportspark/api-client';

export type TileState = 'unmarked' | 'present' | 'late' | 'absent';
type ObservedState = Schema<'ObservedState'>;
type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;

export const TILE_LABEL: Record<TileState, { glyph: string; word: string }> = {
  unmarked: { glyph: '', word: 'Unmarked' },
  present: { glyph: '✓', word: 'Here' },
  late: { glyph: '◷', word: 'Late' },
  absent: { glyph: '✕', word: 'Absent' },
};

/** The next state on a tap. `recorded`: a mark has reached the service (no way back to Unmarked). */
export function nextOnTap(current: TileState, recorded: boolean): TileState {
  switch (current) {
    case 'unmarked':
      return 'present';
    case 'present':
      return 'late';
    case 'late':
      return recorded ? 'present' : 'unmarked';
    case 'absent':
      return 'present';
  }
}

/** The tile state of an observed state ("left early" counts as here on the tiles). */
export function tileOf(state: ObservedState | null | undefined): TileState {
  if (!state) return 'unmarked';
  if (state === 'left_early') return 'present';
  return state;
}

export interface TileCounts {
  present: number;
  late: number;
  absent: number;
  unmarked: number;
}

export function countTiles(states: readonly TileState[]): TileCounts {
  const counts: TileCounts = { present: 0, late: 0, absent: 0, unmarked: 0 };
  for (const s of states) counts[s] += 1;
  return counts;
}

/** "Ava Kim" → "Ava K."; one word stays as it is. */
export function tileName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? name;
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/** "9:20" in the facility zone (no AM/PM, as the tiles and the header write it). */
export function clockText(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
    .format(new Date(iso))
    .replace(/\s?[AP]M$/, '');
}

/** Tiles in the order of their names (given name first, as the coach calls them). */
export function byName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/** How long before a session the coach's "Now" shows it, and how long after (pickup). */
export const NOW_BEFORE_MS = 60 * 60_000;
export const NOW_AFTER_MS = 30 * 60_000;

/**
 * The coach's session "now": an accepted session assignment running now, or starting within the
 * hour, or ended less than 30 minutes ago (pickup); the earliest start wins. Null otherwise: the
 * workspace then shows the assignment list.
 */
export function currentSession(
  items: readonly WorkspaceAssignment[],
  now: Date,
): WorkspaceAssignment | null {
  const t = now.getTime();
  const fitting = items.filter((i) => {
    if (i.assignment.status !== 'accepted' && i.assignment.status !== 'completed') return false;
    if (i.assignment.targetType !== 'session' || !i.assignment.offeringId) return false;
    if (i.assignment.kind !== 'coach') return false;
    const start = new Date(i.activity.scheduledStart).getTime();
    const end = new Date(i.activity.scheduledEnd).getTime();
    return start - NOW_BEFORE_MS <= t && t <= end + NOW_AFTER_MS;
  });
  fitting.sort((a, b) => a.activity.scheduledStart.localeCompare(b.activity.scheduledStart));
  // A session running now before one about to start.
  const running = fitting.find(
    (i) =>
      new Date(i.activity.scheduledStart).getTime() <= t &&
      t <= new Date(i.activity.scheduledEnd).getTime(),
  );
  return running ?? fitting[0] ?? null;
}

/** "Now · 12 min in", "Starts in 20 min", "Ended 5 min ago" for the header chip. */
export function phaseText(
  start: string,
  end: string,
  now: Date,
): {
  live: boolean;
  text: string;
} {
  const t = now.getTime();
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
  if (t < s) return { live: false, text: `Starts in ${minutes(s - t)} min` };
  if (t <= e) return { live: true, text: `Now · ${minutes(t - s)} min in` };
  return { live: false, text: `Ended ${minutes(t - e)} min ago` };
}

/** The offering name without the workforce title's " (session 3)" suffix. */
export function sessionTitle(title: string): string {
  return title.replace(/\s*\(session \d+\)\s*$/i, '');
}
