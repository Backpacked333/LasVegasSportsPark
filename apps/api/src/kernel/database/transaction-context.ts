import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '@sportspark/db';
import type { IsolationLevel } from 'kysely';
import type { Trx } from './unit-of-work';

/**
 * The active transaction travels with the async context of a `UnitOfWork.run` call and of every
 * outbox and inbox handler. Ports that are invoked from inside a command or handler (relationship
 * authority, team authority, lookups) read through it so they see the command's own uncommitted
 * writes and never open a second connection: under PGlite (one connection) a second connection
 * would deadlock, and on PostgreSQL it would read a different snapshot than the command.
 *
 * A `UnitOfWork.run` started while a transaction is active joins it (§4.7 invariants 3 and 12:
 * a command of another module that a command or handler calls commits or rolls back with it). The
 * transaction's scope records what joined units need from the owner of the transaction: its
 * isolation level, where to defer after-commit hooks, and the savepoint bookkeeping.
 *
 * The context closes when the callback settles. Work that outlives it (a timer or promise started
 * inside a command or handler, such as a worker nudge) inherits the async context but must not use
 * a transaction that has already committed or rolled back, so it reads through the root database.
 */
export type AfterCommitHook = () => void | Promise<void>;

/** PostgreSQL's default isolation level, which a transaction opened without one runs at. */
export const DEFAULT_ISOLATION_LEVEL: IsolationLevel = 'read committed';

export interface TransactionScope {
  readonly isolationLevel: IsolationLevel;
  /** Where joined units defer their after-commit hooks; absent when the owner runs none. */
  readonly afterCommit: ((hook: AfterCommitHook) => void) | undefined;
  /** Savepoints issued so far in this transaction (names are unique per transaction). */
  savepoints: number;
  /** Depth of the innermost joined unit currently running (0: none). */
  activeDepth: number;
}

export interface ActiveTransaction {
  readonly trx: Trx;
  readonly scope: TransactionScope;
  /** How many joined units enclose this context (0: the transaction's owner). */
  readonly depth: number;
}

interface TransactionHolder extends ActiveTransaction {
  open: boolean;
}

export interface TransactionContextOptions {
  /** The isolation level `trx` was opened with (default: PostgreSQL's read committed). */
  isolationLevel?: IsolationLevel;
  /** Receives the after-commit hooks of units that join this transaction. */
  afterCommit?: (hook: AfterCommitHook) => void;
}

const storage = new AsyncLocalStorage<TransactionHolder>();

export function currentTransaction(): Trx | undefined {
  const holder = storage.getStore();
  return holder?.open ? holder.trx : undefined;
}

/** The active transaction with its scope, while the callback that installed it is running. */
export function activeTransaction(): ActiveTransaction | undefined {
  const holder = storage.getStore();
  return holder?.open ? holder : undefined;
}

/**
 * Runs `fn` with `trx` as the active transaction. Without options, re-entering the transaction
 * that is already active (a module handler re-wrapping its `ctx.trx`) keeps that transaction's
 * scope, so units joining from inside still defer their hooks to its owner.
 */
export async function runWithTransaction<T>(
  trx: Trx,
  fn: () => Promise<T>,
  options?: TransactionContextOptions,
): Promise<T> {
  const parent = storage.getStore();
  const holder: TransactionHolder =
    !options && parent?.open && parent.trx === trx
      ? { trx, scope: parent.scope, depth: parent.depth, open: true }
      : {
          trx,
          scope: {
            isolationLevel: options?.isolationLevel ?? DEFAULT_ISOLATION_LEVEL,
            afterCommit: options?.afterCommit,
            savepoints: 0,
            activeDepth: 0,
          },
          depth: 0,
          open: true,
        };
  return runInHolder(holder, fn);
}

/** Runs `fn` as a unit joined to `parent`'s transaction, one level deeper. */
export async function runJoined<T>(parent: ActiveTransaction, fn: () => Promise<T>): Promise<T> {
  return runInHolder(
    { trx: parent.trx, scope: parent.scope, depth: parent.depth + 1, open: true },
    fn,
  );
}

async function runInHolder<T>(holder: TransactionHolder, fn: () => Promise<T>): Promise<T> {
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
