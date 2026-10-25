import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  z,
  type AcknowledgeExceptionInput,
  type ListExceptionsQuery,
  type OperationalException,
  type Page,
  type Principal,
  type ResolutionHistoryEntry,
  type SettleExceptionInput,
} from '@sportspark/contracts';
import type { Db, ExceptionStatus } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  ExceptionActions,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  type Clock,
  listFacilityScope,
} from '../../../kernel';
import { ExceptionTransitioned } from '../support.events';
import {
  addMinutesTo,
  actorOf,
  iso,
  isoOrNull,
  minutesBetween,
  organizationOf,
  type ExceptionQueueRow,
  type Reader,
} from '../support.shared';
import { ExceptionQueuesService } from './exception-queues.service';
import { NextActions, type ExceptionRow } from './next-actions';

const ListCursor = z.object({ openedAt: z.iso.datetime(), id: z.uuid() });
const SCAN_BATCH = 200;
const SCAN_PASSES = 25;

export interface ExceptionViewContext {
  principal: Principal;
  queues: Map<string, ExceptionQueueRow>;
  history: Map<string, ResolutionHistoryEntry[]>;
  now: Date;
}

/**
 * Operational exception workflow (§4.4 Exception, SPK-UX-006, §5.11): queue-scoped lists,
 * resolution history and the acknowledge / resolve / close lifecycle. Transitions go through the
 * kernel's `OperationalExceptions.transition`, which authorizes (`exceptions.manage`), enforces the
 * lifecycle and writes the audit record; support never touches the affected record — closing an
 * exception about a payment, booking or delivery leaves that record exactly as it is.
 *
 * The kernel offers `listOpen` only, so lists by status and single reads use the kernel table
 * `operational_exceptions` read-only (writes stay with the kernel service).
 */
@Injectable()
export class ExceptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly exceptions: OperationalExceptions,
    private readonly outbox: Outbox,
    private readonly queues: ExceptionQueuesService,
    private readonly nextActions: NextActions,
  ) {}

  async list(
    principal: Principal,
    query: ListExceptionsQuery,
  ): Promise<Page<OperationalException>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ExceptionActions.read, {
      type: 'operational_exception',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const configured = await this.queues.configured(this.db, organizationId);
    if (
      query.queue &&
      !this.queues.visibleTo(principal, this.queues.resolve(query.queue, configured))
    ) {
      throw errors.accessDenied('This queue is outside your scope.', { queue: query.queue });
    }
    const cursor = decodeCursor(query.cursor, ListCursor);
    let base = this.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('opened_at')
      .orderBy('id');
    base = query.status
      ? base.where('status', '=', query.status)
      : base.where('status', 'in', ['open', 'acknowledged']);
    if (query.queue) base = base.where('owner_queue', '=', query.queue);
    if (query.facilityId) base = base.where('facility_id', '=', query.facilityId);
    if (query.severity) base = base.where('severity', '=', query.severity);
    // Facility-scoped staff see their facilities' exceptions and organization-wide ones (§4.3),
    // through the roles that hold the read action (§4.14, identity-05).
    const scope = listFacilityScope(principal, ExceptionActions.read);
    if (scope) {
      const facilityIds = [...scope];
      base = base.where((eb) =>
        facilityIds.length > 0
          ? eb.or([eb('facility_id', 'is', null), eb('facility_id', 'in', facilityIds)])
          : eb('facility_id', 'is', null),
      );
    }
    // Queue visibility is decided per row (configured owning roles); scan in bounded batches.
    const visible: ExceptionRow[] = [];
    let after = cursor;
    let resumeAt: { openedAt: string; id: string } | null = null;
    for (let pass = 0; visible.length <= query.limit; pass += 1) {
      if (pass >= SCAN_PASSES) {
        resumeAt = after;
        break;
      }
      let page = base;
      if (after) {
        const from = after;
        page = page.where(
          sql<SqlBool>`(opened_at, id) > (${new Date(from.openedAt)}::timestamptz, ${from.id}::uuid)`,
        );
      }
      const rows = await page.limit(SCAN_BATCH).execute();
      for (const row of rows) {
        if (this.queues.visibleTo(principal, this.queues.resolve(row.owner_queue, configured))) {
          visible.push(row);
        }
      }
      const last = rows[rows.length - 1];
      if (rows.length < SCAN_BATCH || !last) break;
      after = { openedAt: iso(last.opened_at), id: last.id };
    }
    const items = visible.slice(0, query.limit);
    const lastItem = items[items.length - 1];
    const nextCursor =
      visible.length > query.limit && lastItem
        ? encodeCursor({ openedAt: iso(lastItem.opened_at), id: lastItem.id })
        : resumeAt
          ? encodeCursor(resumeAt)
          : null;
    const history = await this.history(
      this.db,
      organizationId,
      items.map((r) => r.id),
    );
    const ctx: ExceptionViewContext = {
      principal,
      queues: configured,
      history,
      now: this.clock.now(),
    };
    const views: OperationalException[] = [];
    for (const row of items) views.push(await this.view(row, ctx));
    return { items: views, nextCursor };
  }

  async get(principal: Principal, id: string): Promise<OperationalException> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.notFound('exception', id);
    return this.authorizedView(this.db, principal, row);
  }

  async acknowledge(
    principal: Principal,
    id: string,
    input: AcknowledgeExceptionInput,
    correlationId: string | null,
  ): Promise<OperationalException> {
    return this.transition(principal, id, 'acknowledged', input, correlationId);
  }

  async resolve(
    principal: Principal,
    id: string,
    input: SettleExceptionInput,
    correlationId: string | null,
  ): Promise<OperationalException> {
    return this.transition(principal, id, 'resolved', input, correlationId);
  }

  async close(
    principal: Principal,
    id: string,
    input: SettleExceptionInput,
    correlationId: string | null,
  ): Promise<OperationalException> {
    return this.transition(principal, id, 'closed', input, correlationId);
  }

  private async transition(
    principal: Principal,
    id: string,
    to: Exclude<ExceptionStatus, 'open'>,
    input: { expectedRevision?: number; reason?: string; resolution?: Record<string, unknown> },
    correlationId: string | null,
  ): Promise<OperationalException> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('operational_exceptions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      // Another organization's exception is not found, never "access denied" (§4.3).
      if (!row) throw errors.notFound('exception', id);
      const configured = await this.queues.configured(trx, organizationId);
      if (!this.queues.visibleTo(principal, this.queues.resolve(row.owner_queue, configured))) {
        throw errors.accessDenied('This exception belongs to a queue outside your scope.', {
          queue: row.owner_queue,
        });
      }
      // Kernel: `exceptions.manage` authorization (facility scope), lifecycle, revision, audit.
      await this.exceptions.transition(trx, principal, id, to, {
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        resolution: input.resolution,
        correlationId: correlationId ?? undefined,
      });
      await this.outbox.enqueue(trx, ExceptionTransitioned, {
        organizationId,
        aggregateType: 'operational_exception',
        aggregateId: id,
        payload: { exceptionId: id, from: row.status, to, ownerQueue: row.owner_queue },
        correlationId,
      });
      const after = await this.load(trx, organizationId, id);
      if (!after) throw errors.internal('exception vanished');
      return this.authorizedView(trx, principal, after);
    });
  }

  private async authorizedView(
    db: Reader,
    principal: Principal,
    row: ExceptionRow,
  ): Promise<OperationalException> {
    await this.authorization.require(principal, ExceptionActions.read, {
      type: 'operational_exception',
      id: row.id,
      organizationId: row.organization_id,
      facilityId: row.facility_id,
    });
    const configured = await this.queues.configured(db, row.organization_id);
    if (!this.queues.visibleTo(principal, this.queues.resolve(row.owner_queue, configured))) {
      throw errors.accessDenied('This exception belongs to a queue outside your scope.', {
        queue: row.owner_queue,
      });
    }
    const history = await this.history(db, row.organization_id, [row.id]);
    return this.view(row, { principal, queues: configured, history, now: this.clock.now() });
  }

  async load(db: Reader, organizationId: string, id: string): Promise<ExceptionRow | undefined> {
    return db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Resolution history from the kernel's audit records of the exceptions (append-only). */
  async history(
    db: Reader,
    organizationId: string,
    ids: readonly string[],
  ): Promise<Map<string, ResolutionHistoryEntry[]>> {
    const out = new Map<string, ResolutionHistoryEntry[]>();
    if (ids.length === 0) return out;
    const rows = await db
      .selectFrom('audit_records')
      .select(['target_id', 'occurred_at', 'action', 'actor', 'reason'])
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', 'operational_exception')
      .where('target_id', 'in', [...ids])
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    for (const r of rows) {
      const list = out.get(r.target_id) ?? [];
      list.push({
        at: iso(r.occurred_at),
        action: r.action,
        actorLabel: actorOf(r.actor).actorLabel,
        reason: r.reason,
      });
      out.set(r.target_id, list);
    }
    return out;
  }

  /** The viewer's view of one exception: service levels, permitted next actions, history. */
  async view(row: ExceptionRow, ctx: ExceptionViewContext): Promise<OperationalException> {
    const queue = this.queues.resolve(row.owner_queue, ctx.queues);
    const openedAt = new Date(row.opened_at);
    const deadline = row.deadline_at
      ? new Date(row.deadline_at)
      : queue.resolveWithinMinutes
        ? addMinutesTo(openedAt, queue.resolveWithinMinutes)
        : null;
    const acknowledgeBy =
      row.status === 'open' && queue.acknowledgeWithinMinutes
        ? addMinutesTo(openedAt, queue.acknowledgeWithinMinutes)
        : null;
    const live = row.status === 'open' || row.status === 'acknowledged';
    const overdue =
      live &&
      ((deadline !== null && deadline.getTime() < ctx.now.getTime()) ||
        (acknowledgeBy !== null && acknowledgeBy.getTime() < ctx.now.getTime()));
    const nextActions = await this.nextActions.permitted(ctx.principal, [
      ...(live ? this.nextActions.domainCandidates(row) : []),
      ...this.nextActions.lifecycleCandidates(row),
    ]);
    return {
      id: row.id,
      facilityId: row.facility_id,
      category: row.category,
      severity: row.severity,
      title: row.title,
      affected:
        row.affected_type && row.affected_id
          ? { type: row.affected_type, id: row.affected_id }
          : null,
      ownerQueue: row.owner_queue,
      status: row.status,
      openedAt: openedAt.toISOString(),
      ageMinutes: minutesBetween(openedAt, ctx.now),
      deadlineAt: deadline ? deadline.toISOString() : null,
      acknowledgeBy: acknowledgeBy ? acknowledgeBy.toISOString() : null,
      overdue,
      acknowledgedAt: isoOrNull(row.acknowledged_at),
      resolvedAt: isoOrNull(row.resolved_at),
      closedAt: isoOrNull(row.closed_at),
      resolution: row.resolution ?? null,
      details: (row.details ?? {}) as Record<string, unknown>,
      revision: row.revision,
      history: [
        {
          at: openedAt.toISOString(),
          action: 'exceptions.opened',
          actorLabel: 'system',
          reason: null,
        },
        ...(ctx.history.get(row.id) ?? []),
      ],
      nextActions,
      underlyingRecordUnchanged: true,
    };
  }
}
