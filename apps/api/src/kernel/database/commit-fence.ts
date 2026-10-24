import { AsyncLocalStorage } from 'node:async_hooks';
import type { Trx } from './unit-of-work';

/**
 * A commit fence joins a request-level guard to every `UnitOfWork` transaction that runs inside
 * that request. The idempotency interceptor installs one around each `@Idempotent()` handler so
 * that, atomically with the business commit, the request's key records that its command changed
 * data, and a transaction whose key claim was taken over by a retry is rolled back instead of
 * committing a second effect (§4.9, §4.7 invariant 5).
 */
export interface CommitFence {
  /**
   * Runs inside the transaction after the unit of work's body and immediately before COMMIT.
   * Throwing rolls the transaction back. The returned callback, if any, runs once COMMIT succeeded.
   */
  beforeCommit(trx: Trx): Promise<(() => void) | undefined>;
}

interface FenceHolder {
  fence: CommitFence;
  open: boolean;
}

const fences = new AsyncLocalStorage<FenceHolder>();

/** The fence of the enclosing request, while that request's handler is still running. */
export function currentCommitFence(): CommitFence | undefined {
  const holder = fences.getStore();
  return holder?.open ? holder.fence : undefined;
}

/**
 * Runs `fn` with `fence` installed. `close()` detaches the fence once the request settles, so work
 * that outlives the request (timers, worker nudges) is not fenced against a finished request's key.
 */
export function withCommitFence<T>(
  fence: CommitFence,
  fn: () => T,
): { result: T; close: () => void } {
  const holder: FenceHolder = { fence, open: true };
  const result = fences.run(holder, fn);
  return {
    result,
    close: () => {
      holder.open = false;
    },
  };
}
