import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigSchema, type AppConfig } from './config';
import { correlationMiddleware } from './http/correlation.middleware';
import { responseHeadersMiddleware } from './http/response-headers.middleware';

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

/** The body limit when no configuration is given (the `HTTP_BODY_LIMIT_BYTES` default). */
const DEFAULT_BODY_LIMIT_BYTES = ConfigSchema.shape.HTTP_BODY_LIMIT_BYTES.parse(undefined);

/**
 * Shared HTTP setup for the server entrypoint and the test harness. Call it before `init()` /
 * `listen()`: the body parsers registered here replace the framework's default ones.
 *
 * - The correlation id comes first, so every answer (also a refused body) carries one (§4.10).
 * - Every answer is `Cache-Control: no-store` and `nosniff`, and the framework is not named
 *   (`X-Powered-By` off) (R3-SECURITY-04, §4.14).
 * - Request bodies are read up to `HTTP_BODY_LIMIT_BYTES` (R3-SECURITY-02); a larger, badly encoded
 *   or interrupted body answers 400 VALIDATION_FAILED through the error filter (R3-SECURITY-03),
 *   never a 5xx a client would retry.
 */
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
  const express = app.getHttpAdapter().getInstance() as { disable(setting: string): unknown };
  express.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.use(responseHeadersMiddleware);
  const limit = config?.HTTP_BODY_LIMIT_BYTES ?? DEFAULT_BODY_LIMIT_BYTES;
  const expressApp = app as NestExpressApplication;
  expressApp.useBodyParser('json', { limit });
  expressApp.useBodyParser('urlencoded', { limit, extended: true });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
