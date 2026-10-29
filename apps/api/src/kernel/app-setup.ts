import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from './config';
import { correlationMiddleware } from './http/correlation.middleware';

export const API_PREFIX = 'v1';

/**
 * The browser-facing CORS policy (K-03, §4.14; served origins are DEC-021, pending): exact origins
 * from `CORS_ALLOWED_ORIGINS` only, no credentials (the bearer token travels in Authorization),
 * the request headers the clients send and the response headers they read.
 */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Sportspark-Client',
  'X-Correlation-Id',
  'X-Export-Token',
] as const;
export const CORS_EXPOSED_HEADERS = ['X-Correlation-Id', 'Idempotent-Replayed'] as const;
export const CORS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

/** Shared HTTP setup for the server entrypoint and the test harness. */
export function configureApp(app: INestApplication, config?: AppConfig): INestApplication {
  const origins = config?.CORS_ALLOWED_ORIGINS;
  if (config && origins && origins.length > 0) {
    app.enableCors({
      origin: origins.includes('*') ? '*' : [...origins],
      methods: [...CORS_METHODS],
      allowedHeaders: [...CORS_ALLOWED_HEADERS],
      exposedHeaders: [...CORS_EXPOSED_HEADERS],
      credentials: false,
      maxAge: config.CORS_MAX_AGE_SECONDS,
    });
  }
  app.use(correlationMiddleware);
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
