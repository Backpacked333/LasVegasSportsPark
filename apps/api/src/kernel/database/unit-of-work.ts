import { Inject, Injectable, Logger } from '@nestjs/common';
import { isSerializationFailure, type Database, type Db } from '@sportspark/db';
import type { IsolationLevel, Transaction } from 'kysely';
import { DATABASE } from '../tokens';
import { currentCommitFence } from './commit-fence';
import { currentTransaction, runWithTransaction } from './transaction-context';

export type Trx = Transaction<Database>;

export interface TxContext {
  trx: Trx;
  /**
   * Best-effort hook run after a successful commit (for example to nudge the dispatcher).
   * Durable follow-up MUST go through the outbox in the same transaction; after-commit hooks are not durable.
   */
  afterCommit(hook: () => void | Promise<void>): void;
}

export interface UnitOfWorkOptions {
  isolationLevel?: IsolationLevel;
  /** Retries on serialization failure / deadlock (40001, 40P01). Default 3. */
  retries?: number;
}

/**
 * Transaction boundary for consequential commands. Never hold a transaction open across an
 * external network call (§4.11): call providers before or after `run`, never inside it.
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
    const retries = options.retries ?? 3;
    let attempt = 0;
    for (;;) {
      const hooks: Array<() => void | Promise<void>> = [];
      let onCommitted: (() => void) | undefined;
      try {
        let builder = this.db.transaction();
        if (options.isolationLevel) builder = builder.setIsolationLevel(options.isolationLevel);
        const result = await builder.execute((trx) =>
          runWithTransaction(trx, async () => {
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
          }),
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
}
