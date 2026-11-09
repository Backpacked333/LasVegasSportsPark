import { Logger, type INestApplicationContext } from '@nestjs/common';
import type { AppConfig } from '../config';
import { IdempotencySweeper } from '../http/idempotency-sweeper';
import { Inbox } from '../inbox/inbox';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { BackgroundWorkers } from './background-workers';

export interface InlineWorker {
  /** Stops claiming work and waits for the passes in flight. */
  stop(): Promise<void>;
}

/**
 * Runs the durable worker's loops inside an API process (§4.12): outbox dispatch, the provider
 * inbox, the modules' background workers (periodic jobs, delivery, provider follow-ups) and the
 * idempotency sweep. For a development machine (`dev:all`, one process on PGlite) and a function
 * host with no separate worker process (the protected staging host, STAGING_INLINE_WORKER).
 * Production runs `dist/worker.js` as its own process (§4.1). Claims use the same leases, so an
 * inline worker and a separate one never process an event twice.
 */
export function startInlineWorker(
  app: INestApplicationContext,
  config: AppConfig,
  logger: Pick<Logger, 'error'> = new Logger('InlineWorker'),
): InlineWorker {
  const dispatcher = app.get(OutboxDispatcher);
  const workers = app.get(BackgroundWorkers);
  const inbox = app.get(Inbox);
  const sweeper = app.get(IdempotencySweeper);
  let stopping = false;
  let inboxRun: Promise<unknown> | null = null;
  let sweepRun: Promise<unknown> | null = null;
  dispatcher.start();
  workers.startAll();
  const failed = (what: string) => (error: unknown) =>
    logger.error(`${what} failed: ${String(error)}`);
  const inboxTimer = setInterval(() => {
    if (inboxRun || stopping) return;
    inboxRun = inbox
      .runOnce(config.OUTBOX_BATCH_SIZE, { shouldStop: () => stopping })
      .catch(failed('inbox processing'))
      .finally(() => {
        inboxRun = null;
      });
  }, config.OUTBOX_POLL_INTERVAL_MS);
  inboxTimer.unref();
  const sweepTimer = setInterval(() => {
    if (sweepRun || stopping) return;
    sweepRun = sweeper
      .sweep()
      .catch(failed('idempotency sweep'))
      .finally(() => {
        sweepRun = null;
      });
  }, config.IDEMPOTENCY_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  return {
    stop: async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(inboxTimer);
      clearInterval(sweepTimer);
      await Promise.allSettled([dispatcher.stop(), workers.stopAll(), inboxRun, sweepRun]);
    },
  };
}
