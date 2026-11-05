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
import { RestrictionsService } from './restrictions.service';

export const RAISE_OVERDUE_TASK_EXCEPTIONS_JOB = 'facilities.raise_overdue_task_exceptions';
export const RAISE_UNRELEASED_RESTRICTION_EXCEPTIONS_JOB =
  'facilities.raise_unreleased_restriction_exceptions';

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
 * - facilities.raise_unreleased_restriction_exceptions (R4-OPS-MODULES-02, SPK-FAC-004,
 *   SPK-AT-021): every 300 seconds, for each organization with an active facility,
 *   RestrictionsService.raiseUnreleasedAtEndExceptions runs in its own transaction at the runner's
 *   clock instant. A restriction's closure ends with its approved interval, so an active
 *   restriction nobody releases stops blocking the area at its end: the facilities operator gets
 *   one `facilities.restriction_unreleased_at_end` exception per restriction, `high` from
 *   `restrictionEndWarningHours` (proposed 24 h, DEC-001) before the end while the task's
 *   inspection is outstanding, `warning` once the interval ended without a release. A follow-on
 *   restriction of the same task covering the end, a passed inspection before the end, or the
 *   release settles it; the restrictions are locked FOR UPDATE SKIP LOCKED.
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
    private readonly restrictions: RestrictionsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: RAISE_OVERDUE_TASK_EXCEPTIONS_JOB,
      intervalSeconds: 300,
      failureOwner: 'facilities_operator',
      run: (context) => this.raiseOverdueTaskExceptions(context),
    });
    this.registry.register({
      name: RAISE_UNRELEASED_RESTRICTION_EXCEPTIONS_JOB,
      intervalSeconds: 300,
      failureOwner: 'facilities_operator',
      run: (context) => this.raiseUnreleasedRestrictionExceptions(context),
    });
  }

  /** `processed` counts the overdue escalating tasks found (each has exactly one open exception). */
  async raiseOverdueTaskExceptions({ now }: PeriodicJobContext): Promise<PeriodicJobResult> {
    let processed = 0;
    for (const organizationId of await this.organizationsWithActiveFacilities()) {
      processed += await this.uow.run(({ trx }) =>
        this.tasks.raiseOverdueExceptions(trx, organizationId, now),
      );
    }
    return { processed, remaining: 0 };
  }

  /** `processed` counts the restrictions left with an open unreleased-at-end exception. */
  async raiseUnreleasedRestrictionExceptions({
    now,
  }: PeriodicJobContext): Promise<PeriodicJobResult> {
    let processed = 0;
    for (const organizationId of await this.organizationsWithActiveFacilities()) {
      processed += await this.uow.run(({ trx }) =>
        this.restrictions.raiseUnreleasedAtEndExceptions(trx, organizationId, now),
      );
    }
    return { processed, remaining: 0 };
  }

  private async organizationsWithActiveFacilities(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('facilities')
      .select('organization_id')
      .distinct()
      .where('status', '=', 'active')
      .orderBy('organization_id')
      .execute();
    return rows.map((r) => r.organization_id);
  }
}
