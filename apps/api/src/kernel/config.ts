import os from 'node:os';
import { z } from '@sportspark/contracts';

/**
 * The `AUTH_LOCAL_SECRET` value once published in `.env.example`. Anyone can read it, so a host
 * configured with it would accept tokens minted by anyone (§4.14 protected secret storage).
 */
export const PUBLISHED_EXAMPLE_SECRET = 'change-me-to-at-least-32-random-characters';

/**
 * Typed runtime configuration. Secrets arrive through the environment (never committed).
 * Security boundary: the local HS256 identity provider is for development and automated tests only
 * and refuses to boot in production; a managed identity provider is a provider-selection gate (§5.2).
 * `NODE_ENV` has no default: the production guards (local identity, `/v1/dev/tokens`, automatic
 * migration, PGlite) all key on it, so a host that forgot to set it must fail closed, not boot as
 * development (§4.14).
 */
export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error:
        'NODE_ENV must be set explicitly to development, test or production (the local identity provider, /v1/dev/tokens and automatic migration are refused only when it is production)',
    }),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_VERSION: z.string().default('0.1.0'),
    DATABASE_URL: z.string().min(1).optional(),
    PGLITE_DATA_DIR: z.string().min(1).optional(),
    DB_AUTO_MIGRATE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    AUTH_MODE: z.enum(['local', 'oidc']).default('local'),
    AUTH_LOCAL_SECRET: z.string().min(32).optional(),
    AUTH_ISSUER: z.string().default('sportspark-local'),
    AUTH_AUDIENCE: z.string().default('sportspark-api'),
    AUTH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(8 * 3600),
    WORKER_ID: z.string().default(`${os.hostname()}-${process.pid}`),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    OUTBOX_LOCK_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).default(24),
    /**
     * How long a claimed idempotency key stays reserved for the request that claimed it (§4.9).
     * After it lapses, a retry may take the key over, but only when the first request committed
     * nothing. It must exceed the longest-running idempotent request.
     */
    IDEMPOTENCY_LEASE_SECONDS: z.coerce.number().int().min(5).default(120),
    /** How often the worker deletes idempotency records past their expiry (§4.9, §4.14). */
    IDEMPOTENCY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
    LOG_LEVEL: z.enum(['debug', 'log', 'warn', 'error']).default('log'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AUTH_MODE === 'local') {
      if (cfg.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_MODE'],
          message:
            'AUTH_MODE=local is a development/test identity provider and cannot run in production; select a managed identity provider (decision register: providers).',
        });
      }
      if (!cfg.AUTH_LOCAL_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_LOCAL_SECRET'],
          message: 'AUTH_LOCAL_SECRET (>= 32 chars) is required when AUTH_MODE=local',
        });
      } else if (cfg.AUTH_LOCAL_SECRET === PUBLISHED_EXAMPLE_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_LOCAL_SECRET'],
          message:
            'AUTH_LOCAL_SECRET is the published example value; generate a private one (for example: openssl rand -hex 32)',
        });
      }
    }
    if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL is required in production (PGlite is for development and tests only)',
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
