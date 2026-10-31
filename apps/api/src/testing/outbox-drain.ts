import { OutboxDispatcher } from '../kernel';
import type { TestApp } from './test-app';

export interface DrainOptions {
  /** The test injects a handler failure on purpose: failed deliveries are expected. */
  allowFailures?: boolean;
  /** Dispatcher passes before giving up (default 25). */
  rounds?: number;
  /** Events claimed per pass (default 200). */
  batchSize?: number;
}

/**
 * Runs the outbox until nothing more is due (R2-TESTS-01, §4.12). A handler that throws is retried
 * later, its event moving past the frozen test clock, so a drain that stopped at `claimed === 0`
 * would read a crashed handler as an idempotent one ("nothing more happened"). Any failed delivery
 * therefore fails the drain with the handlers' recorded errors, unless the test injects the failure
 * on purpose (`allowFailures`).
 */
export async function drainOutboxChecked(t: TestApp, options: DrainOptions = {}): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  const rounds = options.rounds ?? 25;
  for (let i = 0; i < rounds; i += 1) {
    const summary = await dispatcher.runOnce(options.batchSize ?? 200);
    if (!options.allowFailures && summary.retried + summary.dead > 0) {
      const failed = await t.db
        .selectFrom('job_attempts')
        .select(['handler', 'error'])
        .where('source', '=', 'outbox')
        .where('outcome', '=', 'failed')
        .orderBy('started_at', 'desc')
        .limit(summary.retried + summary.dead)
        .execute();
      throw new Error(
        `an outbox handler failed (${summary.retried} retried, ${summary.dead} dead): ${failed
          .map((f) => `${f.handler}: ${f.error ?? 'unknown error'}`)
          .join(' | ')}`,
      );
    }
    if (summary.claimed === 0) return;
  }
}
