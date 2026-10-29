import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, lazyPort } from '../../kernel';
import { IdentityModule } from '../identity';
import { ClosureLiftGuards, ClosureLifted, SchedulingModule } from '../scheduling';
import { AssetsController } from './controllers/assets.controller';
import { MaintenanceTasksController } from './controllers/maintenance-tasks.controller';
import { PreventiveSchedulesController } from './controllers/preventive-schedules.controller';
import { RestrictionsController } from './controllers/restrictions.controller';
import { MaintenanceTaskDueReached } from './facilities.events';
import { DEFAULT_FACILITIES_POLICY, FACILITIES_POLICY } from './facilities.policy';
import {
  ASSET_DIRECTORY_IMPL,
  ASSET_DIRECTORY_PORT,
  MAINTENANCE_REPORT_PORT,
  noAssetDirectory,
  OPERATING_STATUS_PORT,
  type AssetDirectoryPort,
} from './ports';
import { AssetDirectoryService } from './services/asset-directory.service';
import { AssetsService } from './services/assets.service';
import { FacilitiesJobs } from './services/facilities-jobs';
import { FacilitiesReader } from './services/facilities-reader';
import { MaintenanceTasksService } from './services/maintenance-tasks.service';
import { PreventiveSchedulesService } from './services/preventive-schedules.service';
import { RestrictionsService } from './services/restrictions.service';

const providers: Provider[] = [
  { provide: FACILITIES_POLICY, useValue: DEFAULT_FACILITIES_POLICY },
  FacilitiesReader,
  AssetsService,
  MaintenanceTasksService,
  RestrictionsService,
  PreventiveSchedulesService,
  AssetDirectoryService,
  // FAC-03 (SPK-UX-006): registers facilities.raise_overdue_task_exceptions with the kernel runner.
  FacilitiesJobs,
  { provide: MAINTENANCE_REPORT_PORT, useExisting: MaintenanceTasksService },
  { provide: OPERATING_STATUS_PORT, useExisting: RestrictionsService },
  // FAC-02, IF-33: facilities is the provider of the asset directory (SPK-COND-003 equipment).
  { provide: ASSET_DIRECTORY_IMPL, useExisting: AssetDirectoryService },
  // The port resolves ASSET_DIRECTORY_IMPL lazily; the declared default (no asset known) answers
  // only where FacilitiesModule is absent.
  {
    provide: ASSET_DIRECTORY_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): AssetDirectoryPort =>
      lazyPort(
        moduleRef,
        ASSET_DIRECTORY_IMPL,
        noAssetDirectory,
        'no ASSET_DIRECTORY_IMPL registered: every asset reads as unknown (FAC-02)',
      ),
  },
];

/**
 * FacilitiesModule (specification §3.17 SPK-FAC-001..005, §4.4 Facilities, SPK-AT-021). Owns
 * assets, maintenance tasks, inspections, operating restrictions and preventive schedules.
 * Restrictions reach scheduling only through the scheduling module's closure port and public
 * services (§4.2): this module never writes scheduling tables. Assigned task owners are checked
 * through the identity person directory port (§4.3).
 */
@Module({
  imports: [IdentityModule, SchedulingModule],
  providers,
  controllers: [
    AssetsController,
    MaintenanceTasksController,
    RestrictionsController,
    PreventiveSchedulesController,
  ],
  exports: [
    AssetsService,
    MaintenanceTasksService,
    RestrictionsService,
    PreventiveSchedulesService,
    MAINTENANCE_REPORT_PORT,
    OPERATING_STATUS_PORT,
    ASSET_DIRECTORY_PORT,
    FACILITIES_POLICY,
  ],
})
export class FacilitiesModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly tasks: MaintenanceTasksService,
    private readonly restrictions: RestrictionsService,
    private readonly liftGuards: ClosureLiftGuards,
  ) {}

  onModuleInit(): void {
    // SPK-FAC-004: a closure backing an unreleased restriction is lifted only by the facilities
    // release (inspection and release authority checked), never directly in scheduling.
    // A closure a restriction still holds is withdrawn with that restriction, never directly
    // over the scheduling route (OWNED_BY_RESTRICTION, FAC-01).
    this.liftGuards.register(
      'facilities.restriction_release',
      (trx, organizationId, closureId, operation) =>
        operation === 'withdraw'
          ? this.restrictions.assertClosureWithdrawAllowed(trx, organizationId, closureId)
          : this.restrictions.assertClosureLiftAllowed(trx, organizationId, closureId),
    );
    // Due timer (enqueued with availableAt = dueAt): escalate an overdue critical task once (SPK-UX-006).
    this.registry.on<EventPayload<typeof MaintenanceTaskDueReached>>(
      MaintenanceTaskDueReached.type,
      'facilities.escalate_overdue_task',
      async (event, ctx) => {
        await this.tasks.escalateIfOverdue(ctx.trx, event.organizationId, event.payload.taskId);
      },
      { failureOwner: 'facilities_operator' },
    );
    // A closure lifted in scheduling outside a facilities release never reopens silently (SPK-FAC-004).
    this.registry.on<EventPayload<typeof ClosureLifted>>(
      ClosureLifted.type,
      'facilities.reconcile_lifted_closure',
      async (event, ctx) => {
        await this.restrictions.reconcileLiftedClosure(
          ctx.trx,
          event.organizationId,
          event.payload.closureId,
        );
      },
      { failureOwner: 'facilities_operator' },
    );
  }
}
