import { readFileSync } from 'node:fs';
import { createPgDatabase, type PgDatabaseOptions } from '../client';
import { migrateToLatest, migrationStatus } from '../migrate';

/**
 * Applies the repository's migrations to DATABASE_URL (§4.1 versioned migrations).
 *
 *   pnpm db:migrate              apply pending migrations (holds the migration lock)
 *   pnpm db:migrate --status     report applied, pending, changed and missing; exit 1 unless current
 *   pnpm db:migrate --dry-run    list what would be applied; apply nothing
 *
 * DATABASE_SSL (disable | require | verify-full) and DATABASE_SSL_CA_PATH configure transport
 * encryption when the connection string does not (§4.14).
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const args = new Set(process.argv.slice(2));
  const ssl = process.env['DATABASE_SSL'] as PgDatabaseOptions['ssl'] | undefined;
  if (ssl && !['disable', 'require', 'verify-full'].includes(ssl)) {
    console.error('DATABASE_SSL must be disable, require or verify-full');
    process.exit(2);
  }
  const caPath = process.env['DATABASE_SSL_CA_PATH'];
  const { db, close } = createPgDatabase({
    connectionString: url,
    max: 2,
    ...(ssl ? { ssl } : {}),
    ...(caPath ? { sslCa: readFileSync(caPath, 'utf8') } : {}),
  });
  try {
    if (args.has('--status')) {
      const status = await migrationStatus(db);
      console.warn(
        JSON.stringify(
          {
            applied: status.applied,
            pending: status.pending,
            mismatched: status.mismatched,
            missingOnDisk: status.missingOnDisk,
            current: status.current,
          },
          null,
          2,
        ),
      );
      process.exitCode = status.current ? 0 : 1;
      return;
    }
    const dryRun = args.has('--dry-run');
    const result = await migrateToLatest(db, { log: (m) => console.warn(m), dryRun });
    console.warn(
      dryRun
        ? `dry run: ${result.applied.length} migration(s) would be applied; ${result.alreadyApplied} already applied`
        : `applied ${result.applied.length} migration(s); ${result.alreadyApplied} already applied`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
