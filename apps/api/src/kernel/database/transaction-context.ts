import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '@sportspark/db';
import type { Trx } from './unit-of-work';

/**
 * The active transaction travels with the async context of a `UnitOfWork.run` call. Ports that are
 * invoked from inside a command (relationship authority, team authority, lookups) read through it
 * so they see the command's own uncommitted writes and never open a second connection: under PGlite
 * (one connection) a second connection would deadlock, and on PostgreSQL it would read a different
 * snapshot than the command.
 */
const storage = new AsyncLocalStorage<Trx>();

export function currentTransaction(): Trx | undefined {
  return storage.getStore();
}

export function runWithTransaction<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  return storage.run(trx, fn);
}

/** The executor to read through: the active transaction when inside a command, else the root database. */
export function executorFor(db: Db): Db | Trx {
  return currentTransaction() ?? db;
}
