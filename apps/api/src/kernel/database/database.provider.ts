import { Logger, type FactoryProvider } from '@nestjs/common';
import { createPgDatabase, createPgliteDatabase, migrateToLatest, type Db } from '@sportspark/db';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE } from '../tokens';

export interface DatabaseHandle {
  db: Db;
  close: () => Promise<void>;
}

const handles = new WeakMap<Db, () => Promise<void>>();

export async function openDatabase(config: AppConfig): Promise<DatabaseHandle> {
  const logger = new Logger('Database');
  if (config.DATABASE_URL) {
    const handle = createPgDatabase({ connectionString: config.DATABASE_URL });
    if (config.DB_AUTO_MIGRATE && config.NODE_ENV !== 'production') {
      const result = await migrateToLatest(handle.db, { log: (m) => logger.log(m) });
      logger.log(
        `migrations: ${result.applied.length} applied, ${result.alreadyApplied} already applied`,
      );
    }
    handles.set(handle.db, handle.close);
    return handle;
  }
  logger.warn(
    config.PGLITE_DATA_DIR
      ? `using PGlite at ${config.PGLITE_DATA_DIR} (development only)`
      : 'using in-memory PGlite (development only; data is lost on exit)',
  );
  const handle = await createPgliteDatabase({ dataDir: config.PGLITE_DATA_DIR });
  if (config.DB_AUTO_MIGRATE) {
    await migrateToLatest(handle.db, { log: (m) => logger.log(m) });
  }
  handles.set(handle.db, handle.close);
  return handle;
}

export async function closeDatabase(db: Db): Promise<void> {
  const close = handles.get(db);
  if (close) {
    handles.delete(db);
    await close();
  }
}

export const databaseProvider: FactoryProvider<Db> = {
  provide: DATABASE,
  inject: [APP_CONFIG],
  useFactory: async (config: AppConfig) => (await openDatabase(config)).db,
};
