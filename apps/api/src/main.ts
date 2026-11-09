import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './kernel/app-setup';
import { loadConfig } from './kernel/config';
import { ReadinessState } from './kernel/health/readiness-state';
import { createLogger } from './kernel/logging/json-logger';
import { stopWithinBudget } from './kernel/workers/graceful-stop';

/**
 * The HTTP API process (§4.1). Stopping (R3-OPERATIONS-10): on SIGTERM or SIGINT the process
 * marks itself draining, so `GET /v1/ready` answers 503 and the load balancer stops routing new
 * requests here; after API_SHUTDOWN_DELAY_MS (time for the balancer to notice) it closes the HTTP
 * server, which finishes the requests in flight, then the modules and the database, all within
 * API_SHUTDOWN_TIMEOUT_MS, and exits.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot({ config }), {
    logger: createLogger(config, 'api'),
  });
  configureApp(app, config, { shutdownHooks: false });
  await app.listen(config.PORT);
  const logger = new Logger('Bootstrap');
  logger.log(`Sportspark API listening on :${config.PORT} (${config.NODE_ENV})`);

  const readiness = app.get(ReadinessState);
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    readiness.draining = true;
    logger.log(
      `${signal} received: refusing new traffic, finishing requests in flight (up to ${config.API_SHUTDOWN_TIMEOUT_MS} ms)`,
    );
    if (config.API_SHUTDOWN_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.API_SHUTDOWN_DELAY_MS));
    }
    const outcome = await stopWithinBudget({
      drain: async () => undefined,
      // Closes the HTTP server (in-flight requests finish, idle connections close), runs every
      // module's shutdown hooks, then closes the database (DatabaseLifecycle).
      close: () => app.close(),
      timeoutMs: config.API_SHUTDOWN_TIMEOUT_MS,
      logger,
    });
    logger.log(outcome.close === 'closed' ? 'stopped' : `stopped (${outcome.close})`);
    process.exit(outcome.close === 'failed' ? 1 : 0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
