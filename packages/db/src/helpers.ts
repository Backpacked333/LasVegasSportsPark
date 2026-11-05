import { sql, type RawBuilder } from 'kysely';

/** jsonb parameter helper: `values({ payload: json({...}) })` — portable across pg and PGlite. */
export function json<T>(value: T): RawBuilder<string> {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/** Half-open tstzrange `[start, end)` parameter. */
export function tstzrange(start: Date | string, end: Date | string): RawBuilder<string> {
  const s = start instanceof Date ? start.toISOString() : start;
  const e = end instanceof Date ? end.toISOString() : end;
  return sql`tstzrange(${s}::timestamptz, ${e}::timestamptz, '[)')`;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23505';
}

export function isExclusionViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23P01';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23503';
}

export function isCheckViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23514';
}

export function isSerializationFailure(error: unknown): boolean {
  const code = pgErrorCode(error);
  return code === '40001' || code === '40P01';
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (e.cause) return pgErrorCode(e.cause);
  return undefined;
}

/** Constraint name from a PostgreSQL error, when present. */
export function pgConstraintName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { constraint?: unknown; constraint_name?: unknown; cause?: unknown };
  if (typeof e.constraint === 'string') return e.constraint;
  if (typeof e.constraint_name === 'string') return e.constraint_name;
  if (e.cause) return pgConstraintName(e.cause);
  return undefined;
}
