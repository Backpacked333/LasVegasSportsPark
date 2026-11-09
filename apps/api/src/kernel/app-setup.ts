import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigSchema, type AppConfig } from './config';
import { bodyDepthMiddleware } from './http/body-depth.middleware';
import { correlationMiddleware } from './http/correlation.middleware';
import { captureWebhookRawBody } from './http/raw-body';
import { requestLogMiddleware } from './http/request-log.middleware';
import type { RequestWithContext } from './http/request-context';
import { runWithLogContext } from './logging/log-context';
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
/** The nesting limit when no configuration is given (the `HTTP_BODY_MAX_DEPTH` default). */
const DEFAULT_BODY_MAX_DEPTH = ConfigSchema.shape.HTTP_BODY_MAX_DEPTH.parse(undefined);

/**
 * Shared HTTP setup for the server entrypoint and the test harness. Call it before `init()` /
 * `listen()`: the body parsers registered here replace the framework's default ones.
 *
 * - The correlation id comes first, so every answer (also a refused body) carries one (§4.10).
 * - Every answer is `Cache-Control: no-store` and `nosniff`, and the framework is not named
 *   (`X-Powered-By` off) (R3-SECURITY-04, §4.14).
 * - Request bodies are read up to `HTTP_BODY_LIMIT_BYTES` (R3-SECURITY-02); a larger, badly encoded
 *   or interrupted body answers 400 VALIDATION_FAILED through the error filter (R3-SECURITY-03),
 *   never a 5xx a client would retry; so does a body nested deeper than `HTTP_BODY_MAX_DEPTH`
 *   (`body_too_deep`), checked right after the parsers, before any route.
 * - Provider webhook routes keep the exact bytes of their body (`RawBody`) so a real provider's
 *   signature over those bytes can be verified (§4.11).
 */
export function configureApp(
  app: INestApplication,
  config?: AppConfig,
  options: {
    /** Let the framework close the application on SIGTERM; `main.ts` installs its own drain. */
    shutdownHooks?: boolean;
  } = {},
): INestApplication {
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
  if (config?.HTTP_ACCESS_LOG ?? true) app.use(requestLogMiddleware());
  app.use(responseHeadersMiddleware);
  const limit = config?.HTTP_BODY_LIMIT_BYTES ?? DEFAULT_BODY_LIMIT_BYTES;
  const expressApp = app as NestExpressApplication;
  // Webhook routes keep their exact body bytes for provider signature checks (§4.11). The
  // framework's types leave out body-parser's `verify` hook (it reserves it for its global
  // `rawBody` option, which would keep every request's bytes); without that option it passes
  // the hook through unchanged, which raw-body.spec.ts asserts.
  expressApp.useBodyParser('json', { limit, verify: captureWebhookRawBody } as { limit: number });
  expressApp.useBodyParser('urlencoded', {
    limit,
    extended: true,
    verify: captureWebhookRawBody,
  } as { limit: number; extended: boolean });
  // Registered after the parsers, so it sees the parsed body; a refusal reaches the error filter.
  app.use(bodyDepthMiddleware(config?.HTTP_BODY_MAX_DEPTH ?? DEFAULT_BODY_MAX_DEPTH));
  // The request's log context (§4.10): entered after the body parsers, whose stream callbacks
  // would otherwise run the rest of the request outside it, so every log line written while the
  // route runs carries the correlation id.
  app.use((req: RequestWithContext, _res: unknown, next: () => void) =>
    runWithLogContext({ correlationId: req.correlationId }, next),
  );
  app.setGlobalPrefix(API_PREFIX);
  if (options.shutdownHooks ?? true) app.enableShutdownHooks();
  return app;
}
