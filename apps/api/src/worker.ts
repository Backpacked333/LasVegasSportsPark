import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './kernel/config';
import { Inbox } from './kernel/inbox/inbox';
import { OutboxDispatcher } from './kernel/outbox/outbox-dispatcher';

/**
 * Independently running durable worker (§4.1, §4.12): dispatches outbox events and processes
 * inbox events. Several workers may run concurrently; claims use FOR UPDATE SKIP LOCKED leases.
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
  logger.log(`worker ${config.WORKER_ID} started`);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, stopping`);
    dispatcher.stop();
    clearInterval(inboxTimer);
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
