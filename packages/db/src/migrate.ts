import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';

export interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: MigrationFile[];
  alreadyApplied: number;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/** Reads `NNNN_name.sql` files in lexical (= version) order. Versions must be unique. */
export async function loadMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  const seen = new Set<string>();
  for (const fileName of entries) {
    const match = FILE_RE.exec(fileName);
    if (!match) {
      throw new Error(`migration file name "${fileName}" must match NNNN_snake_case_name.sql`);
    }
    const [, version, name] = match as unknown as [string, string, string];
    if (seen.has(version)) {
      throw new Error(`duplicate migration version ${version} (${fileName})`);
    }
    seen.add(version);
    const content = await readFile(path.join(dir, fileName), 'utf8');
    files.push({
      version,
      name,
      fileName,
      sql: content,
      checksum: createHash('sha256').update(content).digest('hex'),
    });
  }
  return files;
}

async function ensureMigrationsTable<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `.execute(db);
}

/**
 * Applies pending migrations in order, each inside its own transaction, and refuses to run if an
 * already-applied migration's content changed (versioned migrations are immutable once applied).
 */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrationFiles(options.dir);
  await ensureMigrationsTable(db);
  const rows = await sql<{ version: string; checksum: string }>`
    select version, checksum from schema_migrations order by version
  `.execute(db);
  const applied = new Map(rows.rows.map((r) => [r.version, r.checksum]));

  for (const [version, checksum] of applied) {
    const file = files.find((f) => f.version === version);
    if (!file) {
      throw new Error(`migration ${version} is applied in the database but missing from disk`);
    }
    if (file.checksum !== checksum) {
      throw new Error(
        `migration ${file.fileName} changed after it was applied (checksum mismatch); add a new migration instead`,
      );
    }
  }

  const result: MigrationResult = { applied: [], alreadyApplied: applied.size };
  for (const file of files) {
    if (applied.has(file.version)) continue;
    log(`applying ${file.fileName}`);
    await db.transaction().execute(async (trx) => {
      await sql.raw(file.sql).execute(trx);
      await sql`
        insert into schema_migrations (version, name, checksum)
        values (${file.version}, ${file.name}, ${file.checksum})
      `.execute(trx);
    });
    result.applied.push(file);
  }
  return result;
}
