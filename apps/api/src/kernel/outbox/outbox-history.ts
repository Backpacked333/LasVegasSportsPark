import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { executorFor } from '../database/transaction-context';
import type { Trx } from '../database/unit-of-work';
import { DATABASE } from '../tokens';

export interface OutboxHistoryCursor {
  occurredAt: string;
  id: string;
}

export interface OutboxHistoryQuery {
  organizationId: string;
  eventTypes: readonly string[];
  /** Exclusive keyset position: events after (occurredAt, id). */
  after: OutboxHistoryCursor | null;
  /** Inclusive upper bound on occurredAt. */
  until?: Date | string;
  /** 1..500. */
  limit: number;
}

/**
 * Replay reads of committed events (K-07, IF-27; §4.12 "events are durable facts consumers may
 * replay"): one organization's events of the given types, whatever their dispatch status, in
 * (occurred_at, id) order with a keyset cursor (index `outbox_events_history_idx`, migration
 * 0008). Never another organization's events; only committed events are visible to a reader
 * outside the producing transaction.
 */
@Injectable()
export class OutboxHistory {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async page(
    query: OutboxHistoryQuery,
    executor?: Db | Trx,
  ): Promise<{ items: DomainEvent[]; next: OutboxHistoryCursor | null }> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
      throw new Error(`OutboxHistory.page limit must be 1..500 (got ${query.limit})`);
    }
    if (query.eventTypes.length === 0) return { items: [], next: null };
    let q = (executor ?? executorFor(this.db))
      .selectFrom('outbox_events')
      .select([
        'id',
        'organization_id',
        'event_type',
        'aggregate_type',
        'aggregate_id',
        'payload',
        'occurred_at',
        'correlation_id',
        'causation_id',
        'operation_id',
      ])
      .where('organization_id', '=', query.organizationId)
      .where('event_type', 'in', [...query.eventTypes]);
    const after = query.after;
    if (after) {
      const at = new Date(after.occurredAt);
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '>', at),
          eb.and([eb('occurred_at', '=', at), eb('id', '>', after.id)]),
        ]),
      );
    }
    if (query.until !== undefined) q = q.where('occurred_at', '<=', new Date(query.until));
    const rows = await q
      .orderBy('occurred_at')
      .orderBy('id')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const items: DomainEvent[] = page.map((row) => ({
      id: row.id,
      type: row.event_type,
      organizationId: row.organization_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      occurredAt: new Date(row.occurred_at).toISOString(),
      payload: row.payload,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      operationId: row.operation_id,
    }));
    const last = items[items.length - 1];
    return {
      items,
      next: rows.length > query.limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    };
  }
}
