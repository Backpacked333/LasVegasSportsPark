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
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot({ config }), {
    logger: [config.LOG_LEVEL],
  });
  const logger = new Logger('Worker');
  const dispatcher = app.get(OutboxDispatcher);
  const inbox = app.get(Inbox);
  dispatcher.start();
  const inboxTimer = setInterval(() => {
    inbox
      .runOnce()
      .catch((error: unknown) => logger.error(`inbox processing failed: ${String(error)}`));
  }, config.OUTBOX_POLL_INTERVAL_MS);
  const backgroundWorkers = app.get(BackgroundWorkers);
  backgroundWorkers.startAll();
  const sweeper = app.get(IdempotencySweeper);
  const sweepTimer = setInterval(() => {
    sweeper
      .sweep()
      .catch((error: unknown) => logger.error(`idempotency sweep failed: ${String(error)}`));
  }, config.IDEMPOTENCY_SWEEP_INTERVAL_MS);
  logger.log(
    `worker ${config.WORKER_ID} started (background workers: ${backgroundWorkers.names().join(', ') || 'none'})`,
  );

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, stopping`);
    dispatcher.stop();
    backgroundWorkers.stopAll();
    clearInterval(inboxTimer);
    clearInterval(sweepTimer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
