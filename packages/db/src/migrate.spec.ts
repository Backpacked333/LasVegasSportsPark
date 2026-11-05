import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDatabase } from './client';
import { loadMigrationFiles, migrateToLatest } from './migrate';

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
});
