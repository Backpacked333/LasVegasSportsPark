import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDatabase, createPgliteDatabase } from './client';
import { loadMigrationFiles, migrateToLatest, migrationStatus } from './migrate';

describe('migration runner', () => {
  let ctx: Awaited<ReturnType<typeof createPgliteDatabase>>;

  beforeAll(async () => {
    ctx = await createPgliteDatabase();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('applies the repository migrations once and is idempotent on re-run', async () => {
    const first = await migrateToLatest(ctx.db);
    expect(first.applied.length).toBeGreaterThan(0);
    const second = await migrateToLatest(ctx.db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(first.applied.length);
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1
    `.execute(ctx.db);
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'organizations',
      'facilities',
      'audit_records',
      'operations',
      'idempotency_keys',
      'outbox_events',
      'inbox_events',
      'event_consumptions',
      'job_attempts',
      'operational_exceptions',
      'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('refuses to run when an applied migration changed on disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
    await writeFile(path.join(dir, '0001_a.sql'), 'create table a_test (id int);');
    const fresh = await createPgliteDatabase();
    try {
      await migrateToLatest(fresh.db, { dir });
      await writeFile(path.join(dir, '0001_a.sql'), 'create table a_test (id int, extra int);');
      await expect(migrateToLatest(fresh.db, { dir })).rejects.toThrow(/checksum mismatch/);
    } finally {
      await fresh.close();
    }
  });

  it('rejects malformed file names and duplicate versions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
    await writeFile(path.join(dir, '0001_a.sql'), 'select 1;');
    await writeFile(path.join(dir, '0001_b.sql'), 'select 1;');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/duplicate migration version/);
    const dir2 = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
    await writeFile(path.join(dir2, 'bad-name.sql'), 'select 1;');
    await expect(loadMigrationFiles(dir2)).rejects.toThrow(/must match/);
  });

  it('rolls back a failing migration file as a unit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
    await writeFile(
      path.join(dir, '0001_partial.sql'),
      'create table ok_table (id int); create table broken_table (id int, id int);',
    );
    const fresh = await createPgliteDatabase();
    try {
      await expect(migrateToLatest(fresh.db, { dir })).rejects.toThrow();
      const tables = await sql<{ table_name: string }>`
        select table_name from information_schema.tables where table_schema = 'public'
      `.execute(fresh.db);
      expect(tables.rows.map((r) => r.table_name)).not.toContain('ok_table');
      const applied = await sql<{ version: string }>`select version from schema_migrations`.execute(
        fresh.db,
      );
      expect(applied.rows).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it('§4.1, §5.8: migrationStatus reports pending, changed and missing migrations without changing anything', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
    await writeFile(path.join(dir, '0001_a.sql'), 'create table status_a (id int);');
    await writeFile(path.join(dir, '0002_b.sql'), 'create table status_b (id int);');
    const fresh = await createPgliteDatabase();
    try {
      // No schema_migrations table yet: everything is pending and nothing is created.
      expect(await migrationStatus(fresh.db, { dir })).toEqual({
        applied: 0,
        pending: ['0001_a.sql', '0002_b.sql'],
        mismatched: [],
        missingOnDisk: [],
        current: false,
      });
      // A dry run applies nothing.
      const dry = await migrateToLatest(fresh.db, { dir, dryRun: true });
      expect(dry.applied.map((f) => f.fileName)).toEqual(['0001_a.sql', '0002_b.sql']);
      const tables = await sql<{ present: boolean }>`
        select to_regclass('status_a') is not null as present
      `.execute(fresh.db);
      expect(tables.rows[0]?.present).toBe(false);

      await migrateToLatest(fresh.db, { dir });
      expect(await migrationStatus(fresh.db, { dir })).toMatchObject({
        applied: 2,
        pending: [],
        current: true,
      });
      // A newer build adds a file; an older build lacks one; an edited file is reported.
      await writeFile(path.join(dir, '0003_c.sql'), 'create table status_c (id int);');
      expect(await migrationStatus(fresh.db, { dir })).toMatchObject({
        pending: ['0003_c.sql'],
        current: false,
      });
      const older = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
      await writeFile(path.join(older, '0001_a.sql'), 'create table status_a (id int);');
      expect(await migrationStatus(fresh.db, { dir: older })).toMatchObject({
        missingOnDisk: ['0002'],
        current: false,
      });
      await writeFile(path.join(dir, '0002_b.sql'), 'create table status_b (id bigint);');
      expect(await migrationStatus(fresh.db, { dir })).toMatchObject({
        mismatched: ['0002_b.sql'],
        current: false,
      });
    } finally {
      await fresh.close();
    }
  });

  it.skipIf(!process.env['TEST_DATABASE_URL'])(
    '§4.1: two runners started at once against one database apply each migration once',
    async () => {
      const url = process.env['TEST_DATABASE_URL'] as string;
      const dir = await mkdtemp(path.join(os.tmpdir(), 'spk-mig-'));
      const table = `lock_${Date.now()}`;
      await writeFile(path.join(dir, '0001_a.sql'), `create table ${table} (id int);`);
      await writeFile(path.join(dir, '0002_b.sql'), `select pg_sleep(0.3);`);
      const schema = `mig_lock_${Date.now()}`;
      const admin = createPgDatabase({ connectionString: url, max: 1 });
      await sql.raw(`create schema "${schema}"`).execute(admin.db);
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      const a = createPgDatabase({ connectionString: scoped.toString(), max: 2 });
      const b = createPgDatabase({ connectionString: scoped.toString(), max: 2 });
      try {
        const [first, second] = await Promise.all([
          migrateToLatest(a.db, { dir }),
          migrateToLatest(b.db, { dir }),
        ]);
        expect(first.applied.length + second.applied.length).toBe(2);
        expect(await migrationStatus(a.db, { dir })).toMatchObject({ current: true, applied: 2 });
      } finally {
        await a.close();
        await b.close();
        await sql.raw(`drop schema "${schema}" cascade`).execute(admin.db);
        await admin.close();
      }
    },
  );
});
