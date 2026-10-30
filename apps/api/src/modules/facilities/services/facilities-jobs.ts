import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import {
  PeriodicJobRegistry,
  UnitOfWork,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import { DATABASE } from '../../../kernel/tokens';
import { MaintenanceTasksService } from './maintenance-tasks.service';

export const RAISE_OVERDUE_TASK_EXCEPTIONS_JOB = 'facilities.raise_overdue_task_exceptions';

/**
 * Facilities periodic jobs (FAC-03; §4.12 durable background work with a failure owner, K-06
 * contract: idempotent, one small transaction per unit of work, no provider call).
 *
 * - facilities.raise_overdue_task_exceptions (SPK-UX-006, SPK-FAC-002): every 300 seconds, for
 *   each organization with an active facility, MaintenanceTasksService.raiseOverdueExceptions runs
 *   in its own transaction at the runner's clock instant. Every open task of an escalating
 *   severity whose due instant has passed gets the `facilities.maintenance_task_overdue`
 *   exception; its dedupe key (`maintenance_task:<id>:overdue`) keeps one open exception per
 *   task, so a replay or a later run raises nothing new. The tasks are locked FOR UPDATE SKIP
 *   LOCKED, and the task command settles the exception once the task is no longer overdue
 *   (ASYNC-09), so a sweep racing a resolution leaves no open exception behind. The outbox due
 *   timer (`facilities.maintenance_task_due_reached` → escalateIfOverdue, which reads the task
 *   row locked) still fires: the sweep covers tasks whose timer was lost, re-dated or written
 *   before the timer existed. Which severities escalate is the proposed FACILITIES_POLICY default
 *   (pending, DEC-001).
 *
 * A repeatedly failing run is owned by the facilities operator queue.
 */
@Injectable()
export class FacilitiesJobs implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly registry: PeriodicJobRegistry,
    private readonly uow: UnitOfWork,
    private readonly tasks: MaintenanceTasksService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: RAISE_OVERDUE_TASK_EXCEPTIONS_JOB,
      intervalSeconds: 300,
      failureOwner: 'facilities_operator',
      run: (context) => this.raiseOverdueTaskExceptions(context),
    });
  }

  /** `processed` counts the overdue escalating tasks found (each has exactly one open exception). */
  async raiseOverdueTaskExceptions({ now }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const organizations = await this.db
      .selectFrom('facilities')
      .select('organization_id')
      .distinct()
      .where('status', '=', 'active')
      .orderBy('organization_id')
      .execute();
    let processed = 0;
    for (const { organization_id: organizationId } of organizations) {
      processed += await this.uow.run(({ trx }) =>
        this.tasks.raiseOverdueExceptions(trx, organizationId, now),
      );
    }
    return { processed, remaining: 0 };
  }
}
