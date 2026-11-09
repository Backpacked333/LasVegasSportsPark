import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { seedDevelopment } from './dev/seed-dev';
import { configureApp } from './kernel/app-setup';
import { loadConfig } from './kernel/config';
import { ReadinessState } from './kernel/health/readiness-state';
import { createLogger } from './kernel/logging/json-logger';
import { startInlineWorker } from './kernel/workers/inline-worker';

/**
 * Development: the API and the worker's loops in one process (§4.12), so follow-ups (notices,
 * hold and checkout expiry, delayed payment outcomes, periodic jobs) happen on a developer's
 * machine with PGlite, which one process at a time may open. Refuses production.
 *
 *   pnpm dev:all                       API on :3000 with the inline worker
 *   pnpm dev:all -- --seed             also creates the development seed first (seed:dev)
 *   pnpm dev:all -- --seed --seed-summary <file>   and writes its account ids to <file>
 *
 * Production runs `dist/main.js` and `dist/worker.js` as separate processes (§4.1).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'dev:all is for development: run dist/main.js and dist/worker.js in production',
    );
  }
  const logger = new Logger('DevAll');
  const app = await NestFactory.create(AppModule.forRoot({ config }), {
    logger: createLogger(config, 'api'),
  });
  configureApp(app, config, { shutdownHooks: false });
  await app.init();
  if (process.argv.includes('--seed')) {
    const summary = await seedDevelopment(app, {});
    logger.log(`development seed ready: ${JSON.stringify(summary)}`);
    // --seed-summary <file>: the seed's account ids for scripts (the browser smoke tests).
    const at = process.argv.indexOf('--seed-summary');
    const file = at > 0 ? process.argv[at + 1] : undefined;
    if (file) writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  }
  await app.listen(config.PORT);
  const worker = startInlineWorker(app, config);
  logger.log(`API and inline worker on :${config.PORT} (${config.NODE_ENV})`);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.get(ReadinessState).draining = true;
    logger.log(`${signal} received: stopping the worker loops and the API`);
    await worker.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
