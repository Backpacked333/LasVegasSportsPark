import { errors } from '@sportspark/contracts';

/**
 * Optimistic concurrency for sensitive edits (§4.9): updates include `where revision = expected`
 * and bump `revision + 1`. When no row changed, the caller loads the current row to distinguish
 * a stale revision from a missing record.
 */
export function assertExpectedRevision(expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) {
    throw errors.staleRevision(expected, current);
  }
}

export function ensureUpdated(
  numUpdatedRows: bigint | number | undefined,
  onMissing: () => Error,
): void {
  const n = typeof numUpdatedRows === 'bigint' ? Number(numUpdatedRows) : (numUpdatedRows ?? 0);
  if (n === 0) throw onMissing();
}
