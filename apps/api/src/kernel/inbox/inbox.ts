import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxEventMachine, newId, type InboxEventState } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { runWithTransaction } from '../database/transaction-context';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { INBOX_DEAD_LETTER_CATEGORY, resolveReplayedDeadLetter } from '../outbox/dead-letters';
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
 *
 * Only authenticated events reach handlers (§4.11 "authenticate provider events"): an event
 * recorded with `signatureVerified: false` (kept for forensics) is marked `ignored` and never
 * applied as if it were authentic.
 *
 * R3-OPERATIONS-01 (§4.7 invariant 12, §5.8): an event records the handlers the recording build
 * registers for its provider (`expected_handlers`, consumption names `inbox:<provider>:<name>`),
 * and it is processed only once each has run here or is `retire`d; a build that lacks one (a
 * rollback, a rolling deploy) runs the handlers it has and leaves the event, uncounted, for a build
 * that has the rest, retried after OUTBOX_MISSING_HANDLER_RETRY_SECONDS.
 */
@Injectable()
export class Inbox {
  private readonly logger = new Logger(Inbox.name);
  private readonly handlers = new Map<string, Array<{ name: string; handler: InboxHandler }>>();
  private readonly retired = new Map<string, Set<string>>();

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
    if (this.retired.get(provider)?.has(name)) {
      throw new Error(`inbox handler ${name} is retired for ${provider}; use a new name`);
    }
    list.push({ name, handler });
    this.handlers.set(provider, list);
  }

  /**
   * Declares that inbox handler `name` no longer exists for `provider` (R3-OPERATIONS-01): events
   * recorded while it existed are processed without it. Keep it while such events may be pending.
   */
  retire(provider: string, name: string, reason: string): void {
    if ((this.handlers.get(provider) ?? []).some((h) => h.name === name)) {
      throw new Error(`inbox handler ${name} is registered for ${provider}; it cannot be retired`);
    }
    if (!reason.trim()) throw new Error(`retiring inbox handler ${name} needs a reason`);
    const names = this.retired.get(provider) ?? new Set<string>();
    names.add(name);
    this.retired.set(provider, names);
  }

  /** The consumption names an event of this provider expects (sorted), recorded with it. */
  private expectedFor(provider: string): string[] {
    return (this.handlers.get(provider) ?? []).map((h) => consumptionName(provider, h.name)).sort();
  }

  /** Expected handlers this build neither registers nor retired (null expectations: none). */
  private missingFor(provider: string, expected: readonly string[] | null): string[] {
    if (!expected || expected.length === 0) return [];
    const known = new Set(this.expectedFor(provider));
    for (const name of this.retired.get(provider) ?? []) known.add(consumptionName(provider, name));
    return expected.filter((name) => !known.has(name));
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
        expected_handlers: this.expectedFor(input.provider),
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

  /**
   * Processes received/failed events whose retry time has come. Safe to call concurrently.
   * `shouldStop` (the worker stopping, R3-OPERATIONS-10): once it answers true, the event in hand
   * finishes, the rest of the claimed batch is handed back (lease cleared) and nothing more is
   * claimed.
   */
  async runOnce(
    limit = this.config.OUTBOX_BATCH_SIZE,
    options: { shouldStop?: () => boolean } = {},
  ): Promise<{
    processed: number;
    failed: number;
    dead: number;
    ignored: number;
    deferred: number;
    released: number;
  }> {
    const summary = { processed: 0, failed: 0, dead: 0, ignored: 0, deferred: 0, released: 0 };
    const shouldStop = options.shouldStop ?? (() => false);
    if (shouldStop()) return summary;
    // A token per claim, so overlapping runs in one process are told apart as well.
    const lease = `${this.config.WORKER_ID}:${newId()}`;
    const rows = await this.claim(limit, lease);
    for (const [index, row] of rows.entries()) {
      if (shouldStop()) {
        summary.released = await this.release(
          rows.slice(index).map((r) => r.id),
          lease,
        );
        break;
      }
      if (!row.signature_verified) {
        // §4.11: an unauthenticated provider event is never applied; it stays on record, ignored.
        const ignored = await this.db
          .updateTable('inbox_events')
          .set({
            status: InboxEventMachine.next(row.status, 'ignore'),
            processed_at: this.clock.now(),
            last_error: 'signature not verified; the event was not applied',
            locked_by: null,
            locked_until: null,
          })
          .where('id', '=', row.id)
          .where('locked_by', '=', lease)
          .executeTakeFirst();
        if (Number(ignored.numUpdatedRows) > 0) {
          this.logger.warn(
            `inbox event ${row.id} (${row.provider}/${row.provider_event_id}) ignored: signature not verified`,
          );
          summary.ignored += 1;
        }
        continue;
      }
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
        const handlerName = consumptionName(row.provider, name);
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
      const missing = this.missingFor(row.provider, row.expected_handlers);
      if (failures.length === 0 && missing.length > 0) {
        // R3-OPERATIONS-01: wait, uncounted, for a build that registers the missing handlers.
        const waiting = `waiting for handler(s) ${missing.join(', ')}: the build that recorded this event registers them and build ${this.config.APP_VERSION} (worker ${this.config.WORKER_ID}) does not`;
        const updated = await this.db
          .updateTable('inbox_events')
          .set({
            last_error: waiting.slice(0, 4000),
            available_at: new Date(
              now.getTime() + this.config.OUTBOX_MISSING_HANDLER_RETRY_SECONDS * 1000,
            ),
            locked_by: null,
            locked_until: null,
          })
          .where('id', '=', row.id)
          .where('locked_by', '=', lease)
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) > 0) {
          this.logger.warn(`inbox event ${row.id} (${row.provider}) left waiting: ${waiting}`);
          summary.deferred += 1;
        }
      } else if (failures.length === 0) {
        const settle = async (executor: Db) => {
          const updated = await executor
            .updateTable('inbox_events')
            .set({
              status: InboxEventMachine.next(row.status, 'process'),
              processed_at: now,
              attempts: attempt,
              last_error: null,
              locked_by: null,
              locked_until: null,
            })
            .where('id', '=', row.id)
            .where('locked_by', '=', lease)
            .executeTakeFirst();
          return Number(updated.numUpdatedRows) > 0;
        };
        const organizationId = row.organization_id;
        const settled =
          row.replayed_at && organizationId
            ? // R3-OPERATIONS-03: a replayed dead letter's exception is resolved with the outcome.
              await this.db.transaction().execute(async (trx) => {
                if (!(await settle(trx))) return false;
                await resolveReplayedDeadLetter(trx, this.exceptions, {
                  organizationId,
                  source: 'inbox',
                  eventId: row.id,
                  actorLabel: 'kernel.inbox',
                });
                return true;
              })
            : await settle(this.db);
        if (settled) summary.processed += 1;
      } else if (attempt >= row.max_attempts) {
        const lastError = failures.join(' | ').slice(0, 4000);
        const deadLettered = await this.db.transaction().execute(async (trx) => {
          const updated = await trx
            .updateTable('inbox_events')
            .set({
              status: InboxEventMachine.next(row.status, 'dead_letter'),
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
              category: INBOX_DEAD_LETTER_CATEGORY,
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
            status: InboxEventMachine.next(row.status, 'fail'),
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

  /** Hands claimed, unprocessed events back (lease cleared) so another worker takes them now. */
  private async release(ids: string[], lease: string): Promise<number> {
    if (ids.length === 0) return 0;
    const released = await this.db
      .updateTable('inbox_events')
      .set({ locked_by: null, locked_until: null })
      .where('id', 'in', ids)
      .where('status', 'in', ['received', 'failed'])
      .where('locked_by', '=', lease)
      .executeTakeFirst();
    return Number(released.numUpdatedRows);
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
                  i.signature_verified, i.received_at, i.attempts, i.max_attempts, i.expected_handlers,
                  i.status, i.replayed_at
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
  expected_handlers: string[] | null;
  /** `received` or `failed`: the states a claim selects. */
  status: Extract<InboxEventState, 'received' | 'failed'>;
  replayed_at: Date | string | null;
}

/** The consumption name of an inbox handler (event_consumptions.handler). */
function consumptionName(provider: string, name: string): string {
  return `inbox:${provider}:${name}`;
}
