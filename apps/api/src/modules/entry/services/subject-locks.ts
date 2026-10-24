import { sql } from 'kysely';
import type { Trx } from '../../../kernel';

/**
 * Transaction-scoped advisory locks that serialize entry writes about one subject (§4.15
 * "Reconnection must preserve conflicting observations for review", SPK-AT-018 "observations
 * synchronize once"). Under READ COMMITTED a write that decides from rows it read (a contradicting
 * attendance head, an open visit, an already-synchronized client observation) would otherwise
 * miss a concurrent transaction's uncommitted row; with the lock the second writer waits, and its
 * next statement sees what the first committed. Locks are taken in a stable (sorted) order and
 * are re-entrant within a transaction, so a batch may take them all up front and the services
 * take them again harmlessly.
 */
export async function lockEntrySubjects(trx: Trx, keys: Iterable<string>): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  }
}

/** One person's attendance in one activity (AttendanceService.insert). */
export function attendanceLockKey(
  organizationId: string,
  activityType: string,
  activityId: string,
  personId: string,
): string {
  return `entry.attendance:${organizationId}:${activityType}:${activityId}:${personId}`;
}

/** One person's presence: visits, departures and releases of that person (any facility). */
export function presenceLockKey(organizationId: string, personId: string): string {
  return `entry.presence:${organizationId}:${personId}`;
}
