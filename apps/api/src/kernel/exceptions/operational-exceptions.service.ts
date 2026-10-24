import { Inject, Injectable } from '@nestjs/common';
import { errors, newId, type Principal } from '@sportspark/contracts';
import { json, type Db, type ExceptionSeverity, type ExceptionStatus } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import { AuditWriter } from '../audit/audit.writer';
import { defineActions } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import { listFacilityScope } from '../authorization/facility-scope';
import type { Clock } from '../clock';
import { ensureUpdated } from '../database/revision';
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
});

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
  ) {}

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
    } = {},
  ): Promise<void> {
    // §4.9, §4.7 invariant 9: lock the row so the revision and state checks run against the
    // current row, and a concurrent transition can never be audited without having happened.
    const current = await trx
      .selectFrom('operational_exceptions')
      .select(['organization_id', 'facility_id', 'status', 'revision'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw errors.notFound('exception', id);
    await this.authorization.require(principal, ExceptionActions.manage, {
      type: 'operational_exception',
      id,
      organizationId: current.organization_id,
      facilityId: current.facility_id,
    });
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
