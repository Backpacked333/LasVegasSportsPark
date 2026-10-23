import { Inject, Injectable, Logger } from '@nestjs/common';
import { isSerializationFailure, type Database, type Db } from '@sportspark/db';
import type { IsolationLevel, Transaction } from 'kysely';
import { DATABASE } from '../tokens';

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

  async run<T>(fn: (ctx: TxContext) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const retries = options.retries ?? 3;
    let attempt = 0;
    for (;;) {
      const hooks: Array<() => void | Promise<void>> = [];
      try {
        let builder = this.db.transaction();
        if (options.isolationLevel) builder = builder.setIsolationLevel(options.isolationLevel);
        const result = await builder.execute((trx) =>
          fn({
            trx,
            afterCommit: (hook) => {
              hooks.push(hook);
            },
          }),
        );
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
