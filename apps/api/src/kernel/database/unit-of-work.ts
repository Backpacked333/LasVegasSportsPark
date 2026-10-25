import { Inject, Injectable, Logger } from '@nestjs/common';
import { isSerializationFailure, type Database, type Db } from '@sportspark/db';
import { sql, type IsolationLevel, type Transaction } from 'kysely';
import { DATABASE } from '../tokens';
import { currentCommitFence } from './commit-fence';
import {
  activeTransaction,
  currentTransaction,
  DEFAULT_ISOLATION_LEVEL,
  runJoined,
  runWithTransaction,
  type ActiveTransaction,
  type AfterCommitHook,
} from './transaction-context';

export type Trx = Transaction<Database>;

export interface TxContext {
  trx: Trx;
  /**
   * Best-effort hook run after a successful commit (for example to nudge the dispatcher).
   * Durable follow-up MUST go through the outbox in the same transaction; after-commit hooks are not durable.
   * Inside a joined unit the hook waits for the commit of the outermost transaction.
   */
  afterCommit(hook: AfterCommitHook): void;
}

export interface UnitOfWorkOptions {
  isolationLevel?: IsolationLevel;
  /** Retries on serialization failure / deadlock (40001, 40P01). Default 3. Outermost unit only. */
  retries?: number;
}

/**
 * Transaction boundary for consequential commands. Never hold a transaction open across an
 * external network call (§4.11): call providers before or after `run`, never inside it.
 *
 * Reentrant: `run` called while a transaction is active (inside another `run`, or inside an
 * outbox or inbox handler) joins that transaction instead of opening a second one, so a command
 * of another module that a command or handler calls is atomic with it (§4.7 invariants 3 and 12,
 * §4.11). A joined unit runs inside a savepoint: when it throws, its own writes are rolled back and
 * the caller may catch the error and carry on (a failed statement would otherwise abort the whole
 * PostgreSQL transaction). Serialization retries, the idempotency commit fence and after-commit
 * hooks belong to the outermost unit only. A joined unit cannot change the isolation level.
 */
@Injectable()
export class UnitOfWork {
  private readonly logger = new Logger(UnitOfWork.name);

  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /** The transaction of the enclosing `run` call, if any (see transaction-context.ts). */
  current(): Trx | undefined {
    return currentTransaction();
  }

  /** Executor for reads: the enclosing transaction when inside a command, otherwise the root database. */
  reader(): Db | Trx {
    return currentTransaction() ?? this.db;
  }

  async run<T>(fn: (ctx: TxContext) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const enclosing = activeTransaction();
    if (enclosing) return this.join(enclosing, fn, options);
    const retries = options.retries ?? 3;
    let attempt = 0;
    for (;;) {
      const hooks: AfterCommitHook[] = [];
      let onCommitted: (() => void) | undefined;
      try {
        let builder = this.db.transaction();
        if (options.isolationLevel) builder = builder.setIsolationLevel(options.isolationLevel);
        const result = await builder.execute((trx) =>
          runWithTransaction(
            trx,
            async () => {
              const value = await fn({
                trx,
                afterCommit: (hook) => {
                  hooks.push(hook);
                },
              });
              // §4.9: inside an idempotent request, record on its key (atomically with this commit)
              // that the command changed data, or abort if a retry has taken the key over.
              onCommitted = await currentCommitFence()?.beforeCommit(trx);
              return value;
            },
            {
              isolationLevel: options.isolationLevel ?? DEFAULT_ISOLATION_LEVEL,
              afterCommit: (hook) => {
                hooks.push(hook);
              },
            },
          ),
        );
        onCommitted?.();
        for (const hook of hooks) {
          try {
            await hook();
          } catch (error) {
            this.logger.warn(`after-commit hook failed: ${String(error)}`);
          }
        }
        return result;
      } catch (error) {
        attempt += 1;
        if (isSerializationFailure(error) && attempt <= retries) {
          await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  }

  /** A unit joined to the active transaction, inside its own savepoint. */
  private async join<T>(
    enclosing: ActiveTransaction,
    fn: (ctx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    const { trx, scope } = enclosing;
    const requested = options.isolationLevel ?? DEFAULT_ISOLATION_LEVEL;
    if (requested !== scope.isolationLevel) {
      throw new Error(
        `a unit of work requesting ${requested} isolation cannot join an enclosing ${scope.isolationLevel} transaction`,
      );
    }
    // Savepoints nest strictly; two joined units running side by side in one transaction (for
    // example under Promise.all) would release or roll back each other's work.
    if (scope.activeDepth !== enclosing.depth) {
      throw new Error('units of work joined to one transaction must run one at a time');
    }
    scope.activeDepth += 1;
    scope.savepoints += 1;
    const savepoint = `uow_${scope.savepoints}`;
    const hooks: AfterCommitHook[] = [];
    let opened = false;
    try {
      await sql.raw(`savepoint ${savepoint}`).execute(trx);
      opened = true;
      const value = await runJoined(enclosing, () =>
        fn({
          trx,
          afterCommit: (hook) => {
            hooks.push(hook);
          },
        }),
      );
      await sql.raw(`release savepoint ${savepoint}`).execute(trx);
      for (const hook of hooks) {
        if (scope.afterCommit) scope.afterCommit(hook);
        else this.logger.warn('after-commit hook dropped: the enclosing transaction runs none');
      }
      return value;
    } catch (error) {
      try {
        if (opened) await sql.raw(`rollback to savepoint ${savepoint}`).execute(trx);
      } catch (rollbackError) {
        this.logger.warn(`could not roll back to ${savepoint}: ${String(rollbackError)}`);
      }
      throw error;
    } finally {
      scope.activeDepth -= 1;
    }
  }
}
