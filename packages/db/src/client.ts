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
}

/** Production/CI client over node-postgres. bigint columns are parsed to safe-integer numbers. */
export function createPgDatabase(options: PgDatabaseOptions): {
  db: Db;
  close: () => Promise<void>;
} {
  pgTypes.setTypeParser(20, parseBigintToNumber);
  const pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
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
