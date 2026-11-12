import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  recordRestore,
  RestoreRecordUnavailableError,
  verifyRestore,
  type BackupManifest,
} from '../backup';
import { createPgDatabase } from '../client';

/**
 * Restores a backup taken by `db:backup` into TARGET_DATABASE_URL, verifies it against its
 * manifest and records the restore in the restored database (§5.8 recovery, SPK-AT-028; recovery
 * runbook §5.3).
 *
 *   TARGET_DATABASE_URL=... pnpm db:restore --in sportspark-2026-11-09.dump --operator <name>
 *
 * Restores in one transaction (pg_restore --single-transaction), then compares the applied
 * migrations and every table's row count with the manifest and the schema with this build's
 * migrations. When rows and migrations match the backup, a `database_restores` row records the
 * backup id, the restore instant, the operator (`--operator`, or RESTORE_OPERATOR) and the build
 * (APP_VERSION or SOURCE_COMMIT); a backup taken before migration 0020 has no such table, and the
 * decision log stays the record. Exit 0 only when the restore matches and the schema is current.
 * Then, before starting the API and worker on the restored database after live transactions, set
 * RECOVERY_RESTORE_REFERENCE to the printed backup id: the processes look the record up at boot,
 * financial commands stay refused until provider facts are reconciled and a general manager
 * resumes operation (POST /v1/recovery/resume).
 */
async function main(): Promise<void> {
  const url = process.env['TARGET_DATABASE_URL'];
  const inIndex = process.argv.indexOf('--in');
  const file = inIndex > 0 ? process.argv[inIndex + 1] : undefined;
  const operatorIndex = process.argv.indexOf('--operator');
  const operator =
    (operatorIndex > 0 ? process.argv[operatorIndex + 1] : undefined) ??
    process.env['RESTORE_OPERATOR'];
  if (!url || !file || !operator?.trim()) {
    console.error(
      'usage: TARGET_DATABASE_URL=... db:restore --in <file.dump> --operator <name> (or RESTORE_OPERATOR=<name>)',
    );
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(`${file}.manifest.json`, 'utf8')) as BackupManifest;
  const restore = spawnSync(
    'pg_restore',
    [
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      url,
      file,
    ],
    { stdio: 'inherit' },
  );
  if (restore.status !== 0) {
    console.error(`pg_restore failed (${restore.error?.message ?? `exit ${restore.status}`})`);
    process.exit(1);
  }
  const { db, close } = createPgDatabase({ connectionString: url, max: 1 });
  try {
    const result = await verifyRestore(db, manifest);
    console.warn(JSON.stringify(result, null, 2));
    if (result.faithful) {
      try {
        const record = await recordRestore(db, {
          manifest,
          verification: result,
          operator,
          appVersion: process.env['APP_VERSION'] || process.env['SOURCE_COMMIT'] || null,
        });
        console.warn(
          `restore recorded: database_restores ${record.id} at ${record.restoredAt.toISOString()} by ${operator.trim()}`,
        );
      } catch (error) {
        if (!(error instanceof RestoreRecordUnavailableError)) throw error;
        console.warn(`restore not recorded: ${error.message}`);
      }
    }
    if (!result.ok) {
      const { pending, mismatched, missingOnDisk } = result.schemaStatus;
      console.error(
        result.faithful && mismatched.length === 0 && missingOnDisk.length === 0
          ? `restored faithfully, but ${pending.length} migration(s) of this build are not applied: run pnpm db:migrate, then verify readiness before starting the processes`
          : 'restore verification failed: do not start the processes on this database',
      );
      process.exitCode = 1;
      return;
    }
    console.warn(
      `restore verified. Before starting the API and worker after live transactions: RECOVERY_RESTORE_REFERENCE=${manifest.backupId}`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
