import { sql } from 'kysely';
import type { Trx } from '../../../kernel';
import type { TestApp } from '../../../testing/test-app';

/**
 * Helpers for tests that hold one transaction open at a chosen point while another command runs
 * (§4.9 row locks). Under PGlite transactions serialize, so the second command simply runs after
 * the gate opens; under TEST_DATABASE_URL the test waits until the second command either finished
 * or is blocked by the paused transaction's locks, which proves the interleaving was exercised.
 */

/** A promise that stays pending until `open()`; `reached` resolves when someone waits on it. */
export function gate() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return {
    reached,
    open,
    pass: async () => {
      arrive();
      await opened;
    },
  };
}

/** Tracks whether a promise has settled (a supertest request starts when it is wrapped). */
export function tracked<T>(work: PromiseLike<T>) {
  const promise = Promise.resolve(work);
  const state = { done: false, promise };
  void promise.then(
    () => (state.done = true),
    () => (state.done = true),
  );
  return state;
}

/** The PostgreSQL backend serving a transaction (TEST_DATABASE_URL only). */
export async function backendPid(trx: Trx): Promise<number> {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
  return Number(rows[0]?.pid);
}

/**
 * TEST_DATABASE_URL: returns once `work` has settled or at least `waiting` other backends wait for
 * a lock held by the backend `holder()` names (pass the number of requests already started against
 * the same holder). Returns whether that many backends were found waiting.
 */
export async function untilSettledOrBlockedBy(
  t: TestApp,
  work: { done: boolean },
  holder: () => number | undefined,
  waiting = 1,
): Promise<boolean> {
  for (let polls = 0; !work.done; polls += 1) {
    if (polls > 2000) throw new Error('the work neither finished nor waited for a row lock');
    const pid = holder();
    if (pid !== undefined) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from pg_stat_activity
        where ${pid}::int = any(pg_blocking_pids(pid))`.execute(t.db);
      if (Number(rows[0]?.n) >= waiting) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
