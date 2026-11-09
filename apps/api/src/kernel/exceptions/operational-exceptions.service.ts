import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  DomainError,
  encodeCursor,
  errors,
  newId,
  StaffRole,
  z,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type ExceptionSeverity,
  type ExceptionStatus,
  type OperationalExceptionsTable,
} from '@sportspark/db';
import { sql, type RawBuilder, type Selectable, type SqlBool } from 'kysely';
import { AuditReader, type AuditRecord } from '../audit/audit-reader';
import { AuditWriter } from '../audit/audit.writer';
import { defineActions, type ActionDefinition } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import { listFacilityScope } from '../authorization/facility-scope';
import type { Clock } from '../clock';
import { ensureUpdated } from '../database/revision';
import { executorFor } from '../database/transaction-context';
import type { Trx } from '../database/unit-of-work';
import { CLOCK, DATABASE } from '../tokens';

export const ExceptionActions = defineActions({
  read: {
    id: 'exceptions.read',
    description: 'View operational exceptions in the Today workspace',
    staffRoles: [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'finance_operator',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    requirements: ['SPK-UX-006'],
  },
  manage: {
    id: 'exceptions.manage',
    description: 'Acknowledge, resolve, or close an operational exception',
    staffRoles: ['general_manager', 'system_administrator', 'support_operator'],
    requirements: ['SPK-UX-006'],
  },
  /**
   * K-10, §4.12 failure owner: the owner of a queue settles its own exceptions. Allowed in
   * `transition` only when the principal holds the staff role named by the exception's
   * `owner_queue` (within that role's facility scope); every other queue still needs
   * `exceptions.manage`. Proposed roles (permission matrix C.1).
   */
  manageOwnQueue: {
    id: 'exceptions.manage_own_queue',
    description: "Acknowledge, resolve or close an exception in the queue of one's own staff role",
    staffRoles: [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'finance_operator',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    requirements: ['SPK-UX-006', '§4.12'],
  },
});

export type OperationalExceptionRow = Selectable<OperationalExceptionsTable>;

export interface ListExceptionsFilter {
  statuses?: readonly ExceptionStatus[];
  ownerQueue?: string;
  category?: string;
  /** SUP-08: any of these categories (an empty list matches nothing). */
  categories?: readonly string[];
  facilityId?: string;
  affectedType?: string;
  affectedId?: string;
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

const ExceptionCursor = z.object({ at: z.string(), id: z.uuid() });

/** What the Today workspace shows (SPK-UX-006): exceptions not yet resolved or closed. */
const OPEN_STATUSES: readonly ExceptionStatus[] = ['open', 'acknowledged'];

/**
 * The severity order, most severe first: the `severity_rank` the database derives from `severity`
 * (migration 0017, R4-CARRY-02). Severity is text, and its text order is not this order.
 */
export const EXCEPTION_SEVERITY_RANK: Readonly<Record<ExceptionSeverity, number>> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

const SEVERITY_OF_RANK: ReadonlyMap<number, ExceptionSeverity> = new Map(
  Object.entries(EXCEPTION_SEVERITY_RANK).map(([severity, rank]) => [
    rank,
    severity as ExceptionSeverity,
  ]),
);

/**
 * Service levels a caller applies to one owner queue. The kernel stores none: support configures
 * them per queue (SPK-UX-006 owner queue) and passes them to the open reads, which compute the
 * due time and overdue state in SQL from them.
 */
export interface QueueServiceLevel {
  /** An exception without its own deadline is due this many minutes after it opened. */
  resolveWithinMinutes: number | null;
  /** An exception still `open` is overdue this many minutes after it opened. */
  acknowledgeWithinMinutes: number | null;
}

/** Which open exceptions an open read covers. Every read also keeps to the viewer's scope. */
export interface OpenExceptionsQuery {
  /** Exactly this facility (organization-wide exceptions excluded); authorized at that facility. */
  facilityId?: string | null;
  /**
   * Without `facilityId`: only these facilities, plus organization-wide exceptions (empty:
   * organization-wide only). Never widens the viewer's facility scope.
   */
  facilityIds?: readonly string[];
  ownerQueue?: string;
  /** Only these owner queues (empty: none). */
  ownerQueues?: readonly string[];
  /**
   * Service levels by queue name. An exception is due at its `deadline_at`, else `opened_at` plus
   * its queue's `resolveWithinMinutes`, else never; a queue without levels has none.
   */
  serviceLevels?: ReadonlyMap<string, QueueServiceLevel>;
}

/**
 * A bounded page of open exceptions in the open order: most severe first (`severity_rank`), then
 * soonest due (never due last), then id. `more` says whether any open exception follows the page;
 * `nextCursor` continues after it (for the same query).
 */
export interface OpenExceptionsPage {
  items: OperationalExceptionRow[];
  more: boolean;
  nextCursor: string | null;
}

/** The open exceptions of a query (after a page's cursor when given), counted in one read. */
export interface OpenExceptionsSummary {
  count: number;
  /** The first of them in the open order, or null when there are none. */
  first: { id: string; severity: ExceptionSeverity; ownerQueue: string } | null;
  /** Counts by severity and by owner queue; only the severities and queues that occur. */
  bySeverity: Partial<Record<ExceptionSeverity, number>>;
  byQueue: Record<string, number>;
  /** The soonest due time among them, or null when none of them is due. */
  earliestDueAt: Date | null;
  /** How many are overdue at `asOf`: past due, or still `open` past the acknowledgment window. */
  overdue: number;
}

/** A position in the open order: severity rank, due time (ISO, microseconds) or null, id. */
const OpenCursor = z.object({
  r: z.number().int(),
  d: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    .nullable(),
  i: z.uuid(),
});
type OpenPosition = z.infer<typeof OpenCursor>;

export interface RaiseExceptionInput {
  organizationId: string;
  facilityId?: string | null;
  category: string;
  severity: ExceptionSeverity;
  title: string;
  affectedType?: string | null;
  affectedId?: string | null;
  ownerQueue: string;
  deadlineAt?: Date | null;
  /** Open exceptions with the same key collapse into one until closed. */
  dedupeKey?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Operational exceptions power the Today workspace (SPK-UX-006). Closing an exception never
 * marks the underlying payment, booking, or delivery problem resolved: modules keep that state.
 */
@Injectable()
export class OperationalExceptions {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditWriter,
    private readonly authorization: AuthorizationService,
    private readonly auditReader: AuditReader,
  ) {}

  /** One exception of the organization, or null (another organization's id reads as null). */
  async get(
    organizationId: string,
    id: string,
    db?: Db | Trx,
  ): Promise<OperationalExceptionRow | null> {
    const row = await (db ?? executorFor(this.db))
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Exceptions of the organization, newest first (opened_at desc, id desc), with a keyset cursor
   * (K-10, IF-29). The caller authorizes its own context; an invalid cursor reads the first page.
   */
  async list(
    organizationId: string,
    filter: ListExceptionsFilter = {},
    db?: Db | Trx,
  ): Promise<Page<OperationalExceptionRow>> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    let query = (db ?? executorFor(this.db))
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (filter.statuses) {
      if (filter.statuses.length === 0) return { items: [], nextCursor: null };
      query = query.where('status', 'in', [...filter.statuses]);
    }
    if (filter.ownerQueue) query = query.where('owner_queue', '=', filter.ownerQueue);
    if (filter.category) query = query.where('category', '=', filter.category);
    if (filter.categories) {
      if (filter.categories.length === 0) return { items: [], nextCursor: null };
      query = query.where('category', 'in', [...filter.categories]);
    }
    if (filter.facilityId) query = query.where('facility_id', '=', filter.facilityId);
    if (filter.affectedType) query = query.where('affected_type', '=', filter.affectedType);
    if (filter.affectedId) query = query.where('affected_id', '=', filter.affectedId);
    const cursor = decodeCursor(filter.cursor, ExceptionCursor);
    if (cursor) {
      const at = new Date(cursor.at);
      query = query.where((eb) =>
        eb.or([
          eb('opened_at', '<', at),
          eb.and([eb('opened_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('opened_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: new Date(last.opened_at).toISOString(), id: last.id })
          : null,
    };
  }

  /** The audited transitions of one exception, newest first (through AuditReader, IF-44). */
  async history(organizationId: string, id: string, db?: Db | Trx): Promise<AuditRecord[]> {
    return this.auditReader.forTarget(
      organizationId,
      'operational_exception',
      id,
      { limit: 200 },
      db,
    );
  }

  /**
   * R3-PERFORMANCE-01: `history` of many exceptions in one audit read (newest first per exception,
   * the same 200-record bound each); every requested id is in the map.
   */
  async historyMany(
    organizationId: string,
    ids: readonly string[],
    db?: Db | Trx,
  ): Promise<Map<string, AuditRecord[]>> {
    return this.auditReader.forTargets(
      organizationId,
      'operational_exception',
      ids,
      { limitPerTarget: 200 },
      db,
    );
  }

  async raise(
    trx: Trx,
    input: RaiseExceptionInput,
  ): Promise<{ id: string; deduplicated: boolean }> {
    const id = newId();
    const inserted = await trx
      .insertInto('operational_exceptions')
      .values({
        id,
        organization_id: input.organizationId,
        facility_id: input.facilityId ?? null,
        category: input.category,
        severity: input.severity,
        title: input.title,
        affected_type: input.affectedType ?? null,
        affected_id: input.affectedId ?? null,
        owner_queue: input.ownerQueue,
        opened_at: this.clock.now(),
        deadline_at: input.deadlineAt ?? null,
        acknowledged_at: null,
        resolved_at: null,
        closed_at: null,
        resolution: null,
        details: json(input.details ?? {}),
        dedupe_key: input.dedupeKey ?? null,
      })
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'dedupe_key'])
          .where(sql<SqlBool>`dedupe_key is not null and status in ('open', 'acknowledged')`)
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (inserted) return { id, deduplicated: false };
    const existing = await trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('dedupe_key', '=', input.dedupeKey ?? '')
      .where('status', 'in', ['open', 'acknowledged'])
      .executeTakeFirstOrThrow();
    return { id: existing.id, deduplicated: true };
  }

  async transition(
    trx: Trx,
    principal: Principal,
    id: string,
    to: Exclude<ExceptionStatus, 'open'>,
    options: {
      expectedRevision?: number;
      reason?: string;
      resolution?: Record<string, unknown>;
      correlationId?: string;
      /** Set only by RecoveryMode.resume: the one path that may end a recovery (§5.8). */
      recoveryResume?: boolean;
    } = {},
  ): Promise<void> {
    // §4.9, §4.7 invariant 9: lock the row so the revision and state checks run against the
    // current row, and a concurrent transition can never be audited without having happened.
    // §4.10: loaded by the principal's organization, so another organization's id is not found.
    const current = principal.organizationId
      ? await trx
          .selectFrom('operational_exceptions')
          .select([
            'organization_id',
            'facility_id',
            'status',
            'revision',
            'category',
            'owner_queue',
            'dedupe_key',
          ])
          .where('organization_id', '=', principal.organizationId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    if (!current) throw errors.notFound('exception', id);
    const target = {
      type: 'operational_exception',
      id,
      organizationId: current.organization_id,
      facilityId: current.facility_id,
    };
    // K-10: the owner of the exception's queue settles it with its own role (in that role's
    // facility scope); any other queue needs exceptions.manage.
    const ownQueue = ownQueueAction(principal, current.owner_queue);
    const ownQueueAllowed = ownQueue
      ? (await this.authorization.decide(principal, ownQueue, target)).allowed
      : false;
    if (!ownQueueAllowed) {
      await this.authorization.require(principal, ExceptionActions.manage, target);
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw errors.staleRevision(options.expectedRevision, current.revision);
    }
    const allowed: Record<ExceptionStatus, ExceptionStatus[]> = {
      open: ['acknowledged', 'resolved', 'closed'],
      acknowledged: ['resolved', 'closed'],
      resolved: ['closed'],
      closed: [],
    };
    if (!allowed[current.status].includes(to)) {
      throw errors.invalidTransition('OperationalException', current.status, to);
    }
    if (
      current.category === 'reliability.recovery_mode' &&
      (to === 'resolved' || to === 'closed') &&
      (current.status === 'open' || current.status === 'acknowledged') &&
      !options.recoveryResume
    ) {
      // §5.8, SPK-AT-028: recovery after a restore ends only when provider facts are reconciled
      // and the recovery owner hands authority back, never by closing its Today card.
      throw new DomainError(
        'INVALID_TRANSITION',
        'Recovery after a restore ends through POST /v1/recovery/resume once provider facts are reconciled.',
        { details: { code: 'recovery_resume_required' } },
      );
    }
    if (to === 'resolved') {
      await this.refuseUnsettledDeadLetter(trx, current);
    }
    const now = this.clock.now();
    const updated = await trx
      .updateTable('operational_exceptions')
      .set({
        status: to,
        revision: current.revision + 1,
        acknowledged_at: to === 'acknowledged' ? now : undefined,
        resolved_at: to === 'resolved' ? now : undefined,
        closed_at: to === 'closed' ? now : undefined,
        resolution: options.resolution ? json(options.resolution) : undefined,
      })
      .where('organization_id', '=', current.organization_id)
      .where('id', '=', id)
      .where('revision', '=', current.revision)
      .executeTakeFirst();
    ensureUpdated(updated.numUpdatedRows, () =>
      errors.staleRevision(options.expectedRevision ?? current.revision, current.revision + 1),
    );
    await this.audit.record(trx, {
      organizationId: current.organization_id,
      actor: principal,
      action: `exceptions.${to}`,
      targetType: 'operational_exception',
      targetId: id,
      beforeRevision: current.revision,
      afterRevision: current.revision + 1,
      reason: options.reason ?? null,
      correlationId: options.correlationId ?? null,
    });
  }

  /**
   * R3-OPERATIONS-03 (§5.11, recovery runbook "never mark resolved without the effect happening"):
   * a dead letter's exception is resolved only once its event has settled (the worker resolves it
   * itself after a replay). While the event is still dead, or replayed but not yet settled, the
   * exception can be closed with a reason, not resolved. The same holds for the exception of an
   * event that waits for a missing handler (migration 0015): the worker resolves it when the event
   * settles.
   */
  private async refuseUnsettledDeadLetter(
    trx: Trx,
    current: { organization_id: string; category: string; dedupe_key: string | null },
  ): Promise<void> {
    const guarded = SETTLEMENT_GUARDED_CATEGORIES[current.category];
    if (!guarded || !current.dedupe_key?.startsWith(guarded.keyPrefix)) return;
    const { source, waiting } = guarded;
    const eventId = current.dedupe_key.slice(guarded.keyPrefix.length);
    const event =
      source === 'outbox'
        ? await trx
            .selectFrom('outbox_events')
            .select('status')
            .where('organization_id', '=', current.organization_id)
            .where('id', '=', eventId)
            .executeTakeFirst()
        : await trx
            .selectFrom('inbox_events')
            .select('status')
            .where('organization_id', '=', current.organization_id)
            .where('id', '=', eventId)
            .executeTakeFirst();
    if (!event) return;
    const settled =
      source === 'outbox' ? event.status === 'dispatched' : event.status === 'processed';
    if (settled) return;
    if (waiting) {
      throw new DomainError(
        'INVALID_TRANSITION',
        'This follow-up has not happened yet: the event still waits for handlers the running build does not register. Deploy a build that registers them or declares them retired; the exception is resolved when the event settles. Close the exception with a reason instead to stop being told.',
        {
          details: {
            code: 'handler_wait_unsettled',
            source,
            eventId,
            eventStatus: event.status,
          },
        },
      );
    }
    throw new DomainError(
      'INVALID_TRANSITION',
      `This follow-up has not happened yet. Replay the event once its cause is fixed (POST /v1/${source === 'outbox' ? 'outbox-events' : 'provider-events'}/${eventId}/replay); the exception is resolved when it settles. Close the exception with a reason instead if the follow-up is no longer wanted.`,
      {
        details: {
          code: 'dead_letter_replay_required',
          source,
          eventId,
          eventStatus: event.status,
        },
      },
    );
  }

  /**
   * Every open exception the viewer may read, in the open order (most severe, then soonest
   * `deadline_at`, then id). Unbounded: prefer {@link listOpenPage} and {@link summarizeOpen},
   * which bound the read (R4-CARRY-02); this form stays until its last caller (support's Today
   * feed) has moved to them.
   * @deprecated R4-CARRY-02: use listOpenPage and summarizeOpen.
   */
  async listOpen(
    principal: Principal,
    organizationId: string,
    filter: { facilityId?: string | null; ownerQueue?: string } = {},
  ): Promise<OperationalExceptionRow[]> {
    await this.requireRead(principal, organizationId, filter);
    return this.openScope(executorFor(this.db), principal, organizationId, filter)
      .selectAll()
      .orderBy('severity_rank')
      .orderBy('deadline_at')
      .orderBy('id')
      .execute();
  }

  /**
   * R4-CARRY-02 (R3-PERFORMANCE-01, SPK-UX-006, §5.10): a bounded keyset page (1..200, default
   * 50) of the open exceptions the viewer may read, in the open order computed by the database:
   * `severity_rank`, then the due time (`deadline_at`, else `opened_at` plus the queue's
   * `resolveWithinMinutes`; never due last), then id. Served by
   * `operational_exceptions_open_rank_idx` (migration 0017). An invalid cursor reads the first page.
   */
  async listOpenPage(
    principal: Principal,
    organizationId: string,
    query: OpenExceptionsQuery & { cursor?: string | null; limit?: number } = {},
  ): Promise<OpenExceptionsPage> {
    await this.requireRead(principal, organizationId, query);
    const requested = query.limit !== undefined && Number.isFinite(query.limit) ? query.limit : 50;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), 200);
    const due = dueExpression(query.serviceLevels);
    let rows = this.openScope(executorFor(this.db), principal, organizationId, query)
      .selectAll()
      .select(isoMicros(due).as('open_due'));
    const after = decodeCursor(query.cursor ?? undefined, OpenCursor);
    if (after) rows = rows.where(afterPosition(after, due));
    const read = await rows
      .orderBy('severity_rank')
      .orderBy(sql`${due} asc nulls last`)
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const more = read.length > limit;
    const page = read.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ open_due: _due, ...row }) => row),
      more,
      nextCursor:
        more && last
          ? encodeCursor({
              r: last.severity_rank,
              d: last.open_due,
              i: last.id,
            } satisfies OpenPosition)
          : null,
    };
  }

  /**
   * R4-CARRY-02: counts the open exceptions of `query` the viewer may read (only those after the
   * `after` cursor of {@link listOpenPage}, when given) in one aggregate read, by severity and
   * queue, with the soonest due time, how many are overdue at `asOf` (default now) and the first
   * of them. A Today read lists one page and summarises the rest with this, so it never loads
   * every open exception of the organization. The page and the summary are separate statements:
   * a caller that needs them from one snapshot runs both in one transaction (they join it).
   */
  async summarizeOpen(
    principal: Principal,
    organizationId: string,
    query: OpenExceptionsQuery & { after?: string | null; asOf?: Date } = {},
  ): Promise<OpenExceptionsSummary> {
    await this.requireRead(principal, organizationId, query);
    const executor = executorFor(this.db);
    const due = dueExpression(query.serviceLevels);
    const asOf = (query.asOf ?? this.clock.now()).toISOString();
    const overdue = overdueExpression(query.serviceLevels, due, asOf);
    const after = decodeCursor(query.after ?? undefined, OpenCursor);
    const scoped = () => {
      const rows = this.openScope(executor, principal, organizationId, query);
      return after ? rows.where(afterPosition(after, due)) : rows;
    };
    // Grouped by the stored rank, not the severity text: every column this read needs is in
    // operational_exceptions_open_rank_idx (migration 0017).
    const groups = await scoped()
      .select([
        'severity_rank',
        'owner_queue',
        sql<number>`count(*)::int`.as('n'),
        sql<Date | string | null>`min(${due})`.as('earliest'),
        sql<number>`(count(*) filter (where ${overdue}))::int`.as('overdue'),
      ])
      .groupBy(['severity_rank', 'owner_queue'])
      .execute();
    const first = await scoped()
      .select(['id', 'severity', 'owner_queue'])
      .orderBy('severity_rank')
      .orderBy(sql`${due} asc nulls last`)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    const summary: OpenExceptionsSummary = {
      count: 0,
      first: first
        ? { id: first.id, severity: first.severity, ownerQueue: first.owner_queue }
        : null,
      bySeverity: {},
      byQueue: {},
      earliestDueAt: null,
      overdue: 0,
    };
    for (const group of groups) {
      const severity = SEVERITY_OF_RANK.get(group.severity_rank);
      if (!severity) throw new Error(`unknown severity_rank ${group.severity_rank}`);
      summary.count += group.n;
      summary.overdue += group.overdue;
      summary.bySeverity[severity] = (summary.bySeverity[severity] ?? 0) + group.n;
      summary.byQueue[group.owner_queue] = (summary.byQueue[group.owner_queue] ?? 0) + group.n;
      const earliest = group.earliest === null ? null : new Date(group.earliest);
      if (earliest && (!summary.earliestDueAt || earliest < summary.earliestDueAt)) {
        summary.earliestDueAt = earliest;
      }
    }
    return summary;
  }

  private async requireRead(
    principal: Principal,
    organizationId: string,
    query: { facilityId?: string | null },
  ): Promise<void> {
    await this.authorization.require(principal, ExceptionActions.read, {
      type: 'operational_exception',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
  }

  /** The open exceptions of the organization that `query` and the viewer's scope cover. */
  private openScope(
    executor: Db | Trx,
    principal: Principal,
    organizationId: string,
    query: OpenExceptionsQuery,
  ) {
    let rows = executor
      .selectFrom('operational_exceptions')
      .where('organization_id', '=', organizationId)
      .where('status', 'in', [...OPEN_STATUSES]);
    if (query.facilityId) {
      rows = rows.where('facility_id', '=', query.facilityId);
    } else {
      // §4.3, §4.14, SPK-UX-006 ("within the viewer's scope"): facility-scoped staff see their
      // facilities' exceptions plus organization-wide ones (facility_id null), the same scope
      // AuthorizationService.decide grants them for a single exception.
      const scope = listFacilityScope(principal, ExceptionActions.read);
      if (scope) rows = rows.where(facilityOrOrganizationWide([...scope]));
      if (query.facilityIds) rows = rows.where(facilityOrOrganizationWide([...query.facilityIds]));
    }
    if (query.ownerQueue) rows = rows.where('owner_queue', '=', query.ownerQueue);
    if (query.ownerQueues) {
      const queues = [...query.ownerQueues];
      rows = rows.where(
        queues.length > 0
          ? sql<SqlBool>`owner_queue in (${sql.join(queues)})`
          : sql<SqlBool>`false`,
      );
    }
    return rows;
  }
}

/**
 * Exceptions the worker resolves once their outbox or inbox event settles, never by hand before
 * (R3-OPERATIONS-03 dead letters; migration 0015 waits for a missing handler), by category, with
 * the dedupe-key prefix that precedes the event id (`dead-letters.ts`).
 */
const SETTLEMENT_GUARDED_CATEGORIES: Readonly<
  Record<string, { source: 'outbox' | 'inbox'; keyPrefix: string; waiting: boolean }>
> = {
  'reliability.outbox_dead_letter': { source: 'outbox', keyPrefix: 'outbox:', waiting: false },
  'reliability.inbox_dead_letter': { source: 'inbox', keyPrefix: 'inbox:', waiting: false },
  'reliability.outbox_waiting_for_handler': {
    source: 'outbox',
    keyPrefix: 'outbox-wait:',
    waiting: true,
  },
  'reliability.inbox_waiting_for_handler': {
    source: 'inbox',
    keyPrefix: 'inbox-wait:',
    waiting: true,
  },
};

/**
 * `exceptions.manage_own_queue` narrowed to the one staff role the queue names, so a role held
 * elsewhere never settles it (identity-05), or null when the queue is not a role the principal holds.
 */
function ownQueueAction(principal: Principal, ownerQueue: string): ActionDefinition | null {
  if (principal.kind !== 'staff') return null;
  const role = StaffRole.safeParse(ownerQueue);
  if (!role.success || !principal.staffRoles.includes(role.data)) return null;
  if (!ExceptionActions.manageOwnQueue.staffRoles.includes(role.data)) return null;
  return { ...ExceptionActions.manageOwnQueue, staffRoles: [role.data] };
}

/** `facility_id` in `facilityIds` or null (organization-wide). */
function facilityOrOrganizationWide(facilityIds: readonly string[]): RawBuilder<SqlBool> {
  return facilityIds.length > 0
    ? sql<SqlBool>`(facility_id in (${sql.join([...facilityIds])}) or facility_id is null)`
    : sql<SqlBool>`facility_id is null`;
}

/**
 * The per-queue minutes `pick` names, as `case owner_queue when <queue> then <minutes> end`, or
 * null when no queue has a positive window (queues without one read as null).
 */
function queueMinutes(
  levels: ReadonlyMap<string, QueueServiceLevel> | undefined,
  pick: (level: QueueServiceLevel) => number | null,
): RawBuilder<number | null> | null {
  const windows: Array<[string, number]> = [];
  for (const [queue, level] of levels ?? []) {
    const minutes = pick(level);
    if (minutes !== null && Number.isSafeInteger(minutes) && minutes > 0) {
      windows.push([queue, minutes]);
    }
  }
  if (windows.length === 0) return null;
  const branches = windows.map(
    ([queue, minutes]) => sql`when ${queue} then cast(${minutes} as integer)`,
  );
  return sql<number | null>`case owner_queue ${sql.join(branches, sql` `)} end`;
}

/** When an open exception is due: `deadline_at`, else opened_at plus its queue's window. */
function dueExpression(
  levels: ReadonlyMap<string, QueueServiceLevel> | undefined,
): RawBuilder<Date | null> {
  const minutes = queueMinutes(levels, (l) => l.resolveWithinMinutes);
  return minutes
    ? sql<Date | null>`coalesce(deadline_at, opened_at + make_interval(mins => ${minutes}))`
    : sql<Date | null>`deadline_at`;
}

/** Past due at `asOf`, or still `open` past its queue's acknowledgment window. */
function overdueExpression(
  levels: ReadonlyMap<string, QueueServiceLevel> | undefined,
  due: RawBuilder<Date | null>,
  asOf: string,
): RawBuilder<SqlBool> {
  const at = sql`cast(${asOf} as timestamptz)`;
  const acknowledge = queueMinutes(levels, (l) => l.acknowledgeWithinMinutes);
  return acknowledge
    ? sql<SqlBool>`(${due} < ${at} or (status = 'open' and opened_at + make_interval(mins => ${acknowledge}) < ${at}))`
    : sql<SqlBool>`${due} < ${at}`;
}

/** A due time as an exact ISO instant (microseconds, UTC) for the keyset cursor. */
function isoMicros(due: RawBuilder<Date | null>): RawBuilder<string | null> {
  return sql<string | null>`to_char(${due} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Strictly after `position` in the open order (severity_rank, due asc nulls last, id). */
function afterPosition(position: OpenPosition, due: RawBuilder<Date | null>): RawBuilder<SqlBool> {
  const { r: rank, d: dueAt, i: id } = position;
  if (dueAt === null) {
    return sql<SqlBool>`(severity_rank > ${rank} or (severity_rank = ${rank} and ${due} is null and id > ${id}))`;
  }
  const at = sql`cast(${dueAt} as timestamptz)`;
  return sql<SqlBool>`(severity_rank > ${rank} or (severity_rank = ${rank} and (${due} is null or ${due} > ${at} or (${due} = ${at} and id > ${id}))))`;
}
