import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { takeBackupManifest, verifyRestore } from './backup';
import { createPgliteDatabase } from './client';
import { loadMigrationFiles, migrateToLatest } from './migrate';

describe('backup manifest and restore verification (§5.8, SPK-AT-028)', () => {
  let ctx: Awaited<ReturnType<typeof createPgliteDatabase>>;
  beforeAll(async () => {
    ctx = await createPgliteDatabase();
    await migrateToLatest(ctx.db);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('SPK-AT-028: a database verified against its own manifest matches, with the schema current for this build', async () => {
    const manifest = await takeBackupManifest(ctx.db);
    expect(manifest.backupId).toMatch(/^backup-/);
    expect(manifest.migrations.count).toBeGreaterThan(100);
    expect(manifest.rowCounts['organizations']).toBe(0);
    const result = await verifyRestore(ctx.db, manifest);
    expect(result).toMatchObject({
      ok: true,
      faithful: true,
      migrationsMatch: true,
      rowCountDifferences: [],
      schemaStatus: { current: true },
    });
  });

  it('§5.8: rows written after the backup and a different migration history are reported', async () => {
    const manifest = await takeBackupManifest(ctx.db);
    await sql`insert into organizations (id, slug, name) values ('01a1c000-0000-7000-8000-0000000000aa', 'later', 'Later')`.execute(
      ctx.db,
    );
    await sql`insert into schema_migrations (version, name, checksum) values ('9998', 'later', 'x')`.execute(
      ctx.db,
    );
    try {
      const result = await verifyRestore(ctx.db, manifest);
      expect(result.ok).toBe(false);
      expect(result.migrationsMatch).toBe(false);
      expect(result.rowCountDifferences).toEqual([
        { table: 'organizations', backup: 0, restored: 1 },
        {
          table: 'schema_migrations',
          backup: manifest.rowCounts['schema_migrations'],
          restored: (manifest.rowCounts['schema_migrations'] ?? 0) + 1,
        },
      ]);
      expect(result.schemaStatus.missingOnDisk).toEqual(['9998']);
    } finally {
      await sql`delete from schema_migrations where version = '9998'`.execute(ctx.db);
      await sql`delete from organizations where slug = 'later'`.execute(ctx.db);
    }
  });

  it('SPK-AT-028: a faithful restore of a backup older than this build is not ok until its migrations are applied', async () => {
    const manifest = await takeBackupManifest(ctx.db);
    // This build knows one migration more than the restored database has applied.
    const files = [
      ...(await loadMigrationFiles()),
      {
        version: '9999',
        name: 'newer_build',
        fileName: '9999_newer_build.sql',
        sql: 'select 1;',
        checksum: 'newer',
      },
    ];
    const result = await verifyRestore(ctx.db, manifest, { files });
    expect(result).toMatchObject({ faithful: true, migrationsMatch: true, ok: false });
    expect(result.schemaStatus.current).toBe(false);
    expect(result.schemaStatus.pending).toEqual(['9999_newer_build.sql']);
  });
});
