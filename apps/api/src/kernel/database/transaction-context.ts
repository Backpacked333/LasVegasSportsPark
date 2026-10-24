import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '@sportspark/db';
import type { Trx } from './unit-of-work';

/**
 * The active transaction travels with the async context of a `UnitOfWork.run` call and of every
 * outbox and inbox handler. Ports that are invoked from inside a command or handler (relationship
 * authority, team authority, lookups) read through it so they see the command's own uncommitted
 * writes and never open a second connection: under PGlite (one connection) a second connection
 * would deadlock, and on PostgreSQL it would read a different snapshot than the command.
 *
 * The context closes when the callback settles. Work that outlives it (a timer or promise started
 * inside a command or handler, such as a worker nudge) inherits the async context but must not use
 * a transaction that has already committed or rolled back, so it reads through the root database.
 */
interface TransactionHolder {
  trx: Trx;
  open: boolean;
}

const storage = new AsyncLocalStorage<TransactionHolder>();

export function currentTransaction(): Trx | undefined {
  const holder = storage.getStore();
  return holder?.open ? holder.trx : undefined;
}

export async function runWithTransaction<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  const holder: TransactionHolder = { trx, open: true };
  try {
    return await storage.run(holder, fn);
  } finally {
    holder.open = false;
  }
}

/** The executor to read through: the active transaction when inside a command, else the root database. */
export function executorFor(db: Db): Db | Trx {
  return currentTransaction() ?? db;
}
