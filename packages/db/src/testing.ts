import type { PGlite } from '@electric-sql/pglite';
import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { createPgDatabase, createPgliteDatabase, type Db } from './client';
import { pgErrorCode } from './helpers';
import { migrateToLatest } from './migrate';

export interface TestDatabase {
  db: Db;
  /** Present only when running on PGlite. */
  pglite: PGlite | null;
  /** Whether true concurrency is available (PostgreSQL service) or serialized (PGlite). */
  concurrent: boolean;
  close: () => Promise<void>;
}

/**
 * Creates a fully migrated database for a test file. Uses PGlite in-process by default; when
 * TEST_DATABASE_URL is set (CI with a PostgreSQL service), creates an isolated schema per call
 * on that server so the same suite exercises real concurrency.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env['TEST_DATABASE_URL'];
  if (url) {
    return createIsolatedPgSchema(url);
  }
  const { db, pglite, close } = await createPgliteDatabase();
  await migrateToLatest(db);
  return { db, pglite, concurrent: false, close };
}

/** Advisory lock key serializing extension installation across parallel test files. */
const EXTENSION_LOCK_KEY = 727_262;
/** Advisory lock key serializing per-file schema drops (each drop locks every object it removes). */
const SCHEMA_DROP_LOCK_KEY = 727_263;

/**
 * PostgreSQL's shared lock table holds max_locks_per_transaction x max_connections entries. Creating
 * or dropping a whole module schema in one transaction takes a lock per object, so parallel test
 * files can exhaust it ("out of shared memory", SQLSTATE 53200). The failing transaction rolls back
 * completely, so retrying it is safe.
 */
async function retryOnLockExhaustion<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (pgErrorCode(error) !== '53200' || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function createIsolatedPgSchema(url: string): Promise<TestDatabase> {
  const schema = `test_${newId().replaceAll('-', '')}`;
  const admin = createPgDatabase({ connectionString: url, max: 2 });
  // Extensions are database-wide. Install btree_gist into `public` (on every test schema's search
  // path) exactly once; without the lock, parallel test files race on pg_extension_name_index.
  await admin.db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${EXTENSION_LOCK_KEY})`.execute(trx);
    await sql`create extension if not exists btree_gist with schema public`.execute(trx);
  });
  await sql.raw(`create schema "${schema}"`).execute(admin.db);
  await admin.close();
  const search = new URL(url);
  search.searchParams.set('options', `-c search_path=${schema},public`);
  const { db, close } = createPgDatabase({ connectionString: search.toString(), max: 10 });
  // Each migration file runs in its own transaction, so a retry resumes at the file that failed.
  await retryOnLockExhaustion(() => migrateToLatest(db));
  return {
    db,
    pglite: null,
    concurrent: true,
    close: async () => {
      await close();
      const cleanup = createPgDatabase({ connectionString: url, max: 1 });
      try {
        // One drop at a time: concurrent drops of large schemas are what exhaust the lock table.
        await retryOnLockExhaustion(() =>
          cleanup.db.transaction().execute(async (trx) => {
            await sql`select pg_advisory_xact_lock(${SCHEMA_DROP_LOCK_KEY})`.execute(trx);
            await sql.raw(`drop schema if exists "${schema}" cascade`).execute(trx);
          }),
        );
      } finally {
        await cleanup.close();
      }
    },
  };
}

/** Seeds one organization with one facility; returns their ids. */
export async function seedOrganization(
  db: Db,
  overrides: {
    organizationId?: string;
    facilityId?: string;
    timezone?: string;
    slug?: string;
  } = {},
): Promise<{ organizationId: string; facilityId: string }> {
  const organizationId = overrides.organizationId ?? newId();
  const facilityId = overrides.facilityId ?? newId();
  const slug = overrides.slug ?? `org-${organizationId}`;
  await db
    .insertInto('organizations')
    .values({ id: organizationId, slug, name: `Organization ${slug}` })
    .execute();
  await db
    .insertInto('facilities')
    .values({
      id: facilityId,
      organization_id: organizationId,
      slug: 'main',
      name: 'Main complex',
      timezone: overrides.timezone ?? 'America/Los_Angeles',
      address: null,
    })
    .execute();
  return { organizationId, facilityId };
}
