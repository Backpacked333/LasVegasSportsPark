import { AsyncLocalStorage } from 'node:async_hooks';
import type { TxContext, UnitOfWork } from '../../kernel';
import type { Trx } from '../../kernel';

/**
 * Kernel workaround: `AuthorizationService.require` calls the relationship-authority port without
 * a transaction handle. Inside `UnitOfWork.run` that port must still read through the open
 * transaction (PGlite has a single connection, and on PostgreSQL the check should see the same
 * snapshot as the command). This module therefore runs every command in an async context that
 * carries the current transaction, and RelationshipAuthority falls back to it.
 */
const storage = new AsyncLocalStorage<Trx>();

export function currentTransaction(): Trx | undefined {
  return storage.getStore();
}

export function runInTransaction<T>(
  uow: UnitOfWork,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  return uow.run((ctx) => storage.run(ctx.trx, () => fn(ctx)));
}
