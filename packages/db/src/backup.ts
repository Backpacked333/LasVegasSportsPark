import { createHash, randomUUID } from 'node:crypto';
import { newId } from '@sportspark/contracts';
import { sql, type Kysely } from 'kysely';
import { json } from './helpers';
import { migrationStatus, type MigrationFile, type MigrationStatus } from './migrate';
import type { Database } from './schema';

/**
 * The restore ledger (migration 0020): the one table a restore legitimately appends to, so its
 * row count is left out of the comparison with the backup manifest (a verification run after
 * `recordRestore` must still match).
 */
export const RESTORE_LEDGER_TABLE = 'database_restores';

/**
 * What a backup contained, recorded beside it (§5.8 recovery, SPK-AT-028): the applied migrations
 * and the row count of every table, read in the same snapshot as the dump. A restore is verified
 * against it before the processes start.
 */
export interface BackupManifest {
  backupId: string;
  takenAt: string;
  schema: string;
  migrations: { count: number; latest: string | null; digest: string };
  rowCounts: Record<string, number>;
}

export interface RestoreVerification {
  /**
   * The restore is faithful to its backup and its schema is current for this build: the API and
   * worker of this build may start on it. A faithful restore of an older backup is not ok until
   * the pending migrations are applied (its schema would not be this build's).
   */
  ok: boolean;
  /** Rows and applied migrations equal the backup's (what the restore itself must achieve). */
  faithful: boolean;
  backupId: string;
  /** Applied migrations in the restored database equal the backup's. */
  migrationsMatch: boolean;
  /** The restored schema against this build's migration files. */
  schemaStatus: MigrationStatus;
  /** Tables whose row count differs from the backup, or that exist on one side only. */
  rowCountDifferences: Array<{ table: string; backup: number | null; restored: number | null }>;
}

async function readState(db: Kysely<Database>): Promise<Omit<BackupManifest, 'backupId'>> {
  const meta = await sql<{ now: Date | string; schema: string }>`
    select now() as now, current_schema() as schema
  `.execute(db);
  const migrations = await sql<{ version: string; checksum: string }>`
    select version, checksum from schema_migrations order by version
  `.execute(db);
  const tables = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = current_schema() and table_type = 'BASE TABLE'
    order by table_name
  `.execute(db);
  const rowCounts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const { rows } = await sql<{ count: string }>`
      select count(*) as count from ${sql.table(table_name)}
    `.execute(db);
    rowCounts[table_name] = Number(rows[0]?.count ?? 0);
  }
  const digest = createHash('sha256')
    .update(migrations.rows.map((m) => `${m.version}:${m.checksum}`).join('\n'))
    .digest('hex');
  return {
    takenAt: new Date(meta.rows[0]?.now ?? Date.now()).toISOString(),
    schema: meta.rows[0]?.schema ?? 'public',
    migrations: {
      count: migrations.rows.length,
      latest: migrations.rows.at(-1)?.version ?? null,
      digest,
    },
    rowCounts,
  };
}

/**
 * Reads the manifest of the database as `db` sees it. Run it inside the transaction whose
 * snapshot the dump uses (`pg_dump --snapshot`) so both describe the same instant.
 */
export async function takeBackupManifest(db: Kysely<Database>): Promise<BackupManifest> {
  return { backupId: `backup-${randomUUID()}`, ...(await readState(db)) };
}

/** Compares a restored database with its backup's manifest and this build's migrations. */
export async function verifyRestore(
  db: Kysely<Database>,
  manifest: BackupManifest,
  options: { dir?: string; files?: MigrationFile[] } = {},
): Promise<RestoreVerification> {
  const restored = await readState(db);
  const schemaStatus = await migrationStatus(db, options);
  const tables = new Set([...Object.keys(manifest.rowCounts), ...Object.keys(restored.rowCounts)]);
  const rowCountDifferences = [...tables]
    .sort()
    .map((table) => ({
      table,
      backup: manifest.rowCounts[table] ?? null,
      restored: restored.rowCounts[table] ?? null,
    }))
    .filter((d) => d.table !== RESTORE_LEDGER_TABLE && d.backup !== d.restored);
  const migrationsMatch = restored.migrations.digest === manifest.migrations.digest;
  const faithful = migrationsMatch && rowCountDifferences.length === 0;
  return {
    ok: faithful && schemaStatus.current,
    faithful,
    backupId: manifest.backupId,
    migrationsMatch,
    schemaStatus,
    rowCountDifferences,
  };
}

export interface RestoreRecordInput {
  manifest: BackupManifest;
  verification: RestoreVerification;
  /** Who ran the restore (`db:restore --operator`): the runbook's actor (recovery runbook §5.3). */
  operator: string;
  /** The build that restored (`APP_VERSION` or `SOURCE_COMMIT` of the image); null when unknown. */
  appVersion?: string | null;
  /** The restore instant; defaults to the database clock. */
  restoredAt?: Date;
}

export interface RestoreRecord {
  id: string;
  restoredAt: Date;
}

/** The restored schema predates migration 0020, so the restore ledger does not exist in it. */
export class RestoreRecordUnavailableError extends Error {
  constructor() {
    super(
      `the restored database has no ${RESTORE_LEDGER_TABLE} table (its backup predates migration 0020_core_database_restores): record the restore instant and backup id in the decision log (recovery runbook §5.3)`,
    );
    this.name = 'RestoreRecordUnavailableError';
  }
}

/**
 * Records a verified restore in the restored database itself (§5.8, SPK-AT-028; recovery runbook
 * §5.3): the backup it came from, when it was taken, when and by whom it was restored, the build
 * that restored it, whether the schema is current for this build, and the verification. Only a
 * restore that matches its backup (`faithful`) is recorded; one that does not is not a restore of
 * that backup and must not be started on. The row is append-only (`forbid_mutation`).
 */
export async function recordRestore(
  db: Kysely<Database>,
  input: RestoreRecordInput,
): Promise<RestoreRecord> {
  const { manifest, verification } = input;
  if (!verification.faithful) {
    throw new Error(
      `restore of ${manifest.backupId} does not match its backup (migrations ${verification.migrationsMatch ? 'equal' : 'differ'}, ${verification.rowCountDifferences.length} table(s) differ): not recorded`,
    );
  }
  const operator = input.operator.trim();
  if (operator.length === 0) throw new Error('the restore operator must be named (--operator)');
  const { rows: ledger } = await sql<{ present: string | null }>`
    select to_regclass(${RESTORE_LEDGER_TABLE}) as present
  `.execute(db);
  if (!ledger[0]?.present) throw new RestoreRecordUnavailableError();
  const restoredAt =
    input.restoredAt ??
    new Date(
      (await sql<{ now: Date | string }>`select now() as now`.execute(db)).rows[0]?.now ??
        Date.now(),
    );
  const id = newId();
  await db
    .insertInto('database_restores')
    .values({
      id,
      backup_id: manifest.backupId,
      backup_taken_at: manifest.takenAt,
      migrations_digest: manifest.migrations.digest,
      restored_at: restoredAt,
      restored_by: operator,
      app_version: input.appVersion ?? null,
      schema_current: verification.ok,
      verification: json({
        faithful: verification.faithful,
        migrationsMatch: verification.migrationsMatch,
        rowCountDifferences: verification.rowCountDifferences,
        schemaStatus: verification.schemaStatus,
        tableCount: Object.keys(manifest.rowCounts).length,
        backupMigrations: manifest.migrations,
      }),
    })
    .execute();
  return { id, restoredAt };
}
