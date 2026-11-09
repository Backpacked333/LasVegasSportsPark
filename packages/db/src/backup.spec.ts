import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  recordRestore,
  RestoreRecordUnavailableError,
  takeBackupManifest,
  verifyRestore,
} from './backup';
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

  it('SPK-AT-028 / runbook §5.3: a faithful restore is recorded in database_restores with the backup, the instant, the operator, the build and the verification, and the record is append-only', async () => {
    const manifest = await takeBackupManifest(ctx.db);
    const verification = await verifyRestore(ctx.db, manifest);
    expect(verification.ok).toBe(true);
    const restoredAt = new Date('2026-11-09T12:00:00.000Z');
    const record = await recordRestore(ctx.db, {
      manifest,
      verification,
      operator: ' ops@example.test ',
      appVersion: 'a'.repeat(40),
      restoredAt,
    });
    const row = await ctx.db
      .selectFrom('database_restores')
      .selectAll()
      .where('id', '=', record.id)
      .executeTakeFirstOrThrow();
    expect(record.restoredAt).toEqual(restoredAt);
    expect(row).toMatchObject({
      backup_id: manifest.backupId,
      migrations_digest: manifest.migrations.digest,
      restored_by: 'ops@example.test',
      app_version: 'a'.repeat(40),
      schema_current: true,
    });
    expect(new Date(row.backup_taken_at).toISOString()).toBe(manifest.takenAt);
    expect(new Date(row.restored_at).toISOString()).toBe(restoredAt.toISOString());
    expect(row.verification).toMatchObject({
      faithful: true,
      migrationsMatch: true,
      rowCountDifferences: [],
      tableCount: Object.keys(manifest.rowCounts).length,
      backupMigrations: manifest.migrations,
    });
    // Append-only (forbid_mutation): a wrong row is answered by a later row, never edited.
    await expect(
      ctx.db
        .updateTable('database_restores')
        .set({ restored_by: 'someone else' })
        .where('id', '=', record.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.db.deleteFrom('database_restores').where('id', '=', record.id).execute(),
    ).rejects.toThrow(/append-only/);
    // The ledger is the one table a restore appends to: verifying again still matches the backup.
    expect(await verifyRestore(ctx.db, manifest)).toMatchObject({ ok: true, faithful: true });
  });

  it('SPK-AT-028: a restore that does not match its backup is never recorded', async () => {
    const manifest = await takeBackupManifest(ctx.db);
    const before = await ctx.db
      .selectFrom('database_restores')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    await sql`insert into organizations (id, slug, name) values ('01a1c000-0000-7000-8000-0000000000bb', 'unfaithful', 'Unfaithful')`.execute(
      ctx.db,
    );
    try {
      const verification = await verifyRestore(ctx.db, manifest);
      expect(verification.faithful).toBe(false);
      await expect(
        recordRestore(ctx.db, { manifest, verification, operator: 'ops@example.test' }),
      ).rejects.toThrow(/does not match its backup/);
      const after = await ctx.db
        .selectFrom('database_restores')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow();
      expect(after.count).toBe(before.count);
    } finally {
      await sql`delete from organizations where slug = 'unfaithful'`.execute(ctx.db);
    }
  });

  it('§5.8: a restored schema older than migration 0020 cannot hold the record and says so', async () => {
    const older = await createPgliteDatabase();
    try {
      await migrateToLatest(older.db);
      const manifest = await takeBackupManifest(older.db);
      const verification = await verifyRestore(older.db, manifest);
      await sql`drop table database_restores`.execute(older.db);
      await expect(
        recordRestore(older.db, { manifest, verification, operator: 'ops@example.test' }),
      ).rejects.toBeInstanceOf(RestoreRecordUnavailableError);
    } finally {
      await older.close();
    }
  });
});
