import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MODULE_SETTINGS, PeriodicJobRegistry } from '../../../kernel';
import type { SupportSettingsValue } from '../support.settings';
import { CaseActionsService, SETTLE_STALE_CASE_ACTIONS_JOB } from './case-actions.service';
import { BACKFILL_TIMELINE_JOB, TimelineBackfillService } from './timeline-backfill.service';

/**
 * Support's periodic jobs (K-06 contract, §4.12 durable background work with a failure owner:
 * idempotent, one small transaction per row, no provider call). A repeatedly failing run is owned
 * by the support operator queue.
 *
 * - `support.backfill_timeline` (SUP-03, every 300 s): replays unfinished organizations' outbox
 *   history into the timeline index (TimelineBackfillService).
 * - `support.settle_stale_case_actions` (SUP-04, every 300 s): helper requests still `requested`
 *   `SUPPORT_STALE_ACTION_SECONDS` after their intent get the owning module's outcome recorded, or
 *   one `support.case_action_stale` exception (CaseActionsService.settleStale).
 */
@Injectable()
export class SupportJobs implements OnModuleInit {
  constructor(
    private readonly registry: PeriodicJobRegistry,
    private readonly backfill: TimelineBackfillService,
    private readonly actions: CaseActionsService,
    @Inject(MODULE_SETTINGS('support')) private readonly settings: SupportSettingsValue,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: BACKFILL_TIMELINE_JOB,
      intervalSeconds: 300,
      failureOwner: 'support_operator',
      batchSize: 200,
      run: (context) => this.backfill.run(context),
    });
    this.registry.register({
      name: SETTLE_STALE_CASE_ACTIONS_JOB,
      intervalSeconds: 300,
      failureOwner: 'support_operator',
      run: (context) =>
        this.actions.settleStale({
          ...context,
          staleSeconds: this.settings.STALE_ACTION_SECONDS,
        }),
    });
  }
}
