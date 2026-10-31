import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId, type DomainEvent } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { runWithTransaction } from '../database/transaction-context';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';
import {
  EventHandlerRegistry,
  runAfterCommitHooks,
  type RegisteredHandler,
} from './event-handler.registry';

export interface DispatchSummary {
  claimed: number;
  dispatched: number;
  retried: number;
  dead: number;
  /** Claimed events whose lease lapsed and another worker took over; this run recorded nothing. */
  superseded: number;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10 * 60_000);
}

/**
 * Durable worker for outbox events (§4.12). Claims pending events with a lock lease
 * (FOR UPDATE SKIP LOCKED), runs each registered handler in its own transaction together with its
 * consumption record (exactly one business effect per handler per event), retries with backoff,
 * and dead-letters to an operational exception with a failure owner after max attempts.
 * Tolerates interruption: an expired lease makes the event claimable again (SPK-AT-023).
 *
 * Each claim carries its own lease token. A run renews an event's lease before handling it and
 * skips it when another worker has taken it over, and every status write is fenced on the token,
 * so a slow run whose lease lapsed can never overwrite the outcome (dispatched, attempts, dead
 * letter) recorded by the worker that owns the event now.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: EventHandlerRegistry,
    private readonly exceptions: OperationalExceptions,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        let summary = await this.runOnce();
        while (summary.claimed > 0) summary = await this.runOnce();
      } catch (error) {
        this.logger.error(`dispatch loop failed: ${String(error)}`);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), this.config.OUTBOX_POLL_INTERVAL_MS);
    void tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Processes one batch; returns counts. Safe to call concurrently from several workers. */
  async runOnce(batchSize: number = this.config.OUTBOX_BATCH_SIZE): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      claimed: 0,
      dispatched: 0,
      retried: 0,
      dead: 0,
      superseded: 0,
    };
    // A token per claim, so overlapping runs (also in one process) are told apart.
    const lease = `${this.config.WORKER_ID}:${newId()}`;
    const events = await this.claim(batchSize, lease);
    summary.claimed = events.length;
    for (const row of events) {
      const outcome = (await this.renewLease(row.id, lease))
        ? await this.process(row, lease)
        : 'superseded';
      summary[outcome] += 1;
    }
    return summary;
  }

  /** Extends this run's lease on one event; false when another worker owns the event now. */
  private async renewLease(id: string, lease: string): Promise<boolean> {
    const leaseUntil = new Date(
      this.clock.now().getTime() + this.config.OUTBOX_LOCK_LEASE_SECONDS * 1000,
    );
    const renewed = await this.db
      .updateTable('outbox_events')
      .set({ locked_until: leaseUntil })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('locked_by', '=', lease)
      .executeTakeFirst();
    return Number(renewed.numUpdatedRows) > 0;
  }

  private async claim(limit: number, lease: string) {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.config.OUTBOX_LOCK_LEASE_SECONDS * 1000);
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<ClaimedRow>`
        with claimed as (
          select id from outbox_events
          where status = 'pending'
            and available_at <= ${now}
            and (locked_until is null or locked_until < ${now})
          order by available_at, occurred_at
          limit ${limit}
          for update skip locked
        )
        update outbox_events o
        set locked_by = ${lease}, locked_until = ${leaseUntil}
        from claimed
        where o.id = claimed.id
        returning o.id, o.organization_id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload,
                  o.occurred_at, o.correlation_id, o.causation_id, o.operation_id, o.attempts, o.max_attempts,
                  o.failure_owner
      `.execute(trx);
      return result.rows;
    });
  }

  private async process(
    row: ClaimedRow,
    lease: string,
  ): Promise<'dispatched' | 'retried' | 'dead' | 'superseded'> {
    const event: DomainEvent = {
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
    };
    const attempt = row.attempts + 1;
    const handlers = this.registry.handlersFor(event.type);
    const failures: string[] = [];
    const failing: RegisteredHandler[] = [];
    for (const handler of handlers) {
      const error = await this.runHandler(event, handler, attempt);
      if (error) {
        failures.push(`${handler.name}: ${error}`);
        failing.push(handler);
      }
    }

    const now = this.clock.now();
    if (failures.length === 0) {
      const updated = await this.db
        .updateTable('outbox_events')
        .set({
          status: 'dispatched',
          dispatched_at: now,
          attempts: attempt,
          locked_by: null,
          locked_until: null,
          last_error: null,
        })
        .where('id', '=', row.id)
        .where('locked_by', '=', lease)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0 ? 'dispatched' : 'superseded';
    }
    const lastError = failures.join(' | ').slice(0, 4000);
    if (attempt >= row.max_attempts) {
      // §4.12, SPK-UX-006: the module whose handler failed owns the follow-up; then the
      // producer's owner; system administration only when neither declared one.
      const owner =
        failing.find((h) => h.failureOwner)?.failureOwner ??
        row.failure_owner ??
        'system_administrator';
      const deadLettered = await this.db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('outbox_events')
          .set({
            status: 'dead',
            attempts: attempt,
            last_error: lastError,
            locked_by: null,
            locked_until: null,
            failure_owner: owner,
          })
          .where('id', '=', row.id)
          .where('locked_by', '=', lease)
          .executeTakeFirst();
        // A run whose lease lapsed (another worker owns the event now) records nothing.
        if (Number(updated.numUpdatedRows) === 0) return false;
        await this.exceptions.raise(trx, {
          organizationId: row.organization_id,
          category: 'reliability.outbox_dead_letter',
          severity: 'high',
          title: `Follow-up for ${event.type} could not be delivered after ${attempt} attempts`,
          affectedType: row.aggregate_type,
          affectedId: row.aggregate_id,
          ownerQueue: owner,
          dedupeKey: `outbox:${row.id}`,
          details: {
            eventId: row.id,
            eventType: event.type,
            failingHandlers: failing.map((h) => ({
              handler: h.name,
              failureOwner: h.failureOwner ?? null,
            })),
            lastError,
            correlationId: row.correlation_id,
          },
        });
        return true;
      });
      if (!deadLettered) return 'superseded';
      this.logger.error(`event ${row.id} (${event.type}) dead-lettered: ${lastError}`);
      return 'dead';
    }
    const updated = await this.db
      .updateTable('outbox_events')
      .set({
        attempts: attempt,
        last_error: lastError,
        available_at: new Date(now.getTime() + retryDelayMs(attempt)),
        locked_by: null,
        locked_until: null,
      })
      .where('id', '=', row.id)
      .where('locked_by', '=', lease)
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) > 0 ? 'retried' : 'superseded';
  }

  private async runHandler(
    event: DomainEvent,
    handler: RegisteredHandler,
    attempt: number,
  ): Promise<string | null> {
    const attemptId = newId();
    await this.db
      .insertInto('job_attempts')
      .values({
        id: attemptId,
        organization_id: event.organizationId,
        source: 'outbox',
        source_id: event.id,
        handler: handler.name,
        attempt_number: attempt,
        worker_id: this.config.WORKER_ID,
        started_at: this.clock.now(),
        finished_at: null,
        outcome: null,
        error: null,
        correlation_id: event.correlationId,
      })
      .execute();
    let outcome: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let errorText: string | null = null;
    const hooks: Array<() => void | Promise<void>> = [];
    try {
      const ran = await this.db.transaction().execute(async (trx) => {
        const consumed = await trx
          .insertInto('event_consumptions')
          .values({ handler: handler.name, event_id: event.id })
          .onConflict((oc) => oc.columns(['handler', 'event_id']).doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (!consumed) return false;
        // The handler runs in the transaction context, so ports read through its transaction and
        // a command it calls joins it (UnitOfWork.run), deferring its hooks to this commit.
        const afterCommit = (hook: () => void | Promise<void>) => {
          hooks.push(hook);
        };
        await runWithTransaction(trx, () => handler.handler(event, { trx, attempt, afterCommit }), {
          afterCommit,
        });
        return true;
      });
      if (!ran) outcome = 'skipped';
      else
        await runAfterCommitHooks(hooks, (error) =>
          this.logger.warn(`after-commit hook of ${handler.name} failed: ${String(error)}`),
        );
    } catch (error) {
      outcome = 'failed';
      errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await this.db
      .updateTable('job_attempts')
      .set({ finished_at: this.clock.now(), outcome, error: errorText })
      .where('id', '=', attemptId)
      .execute();
    return errorText;
  }
}

interface ClaimedRow {
  id: string;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  occurred_at: Date | string;
  correlation_id: string | null;
  causation_id: string | null;
  operation_id: string | null;
  attempts: number;
  max_attempts: number;
  failure_owner: string | null;
}
