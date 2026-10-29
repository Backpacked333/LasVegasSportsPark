import os from 'node:os';
import type { FactoryProvider } from '@nestjs/common';
import { CLIENT_APPS, CLIENT_PLATFORMS, z } from '@sportspark/contracts';
import { APP_CONFIG } from './tokens';

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
    /** How often the worker looks for due periodic jobs (K-06, §4.12; technical value). */
    PERIODIC_JOBS_TICK_MS: z.coerce.number().int().min(100).default(5000),
    /** How long a claimed periodic job stays reserved for its runner (SPK-AT-023 takeover after). */
    PERIODIC_JOBS_LEASE_SECONDS: z.coerce.number().int().min(5).default(300),
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
