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

/**
 * R2-RACES-06 (ENT-03, SPK-AT-009): admitting a check-in and recording an activity's cancellation
 * serialize on the activity's transaction-scoped advisory lock (`entry_activity_lock_key`,
 * migration 0807, which the database's own guard takes too). Check-ins take it shared, so they
 * never wait for each other; recording the cancellation takes it exclusively. The statement after
 * the lock reads a fresh snapshot (READ COMMITTED), so each side sees what the other committed.
 */
export async function lockActivity(
  trx: Trx,
  organizationId: string,
  activityType: 'session' | 'event',
  activityId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const key = sql`entry_activity_lock_key(${organizationId}::uuid, ${activityType}, ${activityId}::uuid)`;
  await (
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(${key})`
      : sql`select pg_advisory_xact_lock(${key})`
  ).execute(trx);
}
