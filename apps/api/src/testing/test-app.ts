import 'reflect-metadata';
import {
  Module,
  type DynamicModule,
  type INestApplication,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { newId, type CapabilityId, type Principal } from '@sportspark/contracts';
import { createTestDatabase, seedOrganization, type Db, type TestDatabase } from '@sportspark/db';
import supertest from 'supertest';
import { configureApp } from '../kernel/app-setup';
import type { VerifiedIdentity } from '../kernel/auth/identity-provider.port';
import { LocalJwtIdentityProvider } from '../kernel/auth/local-jwt.identity-provider';
import type { PrincipalResolverPort } from '../kernel/auth/principal-resolver.port';
import { FixedClock } from '../kernel/clock';
import { loadConfig, type AppConfig } from '../kernel/config';
import { KernelModule, PRINCIPAL_RESOLVER_IMPL } from '../kernel/kernel.module';
import { CLOCK, IDENTITY_PROVIDER } from '../kernel/tokens';
import {
  PeriodicJobRunner,
  type PeriodicJobRunSummary,
  type RunOnceOptions,
} from '../kernel/jobs/periodic-jobs';
import { setCapability } from './capabilities';

/**
 * Capabilities a test organization starts with (K-12): pickup sessions, the one enforced
 * capability whose commands predate the capability switches. Every other capability is off, as
 * in a new organization (DEC-016).
 */
export const DEFAULT_TEST_CAPABILITIES: readonly CapabilityId[] = ['pickup_sessions'];

export const TEST_CONFIG_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  AUTH_MODE: 'local',
  AUTH_LOCAL_SECRET: 'sportspark-test-secret-sportspark-test-secret',
  OUTBOX_POLL_INTERVAL_MS: '50',
  OUTBOX_LOCK_LEASE_SECONDS: '5',
  WORKER_ID: 'test-worker',
  LOG_LEVEL: 'error',
};

/** In-memory principal directory used until (or instead of) the identity module's resolver. */
export class FakePrincipalResolver implements PrincipalResolverPort {
  private readonly bySubject = new Map<string, Principal>();

  register(principal: Principal, subject: string = principal.accountId ?? newId()): string {
    this.bySubject.set(subject, principal);
    return subject;
  }

  async resolve(identity: VerifiedIdentity): Promise<Principal | null> {
    return this.bySubject.get(identity.subject) ?? null;
  }
}

export interface TestAppOptions {
  imports?: ModuleMetadata['imports'];
  providers?: Provider[];
  controllers?: ModuleMetadata['controllers'];
  /** 'fake' (default) registers FakePrincipalResolver as PRINCIPAL_RESOLVER_IMPL; 'module' uses whatever the imported modules register. */
  principalResolver?: 'fake' | 'module';
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  env?: NodeJS.ProcessEnv;
  /** Start the test clock at a fixed instant (defaults to the real clock, frozen at creation). */
  clockStart?: Date | string;
  /** Capabilities enabled for the seeded organization (default `DEFAULT_TEST_CAPABILITIES`). */
  capabilities?: readonly CapabilityId[];
}

export interface TestApp {
  app: INestApplication;
  db: Db;
  database: TestDatabase;
  config: AppConfig;
  clock: FixedClock;
  http: ReturnType<typeof supertest>;
  identityProvider: LocalJwtIdentityProvider;
  principals: FakePrincipalResolver;
  organizationId: string;
  facilityId: string;
  /** Registers the principal (fake resolver) and mints a bearer token for it. */
  tokenFor(principal: Principal): Promise<string>;
  authHeader(principal: Principal): Promise<{ Authorization: string }>;
  /** Fixture: turns a capability on for an organization (default: the seeded one), ungated. */
  enableCapability(capability: CapabilityId, organizationId?: string): Promise<void>;
  /** Fixture: turns a capability off for an organization (default: the seeded one), ungated. */
  disableCapability(capability: CapabilityId, organizationId?: string): Promise<void>;
  /**
   * Runs the registered periodic jobs once (K-06), at the FixedClock's instant. By default a job
   * runs even when its interval has not elapsed since the last run; the lease is still respected.
   */
  runPeriodicJobs(
    names?: readonly string[],
    options?: RunOnceOptions,
  ): Promise<PeriodicJobRunSummary[]>;
  close(): Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const { organizationId, facilityId } = await seedOrganization(database.db);
  for (const capability of options.capabilities ?? DEFAULT_TEST_CAPABILITIES) {
    await setCapability(database.db, organizationId, capability, true);
  }
  const config = loadConfig({ ...TEST_CONFIG_ENV, ...(options.env ?? {}) });
  const identityProvider = new LocalJwtIdentityProvider(config);
  const principals = new FakePrincipalResolver();
  const clock = new FixedClock(options.clockStart ?? new Date());

  @Module({})
  class TestSupportModule {
    static forRoot(): DynamicModule {
      const providers: Provider[] = [...(options.providers ?? [])];
      if ((options.principalResolver ?? 'fake') === 'fake') {
        providers.push({ provide: PRINCIPAL_RESOLVER_IMPL, useValue: principals });
      }
      return {
        module: TestSupportModule,
        global: true,
        providers,
        controllers: options.controllers ?? [],
        exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
      };
    }
  }

  let builder = Test.createTestingModule({
    imports: [
      KernelModule.forRoot({ config, database: database.db, identityProvider }),
      TestSupportModule.forRoot(),
      ...(options.imports ?? []),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(IDENTITY_PROVIDER)
    .useValue(identityProvider);
  if (options.configure) builder = options.configure(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  configureApp(app, config);
  await app.init();

  const tokenFor = async (principal: Principal): Promise<string> => {
    const subject = principals.register(principal);
    return identityProvider.mint({ subject, sessionId: principal.sessionId });
  };

  return {
    app,
    db: database.db,
    database,
    config,
    clock,
    http: supertest(app.getHttpServer()),
    identityProvider,
    principals,
    organizationId,
    facilityId,
    tokenFor,
    authHeader: async (principal) => ({ Authorization: `Bearer ${await tokenFor(principal)}` }),
    enableCapability: (capability, org = organizationId) =>
      setCapability(database.db, org, capability, true),
    disableCapability: (capability, org = organizationId) =>
      setCapability(database.db, org, capability, false),
    runPeriodicJobs: (names, runOptions = { ignoreInterval: true }) =>
      app.get(PeriodicJobRunner).runOnce(names, runOptions),
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
