import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import type { Trx } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { retryDelayMs } from '../outbox/outbox-dispatcher';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';

export interface InboundEvent {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: unknown;
  organizationId: string | null;
  signatureVerified: boolean;
  receivedAt: Date;
}

export type InboxHandler = (
  event: InboundEvent,
  context: { trx: Trx; attempt: number },
) => Promise<void>;

/**
 * Inbox for external provider events (webhooks). `record` is idempotent on (provider, event id);
 * handlers run under the same at-most-once-per-handler consumption rule as the outbox, so
 * duplicate and reordered deliveries cannot create duplicate financial effects (§4.11, §4.12).
 */
@Injectable()
export class Inbox {
  private readonly logger = new Logger(Inbox.name);
  private readonly handlers = new Map<string, Array<{ name: string; handler: InboxHandler }>>();

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly exceptions: OperationalExceptions,
  ) {}

  on(provider: string, name: string, handler: InboxHandler): void {
    const list = this.handlers.get(provider) ?? [];
    if (list.some((h) => h.name === name))
      throw new Error(`inbox handler ${name} already registered for ${provider}`);
    list.push({ name, handler });
    this.handlers.set(provider, list);
  }

  /** Durably records a provider event. Returns `duplicate: true` when it was already recorded. */
  async record(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: unknown;
    organizationId?: string | null;
    signatureVerified: boolean;
  }): Promise<{ id: string; duplicate: boolean }> {
    const id = newId();
    const inserted = await this.db
      .insertInto('inbox_events')
      .values({
        id,
        provider: input.provider,
        provider_event_id: input.providerEventId,
        organization_id: input.organizationId ?? null,
        event_type: input.eventType,
        payload: json(input.payload as object),
        signature_verified: input.signatureVerified,
        received_at: this.clock.now(),
        last_error: null,
        processed_at: null,
      })
      .onConflict((oc) => oc.columns(['provider', 'provider_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) return { id, duplicate: false };
    const existing = await this.db
      .selectFrom('inbox_events')
      .select('id')
      .where('provider', '=', input.provider)
      .where('provider_event_id', '=', input.providerEventId)
      .executeTakeFirstOrThrow();
    return { id: existing.id, duplicate: true };
  }

  /** Processes received/failed events whose retry time has come. */
  async runOnce(
    limit = this.config.OUTBOX_BATCH_SIZE,
  ): Promise<{ processed: number; failed: number; dead: number }> {
    const rows = await sql<InboxRow>`
      select id, provider, provider_event_id, organization_id, event_type, payload, signature_verified, received_at, attempts
      from inbox_events
      where status in ('received', 'failed')
      order by received_at
      limit ${limit}
      for update skip locked
    `.execute(this.db);
    const summary = { processed: 0, failed: 0, dead: 0 };
    for (const row of rows.rows) {
      const event: InboundEvent = {
        id: row.id,
        provider: row.provider,
        providerEventId: row.provider_event_id,
        eventType: row.event_type,
        payload: row.payload,
        organizationId: row.organization_id,
        signatureVerified: row.signature_verified,
        receivedAt: new Date(row.received_at),
      };
      const attempt = row.attempts + 1;
      const failures: string[] = [];
      for (const { name, handler } of this.handlers.get(row.provider) ?? []) {
        const handlerName = `inbox:${row.provider}:${name}`;
        try {
          await this.db.transaction().execute(async (trx) => {
            const consumed = await trx
              .insertInto('event_consumptions')
              .values({ handler: handlerName, event_id: event.id })
              .onConflict((oc) => oc.columns(['handler', 'event_id']).doNothing())
              .returning('event_id')
              .executeTakeFirst();
            if (!consumed) return;
            await handler(event, { trx, attempt });
          });
        } catch (error) {
          failures.push(
            `${handlerName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (failures.length === 0) {
        await this.db
          .updateTable('inbox_events')
          .set({
            status: 'processed',
            processed_at: this.clock.now(),
            attempts: attempt,
            last_error: null,
          })
          .where('id', '=', row.id)
          .execute();
        summary.processed += 1;
      } else if (attempt >= 10) {
        await this.db.transaction().execute(async (trx) => {
          await trx
            .updateTable('inbox_events')
            .set({
              status: 'dead',
              attempts: attempt,
              last_error: failures.join(' | ').slice(0, 4000),
            })
            .where('id', '=', row.id)
            .execute();
          if (row.organization_id) {
            await this.exceptions.raise(trx, {
              organizationId: row.organization_id,
              category: 'reliability.inbox_dead_letter',
              severity: 'high',
              title: `Provider event ${row.provider}/${row.event_type} could not be processed`,
              affectedType: 'inbox_event',
              affectedId: row.id,
              ownerQueue: 'system_administrator',
              dedupeKey: `inbox:${row.id}`,
              details: { failures },
            });
          }
        });
        this.logger.error(`inbox event ${row.id} dead-lettered`);
        summary.dead += 1;
      } else {
        // retry after backoff: received_at ordering keeps it queued; attempts drive status
        await this.db
          .updateTable('inbox_events')
          .set({
            status: 'failed',
            attempts: attempt,
            last_error: failures.join(' | ').slice(0, 4000),
          })
          .where('id', '=', row.id)
          .execute();
        summary.failed += 1;
        await new Promise((r) => setTimeout(r, Math.min(retryDelayMs(attempt), 50)));
      }
    }
    return summary;
  }
}

interface InboxRow {
  id: string;
  provider: string;
  provider_event_id: string;
  organization_id: string | null;
  event_type: string;
  payload: unknown;
  signature_verified: boolean;
  received_at: Date | string;
  attempts: number;
}
