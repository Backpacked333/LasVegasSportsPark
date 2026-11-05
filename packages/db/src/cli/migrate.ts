import { createPgDatabase } from '../client';
import { migrateToLatest } from '../migrate';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { db, close } = createPgDatabase({ connectionString: url, max: 2 });
  try {
    const result = await migrateToLatest(db, { log: (m) => console.warn(m) });
    console.warn(
      `applied ${result.applied.length} migration(s); ${result.alreadyApplied} already applied`,
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
