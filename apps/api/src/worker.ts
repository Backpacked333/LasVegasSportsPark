import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './kernel/config';
import { IdempotencySweeper } from './kernel/http/idempotency-sweeper';
import { Inbox } from './kernel/inbox/inbox';
import { OutboxDispatcher } from './kernel/outbox/outbox-dispatcher';
import { BackgroundWorkers } from './kernel/workers/background-workers';

/**
 * Independently running durable worker (§4.1, §4.12): dispatches outbox events, processes inbox
 * events, runs the modules' registered background workers (provider-facing refund, installment and
 * message delivery loops, which never run in the API process) and deletes expired idempotency
 * records. Several workers may run concurrently; claims use FOR UPDATE SKIP LOCKED leases.
 *
 * Stopping (R3-OPERATIONS-10, recovery runbook §4): on SIGTERM or SIGINT nothing new is claimed;
 * the work in flight (the outbox and inbox event in hand, a background worker pass, a periodic job
 * pass, an idempotency sweep) is awaited up to WORKER_SHUTDOWN_TIMEOUT_MS, claimed events not yet
 * started are handed back at once, and then the application and its database are closed.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ config }), {
    logger: [config.LOG_LEVEL],
  });
  const logger = new Logger('Worker');
  const dispatcher = app.get(OutboxDispatcher);
  const inbox = app.get(Inbox);
  let stopping = false;
  dispatcher.start();
  let inboxRun: Promise<unknown> | null = null;
  const inboxTimer = setInterval(() => {
    if (inboxRun || stopping) return;
    inboxRun = inbox
      .runOnce(config.OUTBOX_BATCH_SIZE, { shouldStop: () => stopping })
      .catch((error: unknown) => logger.error(`inbox processing failed: ${String(error)}`))
      .finally(() => {
        inboxRun = null;
      });
  }, config.OUTBOX_POLL_INTERVAL_MS);
  const backgroundWorkers = app.get(BackgroundWorkers);
  backgroundWorkers.startAll();
  const sweeper = app.get(IdempotencySweeper);
  let sweepRun: Promise<unknown> | null = null;
  const sweepTimer = setInterval(() => {
    if (sweepRun || stopping) return;
    sweepRun = sweeper
      .sweep()
      .catch((error: unknown) => logger.error(`idempotency sweep failed: ${String(error)}`))
      .finally(() => {
        sweepRun = null;
      });
  }, config.IDEMPOTENCY_SWEEP_INTERVAL_MS);
  logger.log(
    `worker ${config.WORKER_ID} started (background workers: ${backgroundWorkers.names().join(', ') || 'none'})`,
  );

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(
      `${signal} received: claiming nothing more, finishing the work in flight (up to ${config.WORKER_SHUTDOWN_TIMEOUT_MS} ms)`,
    );
    clearInterval(inboxTimer);
    clearInterval(sweepTimer);
    const drained = Promise.allSettled([
      dispatcher.stop(),
      backgroundWorkers.stopAll(),
      inboxRun,
      sweepRun,
    ]).then(() => true);
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), config.WORKER_SHUTDOWN_TIMEOUT_MS);
    });
    const finished = await Promise.race([drained, timedOut]);
    clearTimeout(timeout);
    if (!finished) {
      logger.warn(
        `work still in flight after ${config.WORKER_SHUTDOWN_TIMEOUT_MS} ms; its claims are retried once their leases lapse (OUTBOX_LOCK_LEASE_SECONDS, PERIODIC_JOBS_LEASE_SECONDS)`,
      );
    }
    try {
      // Runs every module's shutdown hooks, then closes the database (DatabaseLifecycle).
      await app.close();
    } catch (error) {
      logger.error(`closing the application failed: ${String(error)}`);
      process.exit(1);
    }
    logger.log('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
