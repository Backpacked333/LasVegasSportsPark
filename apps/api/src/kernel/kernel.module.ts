import { Global, Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import type { Db } from '@sportspark/db';
import { AuditWriter } from './audit/audit.writer';
import { AuthGuard } from './auth/auth.guard';
import type { IdentityProviderPort, VerifiedIdentity } from './auth/identity-provider.port';
import { LocalJwtIdentityProvider } from './auth/local-jwt.identity-provider';
import type { PrincipalResolverPort } from './auth/principal-resolver.port';
import {
  denyAllRelationshipAuthority,
  denyAllTeamAuthority,
  type RelationshipAuthorityPort,
  type TeamAuthorityPort,
} from './authorization/authorization.port';
import { AuthorizationService } from './authorization/authorization.service';
import { SystemClock } from './clock';
import { loadConfig, type AppConfig } from './config';
import { databaseProvider } from './database/database.provider';
import { UnitOfWork } from './database/unit-of-work';
import { OperationalExceptions } from './exceptions/operational-exceptions.service';
import { HealthController } from './health/health.controller';
import { DomainExceptionFilter } from './http/domain-exception.filter';
import { IdempotencyInterceptor } from './http/idempotency.interceptor';
import { Inbox } from './inbox/inbox';
import { OperationsController } from './operations/operations.controller';
import { OperationsService } from './operations/operations.service';
import { EventHandlerRegistry } from './outbox/event-handler.registry';
import { Outbox } from './outbox/outbox';
import { OutboxDispatcher } from './outbox/outbox-dispatcher';
import {
  APP_CONFIG,
  CLOCK,
  DATABASE,
  IDENTITY_PROVIDER,
  PRINCIPAL_RESOLVER_PORT,
  RELATIONSHIP_AUTHORITY_PORT,
  TEAM_AUTHORITY_PORT,
} from './tokens';

/**
 * Implementation tokens: modules register these (identity registers the principal resolver and
 * relationship authority; competition registers team authority). The kernel resolves them lazily
 * through ModuleRef so there are no import cycles, and falls back to deny-all when absent.
 */
export const PRINCIPAL_RESOLVER_IMPL = Symbol('PRINCIPAL_RESOLVER_IMPL');
export const RELATIONSHIP_AUTHORITY_IMPL = Symbol('RELATIONSHIP_AUTHORITY_IMPL');
export const TEAM_AUTHORITY_IMPL = Symbol('TEAM_AUTHORITY_IMPL');

export interface KernelModuleOptions {
  config?: AppConfig;
  /** Pre-opened database (tests). When omitted the kernel opens one from configuration. */
  database?: Db;
  identityProvider?: IdentityProviderPort;
}

function lazy<T extends object>(moduleRef: ModuleRef, token: symbol, fallback: T, warn: string): T {
  const logger = new Logger('Kernel');
  let warned = false;
  const resolveImpl = (): T => {
    try {
      return moduleRef.get<T>(token, { strict: false });
    } catch {
      if (!warned) {
        warned = true;
        logger.warn(warn);
      }
      return fallback;
    }
  };
  return new Proxy(fallback, {
    get(_target, prop) {
      const impl = resolveImpl();
      const value = (impl as Record<PropertyKey, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(impl)
        : value;
    },
  });
}

@Global()
@Module({})
export class KernelModule {
  static forRoot(options: KernelModuleOptions = {}): DynamicModule {
    const config = options.config ?? loadConfig();
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      options.database ? { provide: DATABASE, useValue: options.database } : databaseProvider,
      { provide: CLOCK, useClass: SystemClock },
      {
        provide: IDENTITY_PROVIDER,
        useFactory: (): IdentityProviderPort => {
          if (options.identityProvider) return options.identityProvider;
          if (config.AUTH_MODE === 'local') return new LocalJwtIdentityProvider(config);
          throw new Error(
            'AUTH_MODE=oidc: a managed identity provider has not been selected (specification §5.2). ' +
              'Record the decision in docs/package-a/decision-register.md and implement the adapter behind IdentityProviderPort.',
          );
        },
      },
      {
        provide: PRINCIPAL_RESOLVER_PORT,
        inject: [ModuleRef],
        useFactory: (moduleRef: ModuleRef): PrincipalResolverPort =>
          lazy<PrincipalResolverPort>(
            moduleRef,
            PRINCIPAL_RESOLVER_IMPL,
            { resolve: async (_identity: VerifiedIdentity) => null },
            'no PRINCIPAL_RESOLVER_IMPL registered: every bearer token resolves to no principal',
          ),
      },
      {
        provide: RELATIONSHIP_AUTHORITY_PORT,
        inject: [ModuleRef],
        useFactory: (moduleRef: ModuleRef): RelationshipAuthorityPort =>
          lazy(
            moduleRef,
            RELATIONSHIP_AUTHORITY_IMPL,
            denyAllRelationshipAuthority,
            'no RELATIONSHIP_AUTHORITY_IMPL registered: relationship permissions deny all',
          ),
      },
      {
        provide: TEAM_AUTHORITY_PORT,
        inject: [ModuleRef],
        useFactory: (moduleRef: ModuleRef): TeamAuthorityPort =>
          lazy(
            moduleRef,
            TEAM_AUTHORITY_IMPL,
            denyAllTeamAuthority,
            'no TEAM_AUTHORITY_IMPL registered: team roles deny all',
          ),
      },
      UnitOfWork,
      AuthorizationService,
      AuditWriter,
      EventHandlerRegistry,
      Outbox,
      OperationalExceptions,
      OutboxDispatcher,
      Inbox,
      OperationsService,
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
    ];
    return {
      module: KernelModule,
      providers,
      controllers: [HealthController, OperationsController],
      exports: [
        APP_CONFIG,
        DATABASE,
        CLOCK,
        IDENTITY_PROVIDER,
        PRINCIPAL_RESOLVER_PORT,
        RELATIONSHIP_AUTHORITY_PORT,
        TEAM_AUTHORITY_PORT,
        UnitOfWork,
        AuthorizationService,
        AuditWriter,
        EventHandlerRegistry,
        Outbox,
        OperationalExceptions,
        OutboxDispatcher,
        Inbox,
        OperationsService,
      ],
    };
  }
}
