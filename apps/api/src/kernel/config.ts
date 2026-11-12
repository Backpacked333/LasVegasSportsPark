import os from 'node:os';
import type { FactoryProvider } from '@nestjs/common';
import { CLIENT_APPS, CLIENT_PLATFORMS, ProviderGateSchema, z } from '@sportspark/contracts';
import { APP_CONFIG } from './tokens';

/**
 * The `AUTH_LOCAL_SECRET` value once published in `.env.example`. Anyone can read it, so a host
 * configured with it would accept tokens minted by anyone (§4.14 protected secret storage).
 */
export const PUBLISHED_EXAMPLE_SECRET = 'change-me-to-at-least-32-random-characters';

/**
 * Signature algorithms a managed identity provider may use (§4.14). Symmetric algorithms are not
 * offered for `AUTH_MODE=oidc`: a key fetched from a public JWKS endpoint must be asymmetric.
 */
export const OIDC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;
export type OidcAlgorithm = (typeof OIDC_ALGORITHMS)[number];

/**
 * The adapter each provider-selection gate runs (§5.2), one environment variable per port:
 * `fake` is the deterministic test adapter (development and tests only, refused in production);
 * `none` means no provider is selected and the port refuses every call with a recorded failure,
 * so production can boot while a gate's decision (named here) is pending and the work that needs
 * the provider stays visibly unavailable. A real adapter's name joins the list when its decision
 * is recorded and the adapter exists.
 */
export const PROVIDER_SELECTORS = {
  PAYMENT_PROVIDER: { gate: 'payments', decisionRef: 'DEC-019', choices: ['fake', 'none'] },
  ACCOUNTING_PROVIDER: { gate: 'accounting', decisionRef: 'DEC-022', choices: ['fake', 'none'] },
  ACCESS_DEVICE_PROVIDER: { gate: 'hardware', decisionRef: 'DEC-023', choices: ['fake', 'none'] },
  MESSAGING_PUSH_PROVIDER: { gate: 'messaging', decisionRef: 'DEC-020', choices: ['fake', 'none'] },
  MESSAGING_EMAIL_PROVIDER: {
    gate: 'messaging',
    decisionRef: 'DEC-020',
    choices: ['fake', 'none'],
  },
  MESSAGING_SMS_PROVIDER: { gate: 'messaging', decisionRef: 'DEC-020', choices: ['fake', 'none'] },
} as const;
export type ProviderSelector = keyof typeof PROVIDER_SELECTORS;
export type ProviderChoice = (typeof PROVIDER_SELECTORS)[ProviderSelector]['choices'][number];

const providerChoice = z.enum(['fake', 'none']).optional();

/** The issuer the local development identity provider writes into its tokens. */
export const LOCAL_ISSUER = 'sportspark-local';

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
    /** Connections the API or worker process keeps open at most (technical value). */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    /**
     * Transport encryption to the database (§4.14 encrypted transport): `require` encrypts,
     * `verify-full` also verifies the server certificate (against DATABASE_SSL_CA_PATH when set).
     * Unset leaves it to the connection string's `sslmode`.
     */
    DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).optional(),
    DATABASE_SSL_CA_PATH: z.string().min(1).optional(),
    /** Server-side statement timeout for every pooled connection, in ms (unset: none). */
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).optional(),
    /** How long an idle pooled connection is kept (technical value). */
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
    /** How long opening a new connection may take before the request fails (technical value). */
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
    DB_AUTO_MIGRATE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    AUTH_MODE: z.enum(['local', 'oidc']).default('local'),
    AUTH_LOCAL_SECRET: z.string().min(32).optional(),
    AUTH_ISSUER: z.string().default(LOCAL_ISSUER),
    /**
     * A protected staging host (AUTH_MODE=local outside production, reachable from the internet):
     * when set, `POST /v1/dev/tokens` mints a token only for a request carrying this passcode, so
     * knowing an account id is not enough to sign in. Leave unset on a developer machine.
     */
    DEV_TOKENS_PASSCODE: z.string().min(16).optional(),
    AUTH_AUDIENCE: z.string().default('sportspark-api'),
    /**
     * `AUTH_MODE=oidc` (§5.2, DEC-018): the managed identity provider's JSON Web Key Set, from which
     * bearer tokens are verified (https in production). `AUTH_ISSUER` and `AUTH_AUDIENCE` must then
     * name the provider's issuer and the audience it puts in access tokens.
     */
    AUTH_JWKS_URL: z.url().optional(),
    /** Accepted token signature algorithms for `AUTH_MODE=oidc` (comma-separated, asymmetric only). */
    AUTH_ALLOWED_ALGS: z
      .string()
      .default('RS256,ES256')
      .transform((value, ctx) => parseAlgorithms(value, ctx)),
    /** Tolerated clock difference when checking token times (technical value). */
    AUTH_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
    /**
     * The provider-selection decisions this deployment runs under (§5.2), as `<gate>=DEC-###`
     * entries, for example `identity=DEC-018`. A real provider adapter registers only when its
     * gate's decision record is named here (the integration register refuses it otherwise); the
     * decision itself lives in docs/package-a/decision-register.md with its named owner.
     */
    PROVIDER_DECISIONS: z
      .string()
      .default('')
      .transform((value, ctx) => parseProviderDecisions(value, ctx)),
    PAYMENT_PROVIDER: providerChoice,
    ACCOUNTING_PROVIDER: providerChoice,
    ACCESS_DEVICE_PROVIDER: providerChoice,
    MESSAGING_PUSH_PROVIDER: providerChoice,
    MESSAGING_EMAIL_PROVIDER: providerChoice,
    MESSAGING_SMS_PROVIDER: providerChoice,
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
    /**
     * `json`: one JSON object per line with the request's correlation id (§5.11), the production
     * default; `text`: the framework's readable console output, the default elsewhere.
     */
    LOG_FORMAT: z.enum(['json', 'text']).optional(),
    /**
     * `GET /v1/ready` reads `degraded` once the oldest due outbox or inbox event has waited longer
     * than this (§5.11 worker age; technical value). It never takes the API out of rotation.
     */
    READY_QUEUE_LAG_SECONDS: z.coerce.number().int().min(10).default(300),
    /** `degraded` once no periodic job has succeeded for this long (worker stopped or stuck). */
    READY_WORKER_STALE_SECONDS: z.coerce.number().int().min(60).default(900),
    /**
     * Enables `GET /v1/metrics` (Prometheus text, global counts) for a scraper that sends this
     * value in `X-Metrics-Token` (§5.11). Unset: the route does not exist.
     */
    METRICS_TOKEN: z.string().min(24).optional(),
    /**
     * Rate-limit counters (§4.14 rate-limited recovery): `postgres` shares one count between every
     * API instance (the production default), `memory` counts per process (the default elsewhere).
     */
    RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).optional(),
    /** Overrides of the named limits, `<name>=<limit>/<seconds>`, e.g. `dev_tokens=5/60`. */
    RATE_LIMITS: z
      .string()
      .default('')
      .transform((value, ctx) => parseRateLimits(value, ctx)),
    /**
     * Express `trust proxy` (§4.14): `true` (any proxy), `false`, a hop count, or addresses and
     * subnets (`loopback`, `10.0.0.0/8`). Set it behind a load balancer so rate limits key on the
     * client and `Strict-Transport-Security` sees https. Unset: forwarded headers are ignored.
     */
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined || value === ''
          ? undefined
          : value === 'true'
            ? true
            : value === 'false'
              ? false
              : /^\d+$/.test(value)
                ? Number(value)
                : value,
      ),
    /** `Strict-Transport-Security` max-age on https answers (0 turns it off; technical value). */
    HSTS_MAX_AGE_SECONDS: z.coerce.number().int().min(0).default(31_536_000),
    /** One access line per answered request (method, path without ids or query, status, time). */
    HTTP_ACCESS_LOG: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** How often the worker looks for due periodic jobs (K-06, §4.12; technical value). */
    PERIODIC_JOBS_TICK_MS: z.coerce.number().int().min(100).default(5000),
    /**
     * How long a claimed periodic job stays reserved for its runner without a renewal (SPK-AT-023,
     * ASYNC-06). While a pass runs, the runner renews it every third of this, but only while the
     * run shows progress (a pass start, or the job's `renewJobLease`) within this long; a run that
     * shows none for this long is given up, counted as a failure, and its job is taken over once
     * the lease lapses, as is a stopped runner's.
     */
    PERIODIC_JOBS_LEASE_SECONDS: z.coerce.number().int().min(5).default(300),
    /**
     * The longest one run of a periodic job (all its passes) may take (§4.12, ASYNC-06; technical
     * value, at least PERIODIC_JOBS_LEASE_SECONDS). At this age the runner starts no further pass,
     * and a pass still running is given up: the lease is no longer renewed, `lease.signal` is
     * aborted, the run counts as a failure and the job is taken over once the lease lapses.
     */
    PERIODIC_JOBS_MAX_RUN_SECONDS: z.coerce.number().int().min(5).default(1800),
    /** How many passes one run makes while a job reports remaining work. */
    PERIODIC_JOBS_MAX_PASSES: z.coerce.number().int().min(1).max(1000).default(10),
    /** Consecutive failures after which the job's failure owner gets an exception (§4.12). */
    PERIODIC_JOBS_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(3),
    /**
     * Minimum supported app version per client (§4.13, SPK-AT-027), as a comma-separated list of
     * `<app>-<platform>=<major.minor.patch>` (apps `mobile`, `staff`; platforms `ios`, `android`,
     * `web`), for example `mobile-ios=1.3.0,mobile-android=1.3.0`. A request whose
     * `X-Sportspark-Client` header names an older build gets 426 CLIENT_UPDATE_REQUIRED. The values
     * are pending DEC-061 (mobile release definitions), so none is enforced by default.
     */
    CLIENT_MIN_VERSIONS: z
      .string()
      .default('')
      .transform((value, ctx) => parseClientMinimums(value, ctx)),
    /**
     * Set when the database was restored from a backup after live transactions (§5.8, SPK-AT-028):
     * a reference to the restore (ticket or backup id). At boot every organization enters recovery
     * mode for that restore (a `reliability.recovery_mode` exception), consequential financial
     * commands are refused and no new charge is started until provider facts are reconciled and a
     * general manager resumes normal operation (`POST /v1/recovery/resume`). A restore already
     * resumed is not re-entered when the process restarts with the same reference.
     */
    RECOVERY_RESTORE_REFERENCE: z.string().trim().min(1).max(200).optional(),
    /**
     * Browser origins allowed to call the API cross-origin (K-03), as a comma-separated list of
     * exact origins (`https://staff.example.org`). Unset: CORS is off (same-origin hosting). Which
     * origins serve the staff dashboard is DEC-021 (hosting, pending); production refuses `*` and
     * plain `http` origins.
     */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform((value, ctx) => parseOrigins(value, ctx)),
    /** How long a browser may cache a CORS preflight answer (technical value). */
    CORS_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),
    /**
     * The largest request body the API reads, in bytes (R3-SECURITY-02, §4.8, §4.15; technical
     * value). Every route shares it. The default (2 MiB) holds a contract-maximum offline batch
     * (`OfflineSyncBody`, 500 items with every bounded field at its maximum, even fully escaped),
     * which is about 0.35 MB in plain ASCII. A larger body answers 400 VALIDATION_FAILED with
     * `details.code = 'body_too_large'` and `details.limitBytes`, never a 5xx, so a client splits
     * it instead of retrying it. Import staging (`POST /v1/import-batches`) advertises more than
     * this in one request (17 CSV documents of 500,000 characters): stage large snapshots in
     * chunks, as the migration README says, or raise this for the migration window.
     */
    HTTP_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .max(64 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    /**
     * The deepest nesting of objects and arrays a JSON or form body may have (§4.10, §4.15;
     * technical value). Every route shares it. Open fields (`z.record(z.string(), z.unknown())`:
     * policy content, entitlement scope, details) pass validation as they are and are then
     * serialized by recursive code (`JSON.stringify`, the drivers), which overflows the stack at a
     * few thousand levels (about 10 KB of body); a deeper body answers 400 VALIDATION_FAILED with
     * `details.code = 'body_too_deep'` and `details.limitDepth` before any route runs, never a 5xx
     * a client would retry. No published contract nests near the default.
     */
    HTTP_BODY_MAX_DEPTH: z.coerce.number().int().min(16).max(1000).default(64),
    /**
     * How long an outbox or inbox event waits before it is tried again when the build that
     * recorded it expected a handler this build does not register (R3-OPERATIONS-01, §4.7
     * invariant 12: a software rollback or a rolling deploy). The event stays pending, its attempts
     * are not counted, and a build that registers the handler runs it (technical value).
     */
    OUTBOX_MISSING_HANDLER_RETRY_SECONDS: z.coerce.number().int().min(1).default(300),
    /**
     * How long an outbox or inbox event may wait for a missing handler (see
     * OUTBOX_MISSING_HANDLER_RETRY_SECONDS) before its owner is told (§5.11 "operational issues
     * must have owners"; technical value, longer than a rolling deploy). From then on the worker
     * keeps an operational exception open for it (`reliability.outbox_waiting_for_handler` or
     * `reliability.inbox_waiting_for_handler`, system administration) naming the missing handlers,
     * and resolves it once the event settles. The event itself keeps waiting: the wait ends when a
     * build that registers the handlers, or declares them retired, processes it.
     */
    OUTBOX_MISSING_HANDLER_ESCALATE_AFTER_SECONDS: z.coerce.number().int().min(1).default(3600),
    /**
     * The whole budget of a worker stop on SIGTERM or SIGINT (R3-OPERATIONS-10; technical value:
     * keep it under the host's termination grace period). Within it the worker waits for the work
     * in flight (the outbox and inbox event in hand, a periodic job pass, an idempotency sweep, and
     * the pass of any background worker whose `stop()` waits for it), then closes the application
     * and the database with what is left of it, and exits either way. The communications delivery
     * and finance provider loops stop starting passes but do not wait for the pass in flight
     * (**Proposed** for those modules). Work still running at the end is retried once its lease
     * lapses; the database rolls back a transaction left open by the exit.
     */
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(20_000),
    /**
     * The whole budget of an API stop on SIGTERM or SIGINT (R3-OPERATIONS-10; technical value,
     * under the host's termination grace period): requests in flight finish, then the modules and
     * the database close.
     */
    API_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),
    /**
     * How long a stopping API keeps answering (with `GET /v1/ready` at 503) before it closes its
     * server, so a load balancer notices and routes new requests elsewhere (technical value).
     */
    API_SHUTDOWN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(0),
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
    if (cfg.AUTH_MODE === 'oidc') {
      if (!cfg.AUTH_JWKS_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_JWKS_URL'],
          message:
            "AUTH_JWKS_URL is required when AUTH_MODE=oidc (the managed identity provider's JSON Web Key Set)",
        });
      } else if (cfg.NODE_ENV === 'production' && !cfg.AUTH_JWKS_URL.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_JWKS_URL'],
          message: 'AUTH_JWKS_URL must be an https URL in production',
        });
      }
      if (cfg.AUTH_ISSUER === LOCAL_ISSUER) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_ISSUER'],
          message:
            "AUTH_ISSUER must name the managed identity provider's issuer when AUTH_MODE=oidc (it is still the local default)",
        });
      }
    }
    if (cfg.NODE_ENV === 'production') {
      for (const [key, selector] of Object.entries(PROVIDER_SELECTORS) as Array<
        [ProviderSelector, (typeof PROVIDER_SELECTORS)[ProviderSelector]]
      >) {
        const choice = cfg[key];
        if (choice === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} must be set explicitly in production: "none" until the ${selector.gate} provider is selected (${selector.decisionRef}) and its adapter exists`,
          });
        } else if (choice === 'fake') {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key}=fake is a deterministic test adapter and cannot run in production (specification §5.2, ${selector.decisionRef})`,
          });
        }
      }
    }
    if (cfg.NODE_ENV === 'production') {
      for (const origin of cfg.CORS_ALLOWED_ORIGINS ?? []) {
        if (origin === '*' || origin.startsWith('http://')) {
          ctx.addIssue({
            code: 'custom',
            path: ['CORS_ALLOWED_ORIGINS'],
            message: `CORS_ALLOWED_ORIGINS may not contain "${origin}" in production (only exact https origins)`,
          });
        }
      }
    }
    if (cfg.PERIODIC_JOBS_MAX_RUN_SECONDS < cfg.PERIODIC_JOBS_LEASE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PERIODIC_JOBS_MAX_RUN_SECONDS'],
        message: 'PERIODIC_JOBS_MAX_RUN_SECONDS must be at least PERIODIC_JOBS_LEASE_SECONDS',
      });
    }
    if (cfg.API_SHUTDOWN_DELAY_MS > 0 && cfg.API_SHUTDOWN_DELAY_MS >= cfg.API_SHUTDOWN_TIMEOUT_MS) {
      // R3-OPERATIONS-10: the delay counts against the stop budget; one at or past it would leave
      // no time to close the server before the host's grace period ends.
      ctx.addIssue({
        code: 'custom',
        path: ['API_SHUTDOWN_DELAY_MS'],
        message:
          'API_SHUTDOWN_DELAY_MS must be less than API_SHUTDOWN_TIMEOUT_MS (the delay is part of the stop budget)',
      });
    }
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.DATABASE_URL &&
      cfg.DATABASE_SSL === undefined &&
      !databaseTransportProtected(cfg.DATABASE_URL)
    ) {
      // §4.14 encrypted transport: without DATABASE_SSL the URL decides; a remote database must
      // be reached over TLS (sslmode in the URL, or DATABASE_SSL), never plaintext by default.
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message:
          'DATABASE_SSL must be require or verify-full in production for a database on another host (or DATABASE_URL must set sslmode=require, verify-ca or verify-full) (§4.14 encrypted transport)',
      });
    }
    if (cfg.NODE_ENV === 'production' && cfg.DATABASE_SSL === 'disable') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'DATABASE_SSL=disable is refused in production (§4.14 encrypted transport)',
      });
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

export type AppConfig = z.infer<typeof ConfigSchema> & {
  /** Each module's parsed settings section (`defineModuleSettings`, K-15), by module name. */
  readonly moduleSettings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

// ---------------------------------------------------------------------------------------------
// Module settings (K-15, IF-43)
// ---------------------------------------------------------------------------------------------

export interface ModuleSettingsDefinition<S extends z.ZodRawShape> {
  readonly module: string;
  /** The environment variable prefix: the upper-case module name and `_`. */
  readonly prefix: string;
  readonly schema: z.ZodObject<S>;
  /** The injection token of the parsed section (`MODULE_SETTINGS(module)`). */
  readonly token: symbol;
}

/** The parsed settings type of a definition. */
export type ModuleSettingsOf<D> =
  D extends ModuleSettingsDefinition<infer S> ? z.infer<z.ZodObject<S>> : never;

const moduleSettingsDefinitions = new Map<string, ModuleSettingsDefinition<z.ZodRawShape>>();
const MODULE_NAME = /^[a-z]+$/;
const SETTING_KEY = /^[A-Z][A-Z0-9_]*$/;

/** The injection token of a module's parsed settings section. */
export function MODULE_SETTINGS(module: string): symbol {
  return Symbol.for(`sportspark:module-settings:${module}`);
}

/**
 * Registers a module's settings section (K-15, IF-43): each key is read from the environment
 * variable `<MODULE>_<KEY>` (for example `WORKFORCE_OFFICIAL_TURNAROUND_MINUTES`) and validated by
 * `loadConfig` at boot like the kernel's own settings, so a malformed value refuses boot. A policy
 * value is declared optional with no default (`policySetting`, K-00 (i)): absent, the module
 * applies its documented conservative behaviour; a technical value may default
 * (`technicalSetting`). Call it at module top level, before the configuration is loaded.
 */
export function defineModuleSettings<S extends z.ZodRawShape>(
  module: string,
  shape: S,
): ModuleSettingsDefinition<S> {
  if (!MODULE_NAME.test(module))
    throw new Error(`module settings name ${module} must be lower-case`);
  for (const key of Object.keys(shape)) {
    if (!SETTING_KEY.test(key)) {
      throw new Error(
        `module setting ${module}.${key} must be an upper-case name such as LEAD_DAYS`,
      );
    }
  }
  const existing = moduleSettingsDefinitions.get(module);
  if (existing) {
    if (existing.schema.shape === shape) return existing as unknown as ModuleSettingsDefinition<S>;
    throw new Error(`module settings for ${module} are already defined`);
  }
  const definition: ModuleSettingsDefinition<S> = {
    module,
    prefix: `${module.toUpperCase()}_`,
    schema: z.object(shape),
    token: MODULE_SETTINGS(module),
  };
  moduleSettingsDefinitions.set(
    module,
    definition as unknown as ModuleSettingsDefinition<z.ZodRawShape>,
  );
  return definition;
}

/** A policy value: optional, no default (absent = the item's conservative behaviour). */
export function policySetting<T extends z.ZodType>(schema: T) {
  return schema.optional();
}

/** A technical value (interval, batch size, retry threshold): may default. */
export function technicalSetting<T extends z.ZodType>(schema: T, fallback: z.input<T>) {
  return schema.default(fallback as never);
}

/** The defined module settings sections (for .env documentation and tests). */
export function moduleSettingsDefinitionList(): ReadonlyArray<
  ModuleSettingsDefinition<z.ZodRawShape>
> {
  return [...moduleSettingsDefinitions.values()].sort((a, b) => a.module.localeCompare(b.module));
}

function parseModuleSettings(env: NodeJS.ProcessEnv): {
  settings: Record<string, Record<string, unknown>>;
  issues: string[];
} {
  const settings: Record<string, Record<string, unknown>> = {};
  const issues: string[] = [];
  for (const definition of moduleSettingsDefinitions.values()) {
    const raw: Record<string, unknown> = {};
    for (const key of Object.keys(definition.schema.shape)) {
      const value = env[`${definition.prefix}${key}`];
      if (value !== undefined && value !== '') raw[key] = value;
    }
    const parsed = definition.schema.safeParse(raw);
    if (parsed.success) settings[definition.module] = parsed.data as Record<string, unknown>;
    else {
      for (const issue of parsed.error.issues) {
        issues.push(`  ${definition.prefix}${issue.path.join('.')}: ${issue.message}`);
      }
    }
  }
  return { settings, issues };
}

export { CLIENT_APPS, CLIENT_PLATFORMS };
/** `<app>-<platform>` → minimum supported version (DEC-061 pending; empty by default). */
export type ClientMinimums = Readonly<Record<string, string>>;

const VERSION = /^\d+\.\d+\.\d+$/;

function parseClientMinimums(value: string, ctx: z.RefinementCtx): ClientMinimums {
  const out: Record<string, string> = {};
  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [client, version] = entry.split('=').map((p) => p.trim());
    const [app, platform] = (client ?? '').split('-');
    if (
      !version ||
      !VERSION.test(version) ||
      !(CLIENT_APPS as readonly string[]).includes(app ?? '') ||
      !(CLIENT_PLATFORMS as readonly string[]).includes(platform ?? '')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `CLIENT_MIN_VERSIONS entry "${entry}" must be <mobile|staff>-<ios|android|web>=<major.minor.patch>`,
      });
      continue;
    }
    out[`${app}-${platform}`] = version;
  }
  return out;
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** `https://a.example,https://b.example` → exact origins; `*` is kept so production can refuse it. */
function parseOrigins(
  value: string | undefined,
  ctx: z.RefinementCtx,
): readonly string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const origins = value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (origin !== '*' && !ORIGIN.test(origin)) {
      ctx.addIssue({
        code: 'custom',
        message: `CORS_ALLOWED_ORIGINS entry "${origin}" must be an exact origin such as https://staff.example.org (scheme, host, optional port; no path)`,
      });
    }
  }
  return origins;
}

/** The routes' named rate limits (`DEFAULT_RATE_LIMITS` in http/rate-limit.ts). */
export const RATE_LIMIT_NAMES = [
  'dev_tokens',
  'claims',
  'invitations',
  'account_recovery',
  'account_registration',
] as const;
type RateLimitOverrides = Readonly<
  Partial<Record<(typeof RATE_LIMIT_NAMES)[number], { limit: number; windowSeconds: number }>>
>;

function parseRateLimits(value: string, ctx: z.RefinementCtx): RateLimitOverrides {
  const out: Partial<
    Record<(typeof RATE_LIMIT_NAMES)[number], { limit: number; windowSeconds: number }>
  > = {};
  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const match = /^([a-z_]+)=(\d+)\/(\d+)$/.exec(entry);
    const name = match?.[1] as (typeof RATE_LIMIT_NAMES)[number] | undefined;
    if (
      !match ||
      !name ||
      !RATE_LIMIT_NAMES.includes(name) ||
      Number(match[2]) < 1 ||
      Number(match[3]) < 1
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `RATE_LIMITS entry "${entry}" must be <name>=<limit>/<seconds> with name one of ${RATE_LIMIT_NAMES.join(', ')}`,
      });
      continue;
    }
    out[name] = { limit: Number(match[2]), windowSeconds: Number(match[3]) };
  }
  return out;
}

function parseAlgorithms(value: string, ctx: z.RefinementCtx): readonly OidcAlgorithm[] {
  const algorithms = value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (algorithms.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'AUTH_ALLOWED_ALGS must name at least one algorithm' });
  }
  for (const algorithm of algorithms) {
    if (!(OIDC_ALGORITHMS as readonly string[]).includes(algorithm)) {
      ctx.addIssue({
        code: 'custom',
        message: `AUTH_ALLOWED_ALGS entry "${algorithm}" is not an accepted asymmetric algorithm (${OIDC_ALGORITHMS.join(', ')})`,
      });
    }
  }
  return algorithms as OidcAlgorithm[];
}

const DECISION_REF = /^DEC-\d{3}$/;

/** `identity=DEC-018,payments=DEC-019` → gate → decision record. */
function parseProviderDecisions(
  value: string,
  ctx: z.RefinementCtx,
): Readonly<Partial<Record<z.infer<typeof ProviderGateSchema>, string>>> {
  const out: Partial<Record<z.infer<typeof ProviderGateSchema>, string>> = {};
  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [gate, decisionRef] = entry.split('=').map((p) => p.trim());
    const parsedGate = ProviderGateSchema.safeParse(gate);
    if (!parsedGate.success || !decisionRef || !DECISION_REF.test(decisionRef)) {
      ctx.addIssue({
        code: 'custom',
        message: `PROVIDER_DECISIONS entry "${entry}" must be <gate>=DEC-### with gate one of ${ProviderGateSchema.options.join(', ')}`,
      });
      continue;
    }
    out[parsedGate.data] = decisionRef;
  }
  return out;
}

/**
 * The adapter a provider-selection gate runs (§5.2): the configured choice, else the fake outside
 * production (production refuses an unset selector at boot, so it never falls through to here).
 */
export function providerSelection(config: AppConfig, key: ProviderSelector): ProviderChoice {
  const choice = config[key];
  if (choice) return choice;
  if (config.NODE_ENV === 'production') {
    throw new Error(`${key} must be set explicitly in production`);
  }
  return 'fake';
}

/**
 * Whether a database URL already protects its transport: it names a TLS sslmode, or the database
 * is on this host (a loopback address or a Unix socket), so the traffic crosses no network.
 */
function databaseTransportProtected(url: string): boolean {
  // A Unix socket (`?host=/var/run/postgresql`, or `socket:/path`) is local by definition; such
  // URLs often have an empty host, which the URL parser rejects.
  if (/^socket:/i.test(url) || /[?&]host=(?:\/|%2F)/i.test(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  const modules = parseModuleSettings(env);
  const lines = [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)),
    ...modules.issues,
  ];
  if (!parsed.success || lines.length > 0) {
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return { ...parsed.data, moduleSettings: modules.settings };
}

/**
 * The provider of a module's parsed settings section, injected with
 * `@Inject(MODULE_SETTINGS('<module>'))` (K-15, IF-43). Add it to the module's providers.
 */
export function moduleSettings(module: string): FactoryProvider {
  return {
    provide: MODULE_SETTINGS(module),
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => {
      const section = config.moduleSettings[module];
      if (!section) {
        throw new Error(
          `no settings section for module ${module}: defineModuleSettings must run before the configuration is loaded`,
        );
      }
      return section;
    },
  };
}
