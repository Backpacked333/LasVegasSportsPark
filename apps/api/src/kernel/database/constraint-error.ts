import { pgConstraintName, pgErrorCode } from '@sportspark/db';

/** The integrity violations a caller may turn into a domain outcome (§4.7). */
export type ConstraintViolationCode = '23505' | '23P01' | '23514' | '23503';

const CODES: readonly string[] = ['23505', '23P01', '23514', '23503'];

/**
 * Classifies a database error raised by a joined unit of work (K-07, IF-28): a unique (23505),
 * exclusion (23P01), check (23514) or foreign-key (23503) violation with the constraint it names,
 * so the caller of a failed joined unit turns a named constraint into a domain outcome (for
 * example `RESOURCE_CONFLICT`). Any other error classifies as null, and callers rethrow it.
 *
 * Pure: it never touches the database. The canonical way to let one step fail without aborting
 * the transaction is `UnitOfWork.run` called inside the transaction (a joined unit in its own
 * savepoint, one at a time); no second savepoint helper exists.
 */
export function databaseConstraintOf(
  error: unknown,
): { code: ConstraintViolationCode; constraint: string | null } | null {
  const code = pgErrorCode(error);
  if (!code || !CODES.includes(code)) return null;
  return { code: code as ConstraintViolationCode, constraint: pgConstraintName(error) ?? null };
}
