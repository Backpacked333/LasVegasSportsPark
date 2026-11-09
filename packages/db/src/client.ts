import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
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

/** The lock file that keeps a PGlite data directory to one process at a time. */
export const PGLITE_LOCK_FILE = '.sportspark-pglite.lock';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The directory whose exclusive creation serializes stale-lock takeovers (`mkdir` is atomic). */
export const PGLITE_TAKEOVER_DIR = '.sportspark-pglite.takeover';
/** A takeover directory older than this was left by a process that stopped mid-takeover. */
const TAKEOVER_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readHolder(file: string): number | null {
  try {
    const holder = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Creates the lock file only if none exists (`wx`); false when another one is there. */
function createLock(file: string): boolean {
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Claims a PGlite data directory for this process. PGlite takes no lock of its own: a second
 * process opens a directory another holds without an error, and the writes it commits are lost
 * when both close (README, verified with @electric-sql/pglite 0.5.11).
 *
 * A lock left by a process that no longer runs is taken over, but only by one process at a time:
 * the takeover happens while holding the takeover directory (created exclusively), and the lock
 * is re-read under it, so two processes that both saw the same stale lock cannot each remove the
 * other's new one. A takeover directory older than TAKEOVER_STALE_MS is cleared. The release
 * removes the lock only while it still names this process. Returns the release function.
 */
export function lockPgliteDirectory(
  dataDir: string,
  options: { attempts?: number; waitMs?: number } = {},
): () => void {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, PGLITE_LOCK_FILE);
  const takeover = path.join(dataDir, PGLITE_TAKEOVER_DIR);
  const attempts = options.attempts ?? 40;
  const waitMs = options.waitMs ?? 50;
  const release = () => {
    if (readHolder(file) === process.pid) rmSync(file, { force: true });
  };
  const refuse = (holder: number): never => {
    throw new Error(
      `PGlite data directory ${dataDir} is open in process ${holder}; stop it first, or use DATABASE_URL to share one database between processes`,
    );
  };
  const live = (holder: number | null) =>
    holder !== null && holder !== process.pid && processAlive(holder);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (createLock(file)) return release;
    const holder = readHolder(file);
    if (live(holder)) refuse(holder as number);
    // The lock is stale (or vanished meanwhile): take it over while holding the takeover dir.
    try {
      mkdirSync(takeover);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - statSync(takeover).mtimeMs;
      if (age > TAKEOVER_STALE_MS) rmSync(takeover, { recursive: true, force: true });
      else sleepSync(waitMs);
      continue;
    }
    try {
      // Re-read under the takeover: another process may have taken it over just before.
      const current = readHolder(file);
      if (live(current)) refuse(current as number);
      rmSync(file, { force: true });
      if (createLock(file)) return release;
    } finally {
      rmSync(takeover, { recursive: true, force: true });
    }
  }
  throw new Error(`could not lock PGlite data directory ${dataDir}`);
}

/** In-process PostgreSQL (PGlite) client used by tests and local development without a server. */
export async function createPgliteDatabase(
  options: PgliteDatabaseOptions = {},
): Promise<{ db: Db; pglite: PGlite; close: () => Promise<void> }> {
  const release = options.dataDir ? lockPgliteDirectory(options.dataDir) : () => undefined;
  try {
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
        try {
          await db.destroy();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
