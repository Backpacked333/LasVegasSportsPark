import { newId } from '@sportspark/contracts';
import type { PGlite } from '@electric-sql/pglite';
import { createPgDatabase, createPgliteDatabase, type Db } from './client';
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

async function createIsolatedPgSchema(url: string): Promise<TestDatabase> {
  const schema = `test_${newId().replaceAll('-', '')}`;
  const admin = createPgDatabase({ connectionString: url, max: 2 });
  const { sql } = await import('kysely');
  await sql.raw(`create schema "${schema}"`).execute(admin.db);
  await admin.close();
  const search = new URL(url);
  search.searchParams.set('options', `-c search_path=${schema},public`);
  const { db, close } = createPgDatabase({ connectionString: search.toString(), max: 10 });
  await migrateToLatest(db);
  return {
    db,
    pglite: null,
    concurrent: true,
    close: async () => {
      await close();
      const cleanup = createPgDatabase({ connectionString: url, max: 1 });
      await sql.raw(`drop schema "${schema}" cascade`).execute(cleanup.db);
      await cleanup.close();
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
