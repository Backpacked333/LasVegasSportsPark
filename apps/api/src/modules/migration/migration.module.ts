import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CatalogModule } from '../catalog';
import { FinanceModule } from '../finance';
import { IdentityModule } from '../identity';
import {
  AuthorityController,
  ExternalMappingsController,
  ImportBatchesController,
  ImportExceptionsController,
  ReconciliationReportsController,
} from './controllers/migration.controllers';
import { DEFAULT_MIGRATION_POLICY, MIGRATION_POLICY } from './migration.policy';
import { AUTHORITY_GUARD_PORT, EXTERNAL_MAPPING_PORT } from './migration.ports';
import { AuthorityWriteInterceptor } from './services/authority-write.interceptor';
import { AuthorityService } from './services/authority.service';
import { ExternalMappingsService } from './services/external-mappings.service';
import { ImportApplyService } from './services/import-apply.service';
import { ImportBatchesService } from './services/import-batches.service';
import { ImportContextBuilder } from './services/import-context';
import { ImportExceptionsService } from './services/import-exceptions.service';
import { ImportTargets } from './services/import-targets';
import { ReconciliationService } from './services/reconciliation.service';

/**
 * MigrationModule (specification §5.3..§5.8, §4.4 Migration: ExternalMapping, ImportBatch,
 * ImportException, AuthorityAssignment; §4.7 invariant 11; SPK-AT-024). Owns import batches,
 * staged rows and their outcomes, external mappings, import exceptions (review queues), the
 * authority matrix and reconciliation reports. Creates imported records only through the owning
 * modules' exported services — identity (persons, households, relationships), catalog (programs)
 * and finance (opening obligations and credits) — never through their tables. Registers a global
 * interceptor that refuses the HTTP write commands of a record category while the legacy system
 * is authoritative for it (§5.6). See README.md.
 */
@Module({
  imports: [IdentityModule, CatalogModule, FinanceModule],
  providers: [
    // Policy values left to operators (§6.6): the proposed defaults, replaceable by approval.
    { provide: MIGRATION_POLICY, useValue: DEFAULT_MIGRATION_POLICY },
    AuthorityService,
    ExternalMappingsService,
    ImportTargets,
    ImportContextBuilder,
    ImportExceptionsService,
    ImportBatchesService,
    ImportApplyService,
    ReconciliationService,
    { provide: AUTHORITY_GUARD_PORT, useExisting: AuthorityService },
    { provide: EXTERNAL_MAPPING_PORT, useExisting: ExternalMappingsService },
    // §5.6 / §4.7 invariant 11: a synchronized copy never becomes an independent writer.
    { provide: APP_INTERCEPTOR, useClass: AuthorityWriteInterceptor },
  ],
  controllers: [
    ImportBatchesController,
    ImportExceptionsController,
    ExternalMappingsController,
    ReconciliationReportsController,
    AuthorityController,
  ],
  exports: [
    MIGRATION_POLICY,
    AUTHORITY_GUARD_PORT,
    EXTERNAL_MAPPING_PORT,
    AuthorityService,
    ExternalMappingsService,
    ImportBatchesService,
    ImportApplyService,
    ImportExceptionsService,
    ReconciliationService,
  ],
})
export class MigrationModule {}
