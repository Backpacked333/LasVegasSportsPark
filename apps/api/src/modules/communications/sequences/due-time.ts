import { addDays, localDateOf, resolveLocal } from '../../scheduling';

/**
 * An anchor date of a season or an offering: a calendar date of its own (a season starts on a
 * date), or an instant (registration opens at a moment; a game starts at one).
 */
export type AnchorValue = { date: string } | { at: Date };

export interface DueTime {
  /** The anchor as an instant: the instant itself, or the start of its date in the facility zone. */
  anchorAt: Date;
  dueAt: Date;
}

/**
 * When a step's message is due (SPK-COMMS-009, SPK-SCHED-008): the anchor's date in the
 * facility's zone, plus the step's days, at the step's facility-local time of day. Daylight-saving
 * changes follow the scheduling module's rule: a time that does not exist on that day moves
 * forward past the gap, and a time that occurs twice takes its first occurrence.
 */
export function dueTimeOf(
  anchor: AnchorValue,
  offsetDays: number,
  sendTimeLocal: string,
  timezone: string,
): DueTime {
  const anchorDate = 'date' in anchor ? anchor.date : localDateOf(timezone, anchor.at);
  const anchorAt =
    'at' in anchor ? anchor.at : (resolveLocal(anchorDate, '00:00', timezone)?.instant ?? null);
  const due = resolveLocal(addDays(anchorDate, offsetDays), sendTimeLocal, timezone);
  if (!anchorAt || !due) {
    // `resolveLocal` answers null only under a policy that skips nonexistent times; the default
    // policy used here never does.
    throw new Error(`no instant for ${anchorDate} ${sendTimeLocal} in ${timezone}`);
  }
  return { anchorAt, dueAt: due.instant };
}

/** True when both are absent or both are the same instant. */
export function sameInstant(a: Date | string | null, b: Date | string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}
