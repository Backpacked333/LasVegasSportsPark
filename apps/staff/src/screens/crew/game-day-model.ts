/**
 * The live game kept on the coach's phone (staff redesign Phase 8 item 3): the clock, who is on
 * the pitch, the timeline and the score, as pure functions over a small state that is stored on
 * this device (identifiers and minutes only, never names) until "End game" sends it as the side's
 * game log (`POST /v1/fixtures/{id}/game-log`, competition migration 0475).
 */
import type { Schema } from '@sportspark/api-client';

export type GameLogEvent = Schema<'GameLogEvent'>;

export interface GameState {
  version: 1;
  startedAt: string | null;
  halfTimeAt: string | null;
  secondHalfAt: string | null;
  endedAt: string | null;
  /** The starting players (the lineup's places, or the fairest Going players). */
  starters: string[];
  events: GameLogEvent[];
  /** "End game" was pressed and the log still waits to be sent (offline, or a failure). */
  pendingSend: boolean;
}

export function newGame(starters: readonly string[]): GameState {
  return {
    version: 1,
    startedAt: null,
    halfTimeAt: null,
    secondHalfAt: null,
    endedAt: null,
    starters: [...starters],
    events: [],
    pendingSend: false,
  };
}

/** Reads a stored game; anything damaged or of another shape is forgotten. */
export function parseGame(raw: string | null): GameState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GameState>;
    if (
      value &&
      value.version === 1 &&
      Array.isArray(value.events) &&
      Array.isArray(value.starters)
    ) {
      return value as GameState;
    }
  } catch {
    // forgotten
  }
  return null;
}

const MIN = 60_000;

/** The game minute now: running in each half, standing still at half time and after the end. */
export function minuteOf(state: GameState, now: Date): number {
  if (!state.startedAt) return 0;
  const start = new Date(state.startedAt).getTime();
  const at = state.endedAt ? new Date(state.endedAt).getTime() : now.getTime();
  if (state.halfTimeAt && !state.secondHalfAt) {
    return Math.max(0, Math.floor((new Date(state.halfTimeAt).getTime() - start) / MIN));
  }
  if (state.halfTimeAt && state.secondHalfAt) {
    const first = Math.floor((new Date(state.halfTimeAt).getTime() - start) / MIN);
    return first + Math.max(0, Math.floor((at - new Date(state.secondHalfAt).getTime()) / MIN));
  }
  return Math.max(0, Math.floor((at - start) / MIN));
}

export function phaseOf(state: GameState): 'before' | 'first' | 'half_time' | 'second' | 'ended' {
  if (state.endedAt) return 'ended';
  if (!state.startedAt) return 'before';
  if (state.halfTimeAt && !state.secondHalfAt) return 'half_time';
  if (state.secondHalfAt) return 'second';
  return 'first';
}

/** Who is on the pitch after the substitutions so far. */
export function onPitchOf(state: GameState): string[] {
  const on = [...state.starters];
  for (const e of state.events) {
    if (e.kind !== 'substitution') continue;
    const i = on.indexOf(e.offPersonId);
    if (i >= 0) on.splice(i, 1, e.onPersonId);
    else if (!on.includes(e.onPersonId)) on.push(e.onPersonId);
  }
  return on;
}

/** Our goals and theirs. */
export function goalsOf(state: GameState): { ours: number; theirs: number } {
  return {
    ours: state.events.filter((e) => e.kind === 'goal').length,
    theirs: state.events.filter((e) => e.kind === 'opponent_goal').length,
  };
}

/** The score as home–away, from the side the coach keeps. */
export function scoreOf(state: GameState, side: 'home' | 'away'): { home: number; away: number } {
  const { ours, theirs } = goalsOf(state);
  return side === 'home' ? { home: ours, away: theirs } : { home: theirs, away: ours };
}

/** Removes the latest goal of that side (the "−" button); null when there is none. */
export function withoutLastGoal(state: GameState, ours: boolean): GameState | null {
  const kind = ours ? 'goal' : 'opponent_goal';
  const index = state.events.map((e) => e.kind).lastIndexOf(kind);
  if (index < 0) return null;
  return { ...state, events: state.events.filter((_, i) => i !== index) };
}

/** Minutes each player was on the pitch, up to the final minute; players who played only. */
export function minutesPlayed(
  state: GameState,
  finalMinute: number,
): { personId: string; minutes: number }[] {
  const since = new Map<string, number>(state.starters.map((p) => [p, 0]));
  const total = new Map<string, number>();
  const add = (p: string, m: number) => total.set(p, (total.get(p) ?? 0) + m);
  const subs = state.events
    .filter((e): e is Extract<GameLogEvent, { kind: 'substitution' }> => e.kind === 'substitution')
    .sort((a, b) => a.minute - b.minute);
  for (const s of subs) {
    const from = since.get(s.offPersonId);
    if (from !== undefined) {
      add(s.offPersonId, Math.max(0, s.minute - from));
      since.delete(s.offPersonId);
    }
    if (!since.has(s.onPersonId)) since.set(s.onPersonId, s.minute);
  }
  for (const [p, from] of since) add(p, Math.max(0, finalMinute - from));
  return [...total.entries()]
    .map(([personId, minutes]) => ({ personId, minutes: Math.min(150, minutes) }))
    .filter((m) => m.minutes > 0);
}
