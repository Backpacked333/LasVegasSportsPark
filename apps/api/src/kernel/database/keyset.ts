import { z } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { Trx } from './unit-of-work';

// ---------------------------------------------------------------------------------------------
// Keyset pages over a `created_at default now()` column (§4.5, api-and-events.md "Pagination";
// R2-API-CONTRACT-01b). The column carries microseconds on PostgreSQL, and a JavaScript Date keeps
// only milliseconds: a cursor built from one skipped every later row of the boundary row's
// millisecond, all the rows one transaction wrote among them. These helpers keep the instant at the
// database's precision, as text, from the row to the cursor and back into the comparison.
// ---------------------------------------------------------------------------------------------

/** The shape `keysetInstant` writes: whole seconds, up to six fraction digits, UTC `Z`. */
const KEYSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * A cursor's instant. Only an instant PostgreSQL can represent decodes: the calendar date is
 * checked and year 0000 (ISO-8601 allows it, PostgreSQL has no year 0) is refused, so a crafted
 * cursor reads as the first page instead of failing the `::timestamptz` cast as a server fault.
 * Millisecond cursors issued before have the same shape and still decode.
 */
export const KeysetInstant = z.iso
  .datetime()
  .regex(KEYSET_INSTANT)
  .refine((value) => !value.startsWith('0000-'));

/** `column` as an ISO-8601 UTC instant with microseconds, whatever DateStyle and TimeZone are. */
export function keysetInstant(column: string): RawBuilder<string> {
  return sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows strictly after the boundary in (created desc, id desc) order, compared as text. */
export function afterKeyset(
  createdColumn: string,
  idColumn: string,
  instant: string,
  id: string,
): RawBuilder<SqlBool> {
  return sql<SqlBool>`(${sql.ref(createdColumn)}, ${sql.ref(idColumn)}) < (${instant}::timestamptz, ${id}::uuid)`;
}

/**
 * The exact instant of one row's `created_at` (or another timestamptz column), for the next cursor
 * of a page whose rows were read as Dates. The page just read the row; only if it is gone by now
 * does the cursor fall back to the Date's millisecond text.
 */
export async function exactInstantOf(
  db: Db | Trx,
  table: string,
  column: string,
  id: string,
  fallback: Date | string,
): Promise<string> {
  const row = await sql<{
    at: string;
  }>`select ${keysetInstant(`${table}.${column}`)} as at from ${sql.table(table)} where ${sql.ref(`${table}.id`)} = ${id}::uuid`.execute(
    db,
  );
  return row.rows[0]?.at ?? new Date(fallback).toISOString();
}
