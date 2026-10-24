import { Injectable } from '@nestjs/common';
import {
  errors,
  RecurrenceRuleSchema,
  type ActorSnapshot,
  type Asset,
  type EvidenceReference,
  type Inspection,
  type MaintenanceTask,
  type PreventiveSchedule,
  type PreventiveTaskTemplate,
  type Principal,
  type Restriction,
  type TaskResolution,
} from '@sportspark/contracts';
import type {
  AssetsTable,
  Db,
  InspectionsTable,
  MaintenanceTasksTable,
  PreventiveSchedulesTable,
  RestrictionsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import type { Trx } from '../../../kernel';

export type AssetRow = Selectable<AssetsTable>;
export type TaskRow = Selectable<MaintenanceTasksTable>;
export type InspectionRow = Selectable<InspectionsTable>;
export type RestrictionRow = Selectable<RestrictionsTable> & { start: string; end: string };
export type ScheduleRow = Selectable<PreventiveSchedulesTable>;
export type DbHandle = Trx | Db;

export interface FacilityRow {
  id: string;
  organization_id: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const OPEN_RESTRICTION_STATUSES = ['proposed', 'approved', 'active'] as const;
const OPEN_TASK_STATUSES = ['open', 'assigned', 'in_progress'] as const;

/** Loaders and view mappers shared by the facilities services. Callers authorize before using them. */
@Injectable()
export class FacilitiesReader {
  async loadFacility(
    db: DbHandle,
    organizationId: string,
    facilityId: string,
  ): Promise<FacilityRow> {
    const row = await db
      .selectFrom('facilities')
      .select(['id', 'organization_id', 'timezone', 'settings'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('facility', facilityId);
    return row;
  }

  async loadAsset(
    db: DbHandle,
    organizationId: string,
    assetId: string,
    forUpdate = false,
  ): Promise<AssetRow | undefined> {
    let q = db
      .selectFrom('assets')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', assetId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async loadTask(
    db: DbHandle,
    organizationId: string,
    taskId: string,
    forUpdate = false,
  ): Promise<TaskRow | undefined> {
    let q = db
      .selectFrom('maintenance_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', taskId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  restrictionQuery(db: DbHandle) {
    return db
      .selectFrom('restrictions')
      .selectAll()
      .select([sql<string>`lower(during)`.as('start'), sql<string>`upper(during)`.as('end')]);
  }

  async loadRestriction(
    db: DbHandle,
    organizationId: string,
    restrictionId: string,
    forUpdate = false,
  ): Promise<RestrictionRow | undefined> {
    let q = this.restrictionQuery(db)
      .where('organization_id', '=', organizationId)
      .where('id', '=', restrictionId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async loadSchedule(
    db: DbHandle,
    organizationId: string,
    scheduleId: string,
    forUpdate = false,
  ): Promise<ScheduleRow | undefined> {
    let q = db
      .selectFrom('preventive_schedules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', scheduleId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** The most recent inspection decides SPK-FAC-004 (a later failed inspection overrides an earlier pass). */
  async latestInspection(
    db: DbHandle,
    organizationId: string,
    taskId: string,
  ): Promise<InspectionRow | undefined> {
    return db
      .selectFrom('inspections')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('task_id', '=', taskId)
      .orderBy('inspected_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  async openRestrictionIds(
    db: DbHandle,
    organizationId: string,
    taskId: string,
  ): Promise<string[]> {
    const rows = await db
      .selectFrom('restrictions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('task_id', '=', taskId)
      .where('status', 'in', [...OPEN_RESTRICTION_STATUSES])
      .orderBy('id')
      .execute();
    return rows.map((r) => r.id);
  }

  /** Does the asset still have an unreleased restriction (other than the one being released)? */
  async hasOtherOpenRestrictions(
    db: DbHandle,
    organizationId: string,
    assetId: string,
    exceptRestrictionId: string,
  ): Promise<boolean> {
    const row = await db
      .selectFrom('restrictions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('asset_id', '=', assetId)
      .where('id', '<>', exceptRestrictionId)
      .where('status', 'in', [...OPEN_RESTRICTION_STATUSES])
      .executeTakeFirst();
    return row !== undefined;
  }

  async hasOpenTasks(db: DbHandle, organizationId: string, assetId: string): Promise<boolean> {
    const row = await db
      .selectFrom('maintenance_tasks')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('asset_id', '=', assetId)
      .where('status', 'in', [...OPEN_TASK_STATUSES])
      .executeTakeFirst();
    return row !== undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  assetView(row: AssetRow): Asset {
    return {
      id: row.id,
      facilityId: row.facility_id,
      resourceId: row.resource_id,
      kind: row.kind,
      name: row.name,
      identifier: row.identifier,
      attributes: row.attributes,
      status: row.status,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  inspectionView(row: InspectionRow): Inspection {
    return {
      id: row.id,
      taskId: row.task_id,
      inspector: row.inspector as ActorSnapshot,
      outcome: row.outcome,
      notes: row.notes,
      inspectedAt: iso(row.inspected_at),
      createdAt: iso(row.created_at),
    };
  }

  async taskView(db: DbHandle, row: TaskRow): Promise<MaintenanceTask> {
    const [view] = await this.taskViews(db, [row]);
    return view as MaintenanceTask;
  }

  /** Batched: one query for the latest inspections and one for open restrictions of all rows. */
  async taskViews(db: DbHandle, rows: TaskRow[]): Promise<MaintenanceTask[]> {
    if (rows.length === 0) return [];
    const organizationId = rows[0]?.organization_id as string;
    const ids = rows.map((r) => r.id);
    const inspections = await db
      .selectFrom('inspections')
      .distinctOn('task_id')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('task_id', 'in', ids)
      .orderBy('task_id')
      .orderBy('inspected_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const restrictions = await db
      .selectFrom('restrictions')
      .select(['id', 'task_id'])
      .where('organization_id', '=', organizationId)
      .where('task_id', 'in', ids)
      .where('status', 'in', [...OPEN_RESTRICTION_STATUSES])
      .orderBy('id')
      .execute();
    return rows.map((row) => {
      const latest = inspections.find((i) => i.task_id === row.id);
      return {
        id: row.id,
        facilityId: row.facility_id,
        assetId: row.asset_id,
        resourceId: row.resource_id,
        issue: row.issue,
        severity: row.severity,
        reporter: row.reporter as ActorSnapshot,
        reportedAt: iso(row.reported_at),
        evidence: row.evidence as EvidenceReference[],
        assignedOwnerPersonId: row.assigned_owner_person_id,
        dueAt: isoOrNull(row.due_at),
        status: row.status,
        requiresInspection: row.requires_inspection,
        resolution: (row.resolution as TaskResolution | null) ?? null,
        resolvedAt: isoOrNull(row.resolved_at),
        closedAt: isoOrNull(row.closed_at),
        preventiveScheduleId: row.preventive_schedule_id,
        occurrenceIndex: row.occurrence_index,
        latestInspection: latest ? this.inspectionView(latest) : null,
        openRestrictionIds: restrictions.filter((r) => r.task_id === row.id).map((r) => r.id),
        revision: row.revision,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      };
    });
  }

  restrictionView(row: RestrictionRow): Restriction {
    return {
      id: row.id,
      facilityId: row.facility_id,
      resourceId: row.resource_id,
      assetId: row.asset_id,
      taskId: row.task_id,
      preventiveScheduleId: row.preventive_schedule_id,
      occurrenceIndex: row.occurrence_index,
      kind: row.kind,
      interval: { start: iso(row.start), end: iso(row.end) },
      reason: row.reason,
      affectedConflictUnitIds: row.affected_conflict_unit_ids,
      status: row.status,
      approvedBy: (row.approved_by as ActorSnapshot | null) ?? null,
      approvedAt: isoOrNull(row.approved_at),
      schedulingClosureId: row.scheduling_closure_id,
      releasedBy: (row.released_by as ActorSnapshot | null) ?? null,
      releasedAt: isoOrNull(row.released_at),
      releaseReason: row.release_reason,
      operationId: row.operation_id,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  scheduleView(row: ScheduleRow): PreventiveSchedule {
    return {
      id: row.id,
      facilityId: row.facility_id,
      resourceId: row.resource_id,
      assetId: row.asset_id,
      name: row.name,
      recurrence: RecurrenceRuleSchema.parse(row.recurrence),
      localStartTime: row.local_start_time.slice(0, 5),
      durationMinutes: row.duration_minutes,
      timezone: row.timezone,
      taskTemplate: row.task_template as PreventiveTaskTemplate,
      restrictionKind: row.restriction_kind,
      leadTimeDays: row.lead_time_days,
      status: row.status,
      lastGeneratedAt: isoOrNull(row.last_generated_at),
      lastGeneratedThrough: isoOrNull(row.last_generated_through),
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
