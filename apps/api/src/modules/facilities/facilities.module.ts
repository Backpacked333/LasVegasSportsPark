import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry } from '../../kernel';
import { IdentityModule } from '../identity';
import { ClosureLifted, SchedulingModule } from '../scheduling';
import { AssetsController } from './controllers/assets.controller';
import { MaintenanceTasksController } from './controllers/maintenance-tasks.controller';
import { PreventiveSchedulesController } from './controllers/preventive-schedules.controller';
import { RestrictionsController } from './controllers/restrictions.controller';
import { MaintenanceTaskDueReached } from './facilities.events';
import { DEFAULT_FACILITIES_POLICY, FACILITIES_POLICY } from './facilities.policy';
import { MAINTENANCE_REPORT_PORT, OPERATING_STATUS_PORT } from './ports';
import { AssetsService } from './services/assets.service';
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
  { provide: MAINTENANCE_REPORT_PORT, useExisting: MaintenanceTasksService },
  { provide: OPERATING_STATUS_PORT, useExisting: RestrictionsService },
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
    FACILITIES_POLICY,
  ],
})
export class FacilitiesModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly tasks: MaintenanceTasksService,
    private readonly restrictions: RestrictionsService,
  ) {}

  onModuleInit(): void {
    // Due timer (enqueued with availableAt = dueAt): escalate an overdue critical task once (SPK-UX-006).
    this.registry.on<EventPayload<typeof MaintenanceTaskDueReached>>(
      MaintenanceTaskDueReached.type,
      'facilities.escalate_overdue_task',
      async (event, ctx) => {
        await this.tasks.escalateIfOverdue(ctx.trx, event.organizationId, event.payload.taskId);
      },
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
    );
  }
}
