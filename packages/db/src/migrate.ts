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
 * The advisory lock every migration run holds (§4.1 versioned migrations), together with a hash of
 * the schema being migrated: two runners started at once against the same schema (a deploy job
 * and a second replica, two deploys) apply each file once, the second waiting for the first and
 * then finding nothing pending. Runners migrating different schemas (parallel test files) do not
 * wait for each other.
 */
export const MIGRATION_LOCK_KEY = 412_058_133;

export interface MigrationStatus {
  /** Applied migrations whose file exists with the same content. */
  applied: number;
  /** Files on disk not applied yet, in order. */
  pending: string[];
  /** Applied migrations whose file changed after it was applied. */
  mismatched: string[];
  /** Versions applied in the database with no file on disk (a rollback to an older build). */
  missingOnDisk: string[];
  /** True when nothing is pending, changed or missing: the schema matches this build. */
  current: boolean;
}

/**
 * Compares the database's applied migrations with the files of this build (§4.1, §5.8 restore
 * verification), without changing anything. A database without `schema_migrations` has every
 * file pending.
 */
export async function migrationStatus<DB>(
  db: Kysely<DB>,
  options: { dir?: string; files?: MigrationFile[] } = {},
): Promise<MigrationStatus> {
  const files = options.files ?? (await loadMigrationFiles(options.dir));
  const exists = await sql<{ present: boolean }>`
    select to_regclass('schema_migrations') is not null as present
  `.execute(db);
  const rows = exists.rows[0]?.present
    ? (
        await sql<{ version: string; checksum: string }>`
          select version, checksum from schema_migrations order by version
        `.execute(db)
      ).rows
    : [];
  return compareMigrations(files, rows);
}

function compareMigrations(
  files: readonly MigrationFile[],
  rows: ReadonlyArray<{ version: string; checksum: string }>,
): MigrationStatus {
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const byVersion = new Map(files.map((f) => [f.version, f]));
  const mismatched: string[] = [];
  const missingOnDisk: string[] = [];
  let matching = 0;
  for (const [version, checksum] of applied) {
    const file = byVersion.get(version);
    if (!file) missingOnDisk.push(version);
    else if (file.checksum !== checksum) mismatched.push(file.fileName);
    else matching += 1;
  }
  const pending = files.filter((f) => !applied.has(f.version)).map((f) => f.fileName);
  return {
    applied: matching,
    pending,
    mismatched,
    missingOnDisk,
    current: pending.length === 0 && mismatched.length === 0 && missingOnDisk.length === 0,
  };
}

/**
 * Turns row level security on for every table of the current schema that does not have it (§4.14
 * least privilege). No policy is created, so a table answers only its owner, which is the role the
 * API, the worker and this runner connect as; any other role that reaches the database (a hosted
 * data interface's public roles, a reporting login) reads and writes nothing until a policy says
 * otherwise. The runner does this rather than each migration file, so a table added by a later
 * migration cannot be left open by omission. The owner is not subject to the policies of its own
 * tables, so the application's queries are unchanged.
 */
const ENABLE_ROW_LEVEL_SECURITY = `
  do $$
  declare target regclass;
  begin
    for target in
      select c.oid::regclass
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relrowsecurity
    loop
      execute format('alter table %s enable row level security', target);
    end loop;
  end
  $$
`;

/**
 * The tables of the current schema without row level security, by name (§4.14). Empty after
 * `migrateToLatest`; a name here means a table was created outside the runner.
 */
export async function tablesWithoutRowLevelSecurity<DB>(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relrowsecurity
    order by c.relname
  `.execute(db);
  return result.rows.map((row) => row.name);
}

/**
 * Applies pending migrations in order, each inside its own transaction, and refuses to run if an
 * already-applied migration's content changed (versioned migrations are immutable once applied).
 * The whole run holds `MIGRATION_LOCK_KEY` on one connection, so concurrent runners serialize.
 * Every table ends with row level security on (`ENABLE_ROW_LEVEL_SECURITY`): the tables a file
 * creates inside that file's transaction, and any table left without it by an earlier build in
 * one statement at the end. `dryRun` reports what would be applied and applies nothing.
 */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  options: { dir?: string; log?: (message: string) => void; dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => undefined);
  const files = await loadMigrationFiles(options.dir);
  return db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}, hashtext(current_schema()))`.execute(
      conn,
    );
    try {
      if (!options.dryRun) await ensureMigrationsTable(conn);
      const status = await migrationStatus(conn, { files });
      if (status.missingOnDisk.length > 0) {
        throw new Error(
          `migration ${status.missingOnDisk[0]} is applied in the database but missing from disk`,
        );
      }
      if (status.mismatched.length > 0) {
        throw new Error(
          `migration ${status.mismatched[0]} changed after it was applied (checksum mismatch); add a new migration instead`,
        );
      }
      const result: MigrationResult = { applied: [], alreadyApplied: status.applied };
      const pending = new Set(status.pending);
      for (const file of files) {
        if (!pending.has(file.fileName)) continue;
        if (options.dryRun) {
          log(`would apply ${file.fileName}`);
          result.applied.push(file);
          continue;
        }
        log(`applying ${file.fileName}`);
        await conn.transaction().execute(async (trx) => {
          await sql.raw(file.sql).execute(trx);
          await sql.raw(ENABLE_ROW_LEVEL_SECURITY).execute(trx);
          await sql`
            insert into schema_migrations (version, name, checksum)
            values (${file.version}, ${file.name}, ${file.checksum})
          `.execute(trx);
        });
        result.applied.push(file);
      }
      if (!options.dryRun) await sql.raw(ENABLE_ROW_LEVEL_SECURITY).execute(conn);
      return result;
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}, hashtext(current_schema()))`.execute(
        conn,
      );
    }
  });
}
