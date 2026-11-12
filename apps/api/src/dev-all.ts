import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { seedDemo, type DemoSummary } from './dev/seed-demo';
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
 *   pnpm dev:all -- --seed --timezone <IANA zone>  the seeded facility's time zone (default UTC)
 *   pnpm dev:all -- --seed --demo      also creates the demo dataset (seed:dev -- --demo): a
 *                                      synthetic operating picture, not operator policy (§1.4)
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
  const valueOf = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  if (process.argv.includes('--demo') && !process.argv.includes('--seed')) {
    throw new Error('--demo adds to the development seed: use --seed --demo');
  }
  if (process.argv.includes('--seed')) {
    const summary = await seedDevelopment(app, { timezone: valueOf('--timezone') });
    logger.log(`development seed ready: ${JSON.stringify(summary)}`);
    let demo: DemoSummary | null = null;
    if (process.argv.includes('--demo')) {
      // Before the port opens and the worker loops start: the seed drives the API over a
      // loopback port of its own and drains the follow-ups itself.
      demo = await seedDemo(app, summary);
      logger.log(`${demo.message} ${JSON.stringify({ ...demo, message: undefined })}`);
    }
    // --seed-summary <file>: the seed's account ids for scripts (the browser smoke tests), and
    // with --demo the demo accounts and record ids, so whoever presents it can sign in as them.
    const file = valueOf('--seed-summary');
    if (file) {
      writeFileSync(file, `${JSON.stringify(demo ? { ...summary, demo } : summary, null, 2)}\n`);
    }
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
