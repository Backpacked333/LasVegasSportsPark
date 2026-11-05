import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import {
  CLOCK,
  DATABASE,
  OutboxHistory,
  UnitOfWork,
  type Clock,
  type HandlerContext,
  type Trx,
} from '../../../kernel';
import { INDEXED_EVENT_TYPES, TimelineIndexer } from './timeline-indexer.service';

/** SUP-03: the periodic job that replays the outbox history into the timeline index. */
export const BACKFILL_TIMELINE_JOB = 'support.backfill_timeline';

/**
 * Timeline backfill (SUP-03; SPK-SUPPORT-001, §4.12 "events are durable facts consumers may
 * replay", SPK-AT-023). The live handlers index each event once it is dispatched; events committed
 * before support indexed them (before the module was deployed, or while its handler was
 * dead-lettered) are replayed here from the kernel's outbox history (`OutboxHistory.page`, IF-27):
 * for every organization whose cursor is unfinished, the next events of the indexed types after
 * the cursor are indexed exactly as the live handlers would, each in its own transaction that
 * also advances the cursor. The source-event key of `timeline_references` makes re-indexing an
 * event the live handler already indexed a no-op, so the replay is safe to repeat. When a page
 * comes back empty the organization's backfill is complete.
 *
 * Records created by fixtures or imports that emit no events are not indexed by either path.
 */
@Injectable()
export class TimelineBackfillService {
  private readonly logger = new Logger(TimelineBackfillService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly history: OutboxHistory,
    private readonly indexer: TimelineIndexer,
  ) {}

  /**
   * Requests a replay of the organization's history (migration 1103 requests one for every
   * organization that existed when it ran). `restart` replays from the first event again, for
   * example after an import committed events the index missed; otherwise an existing cursor
   * continues where it stopped.
   */
  async request(organizationId: string, options: { restart?: boolean } = {}, trx?: Trx) {
    const db = trx ?? this.uow.reader();
    const now = this.clock.now();
    await db
      .insertInto('support_timeline_backfill_cursors')
      .values({ organization_id: organizationId, requested_at: now, updated_at: now })
      .onConflict((oc) =>
        oc.column('organization_id').doUpdateSet(
          options.restart
            ? {
                last_occurred_at: null,
                last_event_id: null,
                completed_at: null,
                requested_at: now,
              }
            : { completed_at: null, requested_at: now },
        ),
      )
      .execute();
  }

  /** One pass of `support.backfill_timeline`: up to `batchSize` events across organizations. */
  async run(context: { now: Date; batchSize: number }): Promise<{
    processed: number;
    remaining: number;
  }> {
    const open = await this.db
      .selectFrom('support_timeline_backfill_cursors')
      .select(['organization_id', 'last_occurred_at', 'last_event_id'])
      .where('completed_at', 'is', null)
      .orderBy('organization_id')
      .execute();
    let processed = 0;
    let budget = context.batchSize;
    for (const cursor of open) {
      if (budget <= 0) break;
      const after =
        cursor.last_occurred_at && cursor.last_event_id
          ? {
              occurredAt: new Date(cursor.last_occurred_at).toISOString(),
              id: cursor.last_event_id,
            }
          : null;
      const page = await this.history.page({
        organizationId: cursor.organization_id,
        eventTypes: INDEXED_EVENT_TYPES,
        after,
        // Events committed after this pass started are the live handlers' (and the next pass's).
        until: context.now,
        limit: budget,
      });
      let position = after;
      for (const event of page.items) {
        const advanced = await this.uow.run(async ({ trx }) => {
          // The cursor row is the replay's lock: a second runner waits, then sees it moved on.
          const locked = await trx
            .selectFrom('support_timeline_backfill_cursors')
            .select(['last_occurred_at', 'last_event_id', 'completed_at'])
            .where('organization_id', '=', cursor.organization_id)
            .forUpdate()
            .executeTakeFirst();
          if (!locked || locked.completed_at) return false;
          if (!samePosition(locked, position)) return false;
          const ctx: HandlerContext = { trx, attempt: 1, afterCommit: () => undefined };
          await this.indexer.index(event, ctx);
          await trx
            .updateTable('support_timeline_backfill_cursors')
            .set({
              last_occurred_at: new Date(event.occurredAt),
              last_event_id: event.id,
              updated_at: this.clock.now(),
            })
            .where('organization_id', '=', cursor.organization_id)
            .execute();
          return true;
        });
        if (!advanced) break;
        position = { occurredAt: event.occurredAt, id: event.id };
        processed += 1;
        budget -= 1;
      }
      if (page.items.length === 0) {
        await this.complete(cursor.organization_id, position);
        this.logger.log(`timeline backfill complete for organization ${cursor.organization_id}`);
      }
    }
    const remaining = await this.db
      .selectFrom('support_timeline_backfill_cursors')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('completed_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { processed, remaining: Number(remaining.n) };
  }

  private async complete(
    organizationId: string,
    position: { occurredAt: string; id: string } | null,
  ): Promise<void> {
    await this.uow.run(async ({ trx }) => {
      const locked = await trx
        .selectFrom('support_timeline_backfill_cursors')
        .select(['last_occurred_at', 'last_event_id', 'completed_at'])
        .where('organization_id', '=', organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.completed_at || !samePosition(locked, position)) return;
      const now = this.clock.now();
      await trx
        .updateTable('support_timeline_backfill_cursors')
        .set({ completed_at: now, updated_at: now })
        .where('organization_id', '=', organizationId)
        .execute();
    });
  }
}

function samePosition(
  row: { last_occurred_at: Date | string | null; last_event_id: string | null },
  position: { occurredAt: string; id: string } | null,
): boolean {
  if (!position) return row.last_event_id === null;
  return (
    row.last_event_id === position.id &&
    row.last_occurred_at !== null &&
    new Date(row.last_occurred_at).getTime() === new Date(position.occurredAt).getTime()
  );
}
