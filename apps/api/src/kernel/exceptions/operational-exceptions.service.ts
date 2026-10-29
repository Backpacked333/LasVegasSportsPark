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
import { sql, type Selectable, type SqlBool } from 'kysely';
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
  facilityId?: string;
  affectedType?: string;
  affectedId?: string;
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
}

const ExceptionCursor = z.object({ at: z.string(), id: z.uuid() });

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

  async listOpen(
    principal: Principal,
    organizationId: string,
    filter: { facilityId?: string | null; ownerQueue?: string } = {},
  ) {
    await this.authorization.require(principal, ExceptionActions.read, {
      type: 'operational_exception',
      organizationId,
      facilityId: filter.facilityId ?? null,
    });
    let query = this.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('severity')
      .orderBy('opened_at');
    if (filter.facilityId) {
      query = query.where('facility_id', '=', filter.facilityId);
    } else {
      // §4.3, §4.14, SPK-UX-006 ("within the viewer's scope"): facility-scoped staff see their
      // facilities' exceptions plus organization-wide ones (facility_id null), the same scope
      // AuthorizationService.decide grants them for a single exception.
      const scope = listFacilityScope(principal, ExceptionActions.read);
      if (scope) {
        const facilityIds = [...scope];
        query = query.where((eb) =>
          facilityIds.length > 0
            ? eb.or([eb('facility_id', 'in', facilityIds), eb('facility_id', 'is', null)])
            : eb('facility_id', 'is', null),
        );
      }
    }
    if (filter.ownerQueue) query = query.where('owner_queue', '=', filter.ownerQueue);
    return query.execute();
  }
}

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
