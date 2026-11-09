import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { sql } from 'kysely';
import { takeBackupManifest } from '../backup';
import { createPgDatabase } from '../client';

/**
 * Takes a logical backup of DATABASE_URL with its manifest (§5.8 recovery, SPK-AT-028).
 *
 *   DATABASE_URL=... pnpm db:backup --out sportspark-2026-11-09.dump
 *
 * Writes `<out>` (pg_dump custom format) and `<out>.manifest.json` (applied migrations and the row
 * count of every table), both from one snapshot: the manifest is read inside a repeatable-read
 * transaction whose snapshot pg_dump reuses (`--snapshot`). Needs the PostgreSQL client tools of
 * the server's major version or newer on PATH, and a direct or session connection (a
 * transaction pooler cannot share a snapshot). Managed point-in-time recovery, when the hosting
 * decision provides it (DEC-021), is the primary backup; this is the portable copy and the
 * restore rehearsal (§5.12 exit path).
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
  if (!url || !out) {
    console.error('usage: DATABASE_URL=... db:backup --out <file.dump>');
    process.exit(2);
  }
  const { db, close } = createPgDatabase({ connectionString: url, max: 1 });
  try {
    await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const { rows } = await sql<{ id: string }>`select pg_export_snapshot() as id`.execute(trx);
        const snapshot = rows[0]?.id;
        if (!snapshot) throw new Error('could not export a snapshot');
        const manifest = await takeBackupManifest(trx);
        const dump = spawnSync(
          'pg_dump',
          ['--format=custom', `--snapshot=${snapshot}`, `--file=${out}`, '--no-owner', url],
          { stdio: 'inherit' },
        );
        if (dump.status !== 0) {
          throw new Error(`pg_dump failed (${dump.error?.message ?? `exit ${dump.status}`})`);
        }
        writeFileSync(`${out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
        console.warn(
          `backup ${manifest.backupId}: ${out} (${Object.keys(manifest.rowCounts).length} tables, ${manifest.migrations.count} migrations)`,
        );
      });
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
