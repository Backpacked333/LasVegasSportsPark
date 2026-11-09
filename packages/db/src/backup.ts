import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { migrationStatus, type MigrationFile, type MigrationStatus } from './migrate';
import type { Database } from './schema';

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
    .filter((d) => d.backup !== d.restored);
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
