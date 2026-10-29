import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  DATABASE,
  MODULE_SETTINGS,
  PeriodicJobRegistry,
  UnitOfWork,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import type { EnrollmentSettingsValue } from '../enrollment.settings';
import { ASSIGN_PLACEMENT_KIND, PlacementService } from './placement.service';

export const RECONCILE_PLACEMENTS_JOB = 'enrollment.reconcile_placements';

/**
 * Enrollment's periodic jobs (K-06, IF-24; §4.12 durable, interruption-tolerant background work
 * with a failure owner). Each job selects due rows, then changes each in its own small
 * transaction under `systemPrincipal(organization, '<job>')` with audit and outbox; a row another
 * runner holds is skipped and found on the next run. No job calls a provider.
 *
 * - enrollment.reconcile_placements (ENR-08, SPK-AT-023): placement assignments whose operation is
 *   still `running` longer than ENROLLMENT_PLACEMENT_RECONCILE_AFTER_SECONDS are resumed.
 */
@Injectable()
export class EnrollmentJobs implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(MODULE_SETTINGS('enrollment')) private readonly settings: EnrollmentSettingsValue,
    private readonly registry: PeriodicJobRegistry,
    private readonly uow: UnitOfWork,
    private readonly placements: PlacementService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: RECONCILE_PLACEMENTS_JOB,
      intervalSeconds: 60,
      failureOwner: 'program_manager',
      run: (context) => this.reconcilePlacements(context),
    });
  }

  async reconcilePlacements({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const before = new Date(now.getTime() - this.settings.PLACEMENT_RECONCILE_AFTER_SECONDS * 1000);
    const due = await this.db
      .selectFrom('operations')
      .select(['id', 'organization_id'])
      .where('kind', '=', ASSIGN_PLACEMENT_KIND)
      .where('status', '=', 'running')
      .where('updated_at', '<=', before)
      .orderBy('updated_at')
      .orderBy('id')
      .limit(batchSize)
      .execute();
    let processed = 0;
    for (const operation of due) {
      const outcome = await this.uow.run(({ trx }) =>
        this.placements.reconcileAssignment(
          trx,
          operation.organization_id,
          operation.id,
          systemPrincipal(operation.organization_id, RECONCILE_PLACEMENTS_JOB),
        ),
      );
      if (outcome) processed += 1;
    }
    return { processed, remaining: processed === 0 || due.length < batchSize ? 0 : 1 };
  }
}
