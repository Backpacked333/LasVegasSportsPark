import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { runWithTransaction } from '../database/transaction-context';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { runAfterCommitHooks, type HandlerContext } from '../outbox/event-handler.registry';
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

export type InboxHandler = (event: InboundEvent, context: HandlerContext) => Promise<void>;

/** Who owns a dead-lettered inbox event (§4.12 failure owner). */
const INBOX_FAILURE_OWNER = 'system_administrator';

/**
 * Inbox for external provider events (webhooks). `record` is idempotent on (provider, event id);
 * handlers run under the same at-most-once-per-handler consumption rule as the outbox, so
 * duplicate and reordered deliveries cannot create duplicate financial effects (§4.11, §4.12).
 * Like the outbox, events are claimed with a lease (so concurrent workers never process one event
 * at the same time), failures are retried with backoff, and an event that keeps failing is
 * dead-lettered with a failure owner after `max_attempts`.
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
        available_at: this.clock.now(),
        last_error: null,
        processed_at: null,
        failure_owner: null,
        locked_by: null,
        locked_until: null,
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

  /** Processes received/failed events whose retry time has come. Safe to call concurrently. */
  async runOnce(
    limit = this.config.OUTBOX_BATCH_SIZE,
  ): Promise<{ processed: number; failed: number; dead: number }> {
    // A token per claim, so overlapping runs in one process are told apart as well.
    const lease = `${this.config.WORKER_ID}:${newId()}`;
    const rows = await this.claim(limit, lease);
    const summary = { processed: 0, failed: 0, dead: 0 };
    for (const row of rows) {
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
        const hooks: Array<() => void | Promise<void>> = [];
        try {
          const ran = await this.db.transaction().execute(async (trx) => {
            const consumed = await trx
              .insertInto('event_consumptions')
              .values({ handler: handlerName, event_id: event.id })
              .onConflict((oc) => oc.columns(['handler', 'event_id']).doNothing())
              .returning('event_id')
              .executeTakeFirst();
            if (!consumed) return false;
            // The handler runs in the transaction context, so ports read through its transaction
            // and a command it calls joins it (UnitOfWork.run), deferring its hooks to this commit.
            const afterCommit = (hook: () => void | Promise<void>) => {
              hooks.push(hook);
            };
            await runWithTransaction(trx, () => handler(event, { trx, attempt, afterCommit }), {
              afterCommit,
            });
            return true;
          });
          if (ran) {
            await runAfterCommitHooks(hooks, (error) =>
              this.logger.warn(`after-commit hook of ${handlerName} failed: ${String(error)}`),
            );
          }
        } catch (error) {
          failures.push(
            `${handlerName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const now = this.clock.now();
      if (failures.length === 0) {
        const updated = await this.db
          .updateTable('inbox_events')
          .set({
            status: 'processed',
            processed_at: now,
            attempts: attempt,
            last_error: null,
            locked_by: null,
            locked_until: null,
          })
          .where('id', '=', row.id)
          .where('locked_by', '=', lease)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) > 0) summary.processed += 1;
      } else if (attempt >= row.max_attempts) {
        const lastError = failures.join(' | ').slice(0, 4000);
        const deadLettered = await this.db.transaction().execute(async (trx) => {
          const updated = await trx
            .updateTable('inbox_events')
            .set({
              status: 'dead',
              attempts: attempt,
              last_error: lastError,
              failure_owner: INBOX_FAILURE_OWNER,
              locked_by: null,
              locked_until: null,
            })
            .where('id', '=', row.id)
            .where('locked_by', '=', lease)
            .executeTakeFirst();
          // A runner whose lease lapsed (another runner owns the event now) records nothing.
          if (Number(updated.numUpdatedRows) === 0) return false;
          if (row.organization_id) {
            await this.exceptions.raise(trx, {
              organizationId: row.organization_id,
              category: 'reliability.inbox_dead_letter',
              severity: 'high',
              title: `Provider event ${row.provider}/${row.event_type} could not be processed`,
              affectedType: 'inbox_event',
              affectedId: row.id,
              ownerQueue: INBOX_FAILURE_OWNER,
              dedupeKey: `inbox:${row.id}`,
              details: { failures },
            });
          }
          return true;
        });
        if (deadLettered) {
          // An event without an organization cannot open an organization's exception; its owner
          // is recorded on the row and the failure is logged for the platform operator.
          this.logger.error(
            `inbox event ${row.id} (${row.provider}/${row.provider_event_id}) dead-lettered after ${attempt} attempts; owner ${INBOX_FAILURE_OWNER}${row.organization_id ? '' : ' (no organization)'}: ${lastError}`,
          );
          summary.dead += 1;
        }
      } else {
        const updated = await this.db
          .updateTable('inbox_events')
          .set({
            status: 'failed',
            attempts: attempt,
            last_error: failures.join(' | ').slice(0, 4000),
            available_at: new Date(now.getTime() + retryDelayMs(attempt)),
            locked_by: null,
            locked_until: null,
          })
          .where('id', '=', row.id)
          .where('locked_by', '=', lease)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) > 0) summary.failed += 1;
      }
    }
    return summary;
  }

  /** Claims due events with a lease, mirroring the outbox dispatcher (§4.12). */
  private async claim(limit: number, lease: string): Promise<InboxRow[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.config.OUTBOX_LOCK_LEASE_SECONDS * 1000);
    const rows = await this.db.transaction().execute(async (trx) => {
      const result = await sql<InboxRow>`
        with claimed as (
          select id from inbox_events
          where status in ('received', 'failed')
            and available_at <= ${now}
            and (locked_until is null or locked_until < ${now})
          order by received_at
          limit ${limit}
          for update skip locked
        )
        update inbox_events i
        set locked_by = ${lease}, locked_until = ${leaseUntil}
        from claimed
        where i.id = claimed.id
        returning i.id, i.provider, i.provider_event_id, i.organization_id, i.event_type, i.payload,
                  i.signature_verified, i.received_at, i.attempts, i.max_attempts
      `.execute(trx);
      return result.rows;
    });
    // UPDATE ... RETURNING does not keep the claim order: restore provider arrival order.
    return rows.sort(
      (a, b) =>
        new Date(a.received_at).getTime() - new Date(b.received_at).getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
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
  max_attempts: number;
}
