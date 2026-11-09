import { PGlite, types as pgliteTypes } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types as pgTypes } from 'pg';
import { PGliteDialect } from './pglite-dialect';
import type { Database } from './schema';

export type Db = Kysely<Database>;

function parseBigintToNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint value ${value} exceeds the safe integer range`);
  }
  return n;
}

export interface PgDatabaseOptions {
  connectionString: string;
  max?: number;
  /**
   * Transport encryption (§4.14 encrypted transport): `require` encrypts without verifying the
   * server certificate (libpq `sslmode=require`); `verify-full` also verifies it, against `sslCa`
   * when given. Unset leaves it to the connection string (`?sslmode=`).
   */
  ssl?: 'disable' | 'require' | 'verify-full';
  /** PEM certificate authority for `verify-full` (a provider's own root certificate). */
  sslCa?: string;
  /** Server-side `statement_timeout` for every connection, in milliseconds (unset: none). */
  statementTimeoutMs?: number;
  /** How long an idle pooled connection is kept, in milliseconds. */
  idleTimeoutMs?: number;
  /** How long acquiring a new connection may take before it fails, in milliseconds. */
  connectionTimeoutMs?: number;
}

function sslOption(
  options: PgDatabaseOptions,
): false | { rejectUnauthorized: boolean; ca?: string } | undefined {
  switch (options.ssl) {
    case undefined:
      return undefined;
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) };
  }
}

/** Production/CI client over node-postgres. bigint columns are parsed to safe-integer numbers. */
export function createPgDatabase(options: PgDatabaseOptions): {
  db: Db;
  close: () => Promise<void>;
} {
  pgTypes.setTypeParser(20, parseBigintToNumber);
  const ssl = sslOption(options);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(ssl !== undefined ? { ssl } : {}),
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMillis: options.idleTimeoutMs } : {}),
    ...(options.connectionTimeoutMs !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMs }
      : {}),
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    close: async () => {
      await db.destroy();
    },
  };
}

export interface PgliteDatabaseOptions {
  /** Directory for a persistent local database; omit for in-memory. */
  dataDir?: string;
}

/** In-process PostgreSQL (PGlite) client used by tests and local development without a server. */
export async function createPgliteDatabase(
  options: PgliteDatabaseOptions = {},
): Promise<{ db: Db; pglite: PGlite; close: () => Promise<void> }> {
  const pglite = new PGlite({
    dataDir: options.dataDir,
    extensions: { btree_gist },
    parsers: { [pgliteTypes.INT8]: parseBigintToNumber },
  });
  await pglite.waitReady;
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
  return {
    db,
    pglite,
    close: async () => {
      await db.destroy();
    },
  };
}
