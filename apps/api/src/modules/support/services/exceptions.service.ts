import { Inject, Injectable } from '@nestjs/common';
import {
  encodeCursor,
  errors,
  type AcknowledgeExceptionInput,
  type ListExceptionsQuery,
  type OperationalException,
  type Page,
  type Principal,
  type ResolutionHistoryEntry,
  type SettleExceptionInput,
} from '@sportspark/contracts';
import type { Db, ExceptionStatus } from '@sportspark/db';
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
  iso,
  isoOrNull,
  minutesBetween,
  organizationOf,
  type ExceptionQueueRow,
  type Reader,
} from '../support.shared';
import { ExceptionQueuesService } from './exception-queues.service';
import { NextActions, type ExceptionRow } from './next-actions';

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
 * Every read goes through the kernel's `OperationalExceptions` read API (K-10, IF-29: `get`,
 * `list`, `history`); support never selects the kernel's tables (§4.2, SUP-02).
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
    const statuses: ExceptionStatus[] = query.status ? [query.status] : ['open', 'acknowledged'];
    // Facility-scoped staff see their facilities' exceptions and organization-wide ones (§4.3),
    // through the roles that hold the read action (§4.14, identity-05).
    const scope = listFacilityScope(principal, ExceptionActions.read);
    const inScope = (row: ExceptionRow) =>
      !scope || row.facility_id === null || scope.includes(row.facility_id);
    // The kernel list is newest first with a keyset cursor (K-10). Queue visibility (configured
    // owning roles), severity and facility scope are decided per row: scan in bounded batches.
    const visible: ExceptionRow[] = [];
    let cursor: string | undefined = query.cursor;
    let resumeAt: string | null = null;
    for (let pass = 0; visible.length <= query.limit; pass += 1) {
      if (pass >= SCAN_PASSES) {
        resumeAt = cursor ?? null;
        break;
      }
      const page = await this.exceptions.list(organizationId, {
        statuses,
        ownerQueue: query.queue,
        facilityId: query.facilityId,
        cursor,
        limit: SCAN_BATCH,
      });
      for (const row of page.items) {
        if (query.severity && row.severity !== query.severity) continue;
        if (!inScope(row)) continue;
        if (this.queues.visibleTo(principal, this.queues.resolve(row.owner_queue, configured))) {
          visible.push(row);
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const items = visible.slice(0, query.limit);
    const lastItem = items[items.length - 1];
    const nextCursor =
      visible.length > query.limit && lastItem ? kernelCursorAfter(lastItem) : resumeAt;
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
    const row = await this.exceptions.get(organizationId, id);
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
      const row = await this.exceptions.get(organizationId, id, trx);
      if (row) {
        const configured = await this.queues.configured(trx, organizationId);
        if (!this.queues.visibleTo(principal, this.queues.resolve(row.owner_queue, configured))) {
          throw errors.accessDenied('This exception belongs to a queue outside your scope.', {
            queue: row.owner_queue,
          });
        }
      }
      // Kernel: the row lock, `exceptions.manage` or queue-owner authority (facility scope),
      // lifecycle, revision and audit. An unknown id, or another organization's, is NOT_FOUND
      // (K-10, §4.3).
      await this.exceptions.transition(trx, principal, id, to, {
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        resolution: input.resolution,
        correlationId: correlationId ?? undefined,
      });
      if (!row) throw errors.notFound('exception', id);
      await this.outbox.enqueue(trx, ExceptionTransitioned, {
        organizationId,
        aggregateType: 'operational_exception',
        aggregateId: id,
        payload: { exceptionId: id, from: row.status, to, ownerQueue: row.owner_queue },
        correlationId,
      });
      const after = await this.exceptions.get(organizationId, id, trx);
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

  /**
   * Resolution history of the exceptions, oldest first, from the kernel's audited transitions
   * (`OperationalExceptions.history`, K-10 / IF-29 through AuditReader).
   */
  async history(
    db: Reader,
    organizationId: string,
    ids: readonly string[],
  ): Promise<Map<string, ResolutionHistoryEntry[]>> {
    const out = new Map<string, ResolutionHistoryEntry[]>();
    for (const id of new Set(ids)) {
      const records = await this.exceptions.history(organizationId, id, db);
      out.set(
        id,
        [...records].reverse().map((r) => ({
          at: iso(r.occurredAt),
          action: r.action,
          actorLabel: r.actor.actorLabel,
          reason: r.reason,
        })),
      );
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
      ...this.nextActions.lifecycleCandidates(row, ctx.principal),
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

/**
 * The kernel list's keyset position just after `row` (newest first: the next page starts with
 * the row opened before it). The same encoding `OperationalExceptions.list` issues as nextCursor.
 */
function kernelCursorAfter(row: ExceptionRow): string {
  return encodeCursor({ at: new Date(row.opened_at).toISOString(), id: row.id });
}
