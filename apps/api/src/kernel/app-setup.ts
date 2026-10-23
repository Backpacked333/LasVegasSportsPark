import type { INestApplication } from '@nestjs/common';
import { correlationMiddleware } from './http/correlation.middleware';

export const API_PREFIX = 'v1';

/** Shared HTTP setup for the server entrypoint and the test harness. */
export function configureApp(app: INestApplication): INestApplication {
  app.use(correlationMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
