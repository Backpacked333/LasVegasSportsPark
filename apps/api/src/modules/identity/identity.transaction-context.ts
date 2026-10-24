import type { TxContext, UnitOfWork } from '../../kernel';

/**
 * The kernel's UnitOfWork now carries the active transaction in async context
 * (apps/api/src/kernel/database/transaction-context.ts), so authority checks invoked from any
 * module's command see that command's transaction. These helpers remain as thin aliases for the
 * identity call sites written against the earlier module-local workaround.
 */
export { currentTransaction } from '../../kernel';

export function runInTransaction<T>(
  uow: UnitOfWork,
  fn: (ctx: TxContext) => Promise<T>,
): Promise<T> {
  return uow.run(fn);
}
