import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type EvidenceReference,
  type Inspection,
  type ListMaintenanceTasksQuery,
  type MaintenanceSeverity,
  type MaintenanceTask,
  type MaintenanceTaskStatus,
  type Page,
  type Principal,
  type RecordInspectionBody,
  type TaskResolution,
  type UpdateMaintenanceTaskBody,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { ResourcesService } from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import {
  InspectionRecorded,
  MaintenanceTaskDueReached,
  MaintenanceTaskReported,
  MaintenanceTaskUpdated,
  type MaintenanceTaskChange,
} from '../facilities.events';
import { FACILITIES_POLICY, type FacilitiesPolicy } from '../facilities.policy';
import { MaintenanceTaskMachine } from '../facilities.state-machines';
import type { MaintenanceReportPort, ReportIssueInput } from '../ports';
import { FacilitiesReader, organizationOf, type TaskRow } from './facilities-reader';

const Cursor = z.object({ reportedAt: z.string(), id: z.string() });
const TERMINAL_OR_RESOLVED = ['resolved', 'closed'] as const;

export interface NewTaskData {
  organizationId: string;
  facilityId: string;
  assetId: string | null;
  resourceId: string | null;
  issue: string;
  severity: MaintenanceSeverity;
  reporter: Principal;
  reporterNote?: string;
  evidence: EvidenceReference[];
  dueAt: Date | null;
  requiresInspection: boolean;
  assignedOwnerPersonId?: string | null;
  preventiveScheduleId?: string | null;
  occurrenceIndex?: number | null;
  reason?: string | null;
  correlationId?: string | null;
}

/**
 * Maintenance records (SPK-FAC-002): asset or space, issue, severity, reporter, evidence
 * (references only), assigned owner, due date, resolution and inspection. Overdue critical tasks
 * surface in the Today workspace as one operational exception per task (SPK-UX-006). Closing a
 * task never releases its operating restriction (SPK-FAC-004): see RestrictionsService.release.
 */
@Injectable()
export class MaintenanceTasksService implements MaintenanceReportPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FACILITIES_POLICY) private readonly policy: FacilitiesPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly reader: FacilitiesReader,
    private readonly resources: ResourcesService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  /**
   * SPK-FAC-002 / §4.3: a task's assigned owner is an active adult person of the task's own
   * organization, checked through the identity person directory (the composite foreign key of
   * migration 0901 is the database guarantee). A foreign-organization or unknown id reads exactly
   * like an inactive one.
   */
  async assertAssignableOwner(
    trx: Trx,
    organizationId: string,
    personId: string,
    path = 'assignedOwnerPersonId',
  ): Promise<void> {
    const person = await this.persons.findPerson(organizationId, personId, trx);
    if (!person || person.status !== 'active' || person.kind !== 'adult') {
      throw errors.validation(
        'The assigned owner must be an active adult person of this organization.',
        { path },
      );
    }
  }

  async reportIssue(principal: Principal, input: ReportIssueInput): Promise<MaintenanceTask> {
    const organizationId = organizationOf(principal);
    if (!input.assetId && !input.resourceId) {
      throw errors.validation('assetId or resourceId is required.');
    }
    await this.reader.loadFacility(this.db, organizationId, input.facilityId);
    // Cross-module reads go through the scheduling public API, before the transaction.
    const resource = input.resourceId
      ? await this.resources.getResource(principal, input.resourceId)
      : null;
    return this.uow.run(async ({ trx }) => {
      const facility = await this.reader.loadFacility(trx, organizationId, input.facilityId);
      await this.authorization.require(principal, FacilitiesActions.reportIssue, {
        type: 'maintenance_task',
        organizationId,
        facilityId: facility.id,
      });
      if (resource && resource.facilityId !== facility.id) {
        throw errors.validation('The resource belongs to another facility.', {
          resourceId: resource.id,
        });
      }
      let assetResourceId: string | null = null;
      if (input.assetId) {
        const asset = await this.reader.loadAsset(trx, organizationId, input.assetId);
        if (!asset || asset.facility_id !== facility.id) {
          throw errors.notFound('asset', input.assetId);
        }
        if (asset.status === 'retired') {
          throw errors.validation('The asset is retired; report the issue on its replacement.', {
            assetId: asset.id,
          });
        }
        assetResourceId = asset.resource_id;
      }
      const now = this.clock.now();
      const dueAt =
        input.dueAt === undefined
          ? this.defaultDue(now, input.severity)
          : input.dueAt === null
            ? null
            : new Date(input.dueAt);
      const row = await this.insertTask(trx, {
        organizationId,
        facilityId: facility.id,
        assetId: input.assetId ?? null,
        resourceId: resource?.id ?? assetResourceId,
        issue: input.issue,
        severity: input.severity,
        reporter: principal,
        evidence: input.evidence ?? [],
        dueAt,
        requiresInspection: input.requiresInspection ?? false,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
      });
      return this.reader.taskView(trx, row);
    });
  }

  /**
   * Inserts a task with its audit record, report event and (for escalating severities) the due
   * timer. Callers authorize first. Shared with preventive schedule generation (SPK-FAC-005).
   */
  async insertTask(trx: Trx, data: NewTaskData): Promise<TaskRow> {
    if (data.assignedOwnerPersonId) {
      await this.assertAssignableOwner(trx, data.organizationId, data.assignedOwnerPersonId);
    }
    const id = newId();
    const now = this.clock.now();
    const status = data.assignedOwnerPersonId ? 'assigned' : 'open';
    const row = await trx
      .insertInto('maintenance_tasks')
      .values({
        id,
        organization_id: data.organizationId,
        facility_id: data.facilityId,
        asset_id: data.assetId,
        resource_id: data.resourceId,
        issue: data.issue,
        severity: data.severity,
        reporter: json({
          ...snapshotActor(data.reporter),
          ...(data.reporterNote ? { note: data.reporterNote } : {}),
        }),
        reported_at: now,
        evidence: json(data.evidence),
        assigned_owner_person_id: data.assignedOwnerPersonId ?? null,
        due_at: data.dueAt,
        status,
        requires_inspection: data.requiresInspection,
        resolution: null,
        resolved_at: null,
        closed_at: null,
        preventive_schedule_id: data.preventiveScheduleId ?? null,
        occurrence_index: data.occurrenceIndex ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: data.organizationId,
      actor: data.reporter,
      action: 'facilities.maintenance_task_reported',
      targetType: 'maintenance_task',
      targetId: id,
      afterRevision: row.revision,
      reason: data.reason ?? null,
      correlationId: data.correlationId ?? null,
      details: {
        severity: data.severity,
        assetId: data.assetId,
        resourceId: data.resourceId,
        evidenceCount: data.evidence.length,
      },
    });
    await this.outbox.enqueue(trx, MaintenanceTaskReported, {
      organizationId: data.organizationId,
      aggregateType: 'maintenance_task',
      aggregateId: id,
      correlationId: data.correlationId ?? null,
      payload: {
        taskId: id,
        facilityId: data.facilityId,
        assetId: data.assetId,
        resourceId: data.resourceId,
        severity: data.severity,
        issue: data.issue,
        dueAt: data.dueAt ? data.dueAt.toISOString() : null,
        requiresInspection: data.requiresInspection,
        preventiveScheduleId: data.preventiveScheduleId ?? null,
      },
    });
    await this.scheduleDueCheck(trx, row, data.correlationId ?? null);
    return row;
  }

  async update(
    principal: Principal,
    taskId: string,
    body: UpdateMaintenanceTaskBody,
    correlationId?: string,
  ): Promise<MaintenanceTask> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadTask(trx, organizationId, taskId, true);
      if (!current) throw errors.notFound('maintenance_task', taskId);
      await this.authorization.require(principal, FacilitiesActions.manageMaintenanceTask, {
        type: 'maintenance_task',
        id: taskId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (current.status === 'closed') {
        throw errors.invalidTransition('MaintenanceTask', 'closed', body.status ?? 'update');
      }
      if (current.requires_inspection && body.requiresInspection === false) {
        // SPK-FAC-004: an inspection that remains required cannot be dropped while it gates the
        // release of an open restriction (the task row is locked, so no restriction slips past).
        const open = await this.reader.openRestrictionIds(trx, organizationId, taskId);
        if (open.length > 0) {
          throw errors.eligibility(
            'The inspection requirement cannot be removed while a restriction on this task is open; record the inspection, then release.',
            { code: 'inspection_required', taskId, openRestrictionIds: open },
          );
        }
      }
      const now = this.clock.now();
      const changes: MaintenanceTaskChange[] = [];
      let status: MaintenanceTaskStatus = current.status;
      let owner = current.assigned_owner_person_id;
      let resolution = (current.resolution as TaskResolution | null) ?? null;
      let resolvedAt: Date | null = current.resolved_at;
      let closedAt: Date | null = current.closed_at;

      if (body.assignedOwnerPersonId !== undefined) {
        if (body.assignedOwnerPersonId === null) {
          if (owner !== null) {
            status = MaintenanceTaskMachine.next(status, 'unassign');
            owner = null;
            changes.push('unassigned');
          }
        } else {
          await this.assertAssignableOwner(trx, organizationId, body.assignedOwnerPersonId);
          status = MaintenanceTaskMachine.next(status, 'assign');
          owner = body.assignedOwnerPersonId;
          changes.push('assigned');
        }
      }
      if (body.resolution) {
        resolution = {
          summary: body.resolution.summary,
          evidence: body.resolution.evidence ?? [],
          resolvedBy: snapshotActor(principal) as TaskResolution['resolvedBy'],
          resolvedAt: now.toISOString(),
        };
      }
      if (body.status !== undefined && body.status !== status) {
        switch (body.status) {
          case 'in_progress': {
            const event = status === 'resolved' ? 'reopen' : 'start';
            status = MaintenanceTaskMachine.next(status, event);
            resolvedAt = null;
            changes.push(event === 'reopen' ? 'reopened' : 'started');
            break;
          }
          case 'resolved': {
            status = MaintenanceTaskMachine.next(status, 'resolve');
            if (!resolution) {
              throw errors.validation('A resolution is required to resolve a task.', {
                path: 'resolution',
              });
            }
            resolvedAt = now;
            changes.push('resolved');
            break;
          }
          case 'closed': {
            status = MaintenanceTaskMachine.next(status, 'close');
            if (!resolution) {
              throw errors.validation('A resolution is required to close a task.', {
                path: 'resolution',
              });
            }
            resolvedAt = resolvedAt ?? now;
            closedAt = now;
            changes.push('closed');
            break;
          }
        }
      }
      const evidence = [
        ...(current.evidence as EvidenceReference[]),
        ...(body.evidence ?? []).map((e) => ({
          ...e,
          recordedAt: e.recordedAt ?? now.toISOString(),
        })),
      ];
      const dueAt: Date | null =
        body.dueAt === undefined
          ? current.due_at
          : body.dueAt === null
            ? null
            : new Date(body.dueAt);
      const severity = body.severity ?? current.severity;
      const fieldChanged =
        body.issue !== undefined ||
        body.severity !== undefined ||
        (body.evidence?.length ?? 0) > 0 ||
        body.dueAt !== undefined ||
        body.requiresInspection !== undefined ||
        (body.resolution !== undefined &&
          !changes.includes('resolved') &&
          !changes.includes('closed'));
      if (fieldChanged) changes.push('updated');

      const updated = await trx
        .updateTable('maintenance_tasks')
        .set({
          issue: body.issue,
          severity,
          evidence: json(evidence),
          assigned_owner_person_id: owner,
          due_at: dueAt,
          requires_inspection: body.requiresInspection,
          status,
          resolution: resolution === null ? null : json(resolution),
          resolved_at: resolvedAt,
          closed_at: closedAt,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', taskId)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const openRestrictionIds = await this.reader.openRestrictionIds(trx, organizationId, taskId);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.maintenance_task_updated',
        targetType: 'maintenance_task',
        targetId: taskId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: {
          changes,
          status,
          openRestrictionIds,
          ...(updated.requires_inspection !== current.requires_inspection
            ? {
                requiresInspection: {
                  from: current.requires_inspection,
                  to: updated.requires_inspection,
                },
              }
            : {}),
        },
      });
      await this.outbox.enqueue(trx, MaintenanceTaskUpdated, {
        organizationId,
        aggregateType: 'maintenance_task',
        aggregateId: taskId,
        correlationId: correlationId ?? null,
        payload: {
          taskId,
          facilityId: updated.facility_id,
          changes,
          status,
          severity,
          assignedOwnerPersonId: owner,
          dueAt: dueAt ? dueAt.toISOString() : null,
          openRestrictionIds,
        },
      });
      const dueChanged =
        (current.due_at?.getTime() ?? null) !== (dueAt?.getTime() ?? null) ||
        current.severity !== severity ||
        changes.includes('reopened');
      if (dueChanged) await this.scheduleDueCheck(trx, updated, correlationId ?? null);
      return this.reader.taskView(trx, updated);
    });
  }

  /**
   * Records an inspection (append-only). A failed inspection sends a resolved task back to work
   * and, on a closed task, raises an operational exception; the operating restriction is never
   * touched here (SPK-FAC-004: release is a separate authorized act).
   */
  async recordInspection(
    principal: Principal,
    taskId: string,
    body: RecordInspectionBody,
    correlationId?: string,
  ): Promise<Inspection> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const task = await this.reader.loadTask(trx, organizationId, taskId, true);
      if (!task) throw errors.notFound('maintenance_task', taskId);
      await this.authorization.require(principal, FacilitiesActions.recordInspection, {
        type: 'maintenance_task',
        id: taskId,
        organizationId,
        facilityId: task.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, task.revision);
      const now = this.clock.now();
      const inspectedAt = body.inspectedAt ? new Date(body.inspectedAt) : now;
      // SPK-FAC-004: the latest inspection decides the release, so an inspection is recorded only
      // once it has happened; a future-dated pass would outrank every later failed inspection.
      if (inspectedAt.getTime() > now.getTime()) {
        throw errors.validation('An inspection cannot be recorded before it has taken place.', {
          code: 'inspection_in_future',
          path: 'inspectedAt',
          inspectedAt: inspectedAt.toISOString(),
          now: now.toISOString(),
        });
      }
      const id = newId();
      const row = await trx
        .insertInto('inspections')
        .values({
          id,
          organization_id: organizationId,
          task_id: taskId,
          inspector: json(snapshotActor(principal)),
          outcome: body.outcome,
          notes: body.notes ?? null,
          inspected_at: inspectedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      let taskStatus = task.status;
      if (body.outcome === 'failed' && task.status === 'resolved') {
        taskStatus = MaintenanceTaskMachine.next(task.status, 'fail_inspection');
        await trx
          .updateTable('maintenance_tasks')
          .set({ status: taskStatus, resolved_at: null, revision: task.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', taskId)
          .where('revision', '=', task.revision)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'facilities.maintenance_task_updated',
          targetType: 'maintenance_task',
          targetId: taskId,
          beforeRevision: task.revision,
          afterRevision: task.revision + 1,
          reason: body.reason ?? 'inspection failed',
          correlationId: correlationId ?? null,
          details: { changes: ['reopened'], inspectionId: id },
        });
        await this.outbox.enqueue(trx, MaintenanceTaskUpdated, {
          organizationId,
          aggregateType: 'maintenance_task',
          aggregateId: taskId,
          correlationId: correlationId ?? null,
          payload: {
            taskId,
            facilityId: task.facility_id,
            changes: ['reopened'],
            status: taskStatus,
            severity: task.severity,
            assignedOwnerPersonId: task.assigned_owner_person_id,
            dueAt: task.due_at ? task.due_at.toISOString() : null,
            openRestrictionIds: await this.reader.openRestrictionIds(trx, organizationId, taskId),
          },
        });
      } else if (body.outcome === 'failed' && task.status === 'closed') {
        await this.exceptions.raise(trx, {
          organizationId,
          facilityId: task.facility_id,
          category: 'facilities.inspection_failed_after_close',
          severity: 'high',
          title: 'A closed maintenance task failed inspection; rework needs a new task',
          affectedType: 'maintenance_task',
          affectedId: taskId,
          ownerQueue: 'facilities_operator',
          dedupeKey: `maintenance_task:${taskId}:inspection_failed`,
          details: { inspectionId: id, assetId: task.asset_id, resourceId: task.resource_id },
        });
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.inspection_recorded',
        targetType: 'inspection',
        targetId: id,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: { taskId, outcome: body.outcome },
      });
      await this.outbox.enqueue(trx, InspectionRecorded, {
        organizationId,
        aggregateType: 'maintenance_task',
        aggregateId: taskId,
        correlationId: correlationId ?? null,
        payload: {
          inspectionId: id,
          taskId,
          facilityId: task.facility_id,
          outcome: body.outcome,
          inspectedAt: inspectedAt.toISOString(),
          taskStatus,
        },
      });
      return this.reader.inspectionView(row);
    });
  }

  async listInspections(principal: Principal, taskId: string): Promise<Inspection[]> {
    const organizationId = organizationOf(principal);
    const task = await this.reader.loadTask(this.db, organizationId, taskId);
    if (!task) throw errors.notFound('maintenance_task', taskId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'maintenance_task',
      id: taskId,
      organizationId,
      facilityId: task.facility_id,
    });
    const rows = await this.db
      .selectFrom('inspections')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('task_id', '=', taskId)
      .orderBy('inspected_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((r) => this.reader.inspectionView(r));
  }

  async get(principal: Principal, taskId: string): Promise<MaintenanceTask> {
    const organizationId = organizationOf(principal);
    const task = await this.reader.loadTask(this.db, organizationId, taskId);
    if (!task) throw errors.notFound('maintenance_task', taskId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'maintenance_task',
      id: taskId,
      organizationId,
      facilityId: task.facility_id,
    });
    return this.reader.taskView(this.db, task);
  }

  async list(
    principal: Principal,
    query: ListMaintenanceTasksQuery,
  ): Promise<Page<MaintenanceTask>> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(this.db, organizationId, query.facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'maintenance_task',
      organizationId,
      facilityId: query.facilityId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('maintenance_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .orderBy('reported_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.severity) q = q.where('severity', '=', query.severity);
    if (query.assetId) q = q.where('asset_id', '=', query.assetId);
    if (query.resourceId) q = q.where('resource_id', '=', query.resourceId);
    if (query.assignedOwnerPersonId) {
      q = q.where('assigned_owner_person_id', '=', query.assignedOwnerPersonId);
    }
    if (query.overdue) {
      q = q
        .where('status', 'not in', [...TERMINAL_OR_RESOLVED])
        .where('due_at', '<=', this.clock.now());
    }
    if (cursor) {
      q = q.where(
        sql<boolean>`(reported_at, id) < (${new Date(cursor.reportedAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = await this.reader.taskViews(this.db, rows.slice(0, query.limit));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({ reportedAt: new Date(last.reported_at).toISOString(), id: last.id })
        : null,
    };
  }

  /** Outbox handler target: escalates one task if it is still open, escalating and overdue (idempotent via dedupe key). */
  async escalateIfOverdue(trx: Trx, organizationId: string, taskId: string): Promise<boolean> {
    const task = await this.reader.loadTask(trx, organizationId, taskId);
    if (!task) return false;
    return this.raiseOverdue(trx, task, this.clock.now());
  }

  /** Sweep for automation (SPK-UX-006): every overdue escalating task gets at most one open exception. */
  async raiseOverdueExceptions(trx: Trx, organizationId: string, now: Date): Promise<number> {
    const severities = [...this.policy.overdueExceptionSeverities];
    if (severities.length === 0) return 0;
    const rows = await trx
      .selectFrom('maintenance_tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', 'not in', [...TERMINAL_OR_RESOLVED])
      .where('severity', 'in', severities)
      .where('due_at', '<=', now)
      .orderBy('due_at')
      .execute();
    let raised = 0;
    for (const row of rows) if (await this.raiseOverdue(trx, row, now)) raised += 1;
    return raised;
  }

  private async raiseOverdue(trx: Trx, task: TaskRow, now: Date): Promise<boolean> {
    if (!task.due_at || task.due_at.getTime() > now.getTime()) return false;
    if ((TERMINAL_OR_RESOLVED as readonly string[]).includes(task.status)) return false;
    if (!this.policy.overdueExceptionSeverities.includes(task.severity)) return false;
    await this.exceptions.raise(trx, {
      organizationId: task.organization_id,
      facilityId: task.facility_id,
      category: 'facilities.maintenance_task_overdue',
      severity: task.severity === 'critical' ? 'critical' : 'high',
      title: `${task.severity} maintenance task is overdue: ${task.issue.slice(0, 120)}`,
      affectedType: 'maintenance_task',
      affectedId: task.id,
      ownerQueue: 'facilities_operator',
      deadlineAt: task.due_at,
      dedupeKey: `maintenance_task:${task.id}:overdue`,
      details: {
        taskId: task.id,
        severity: task.severity,
        dueAt: task.due_at.toISOString(),
        assetId: task.asset_id,
        resourceId: task.resource_id,
        assignedOwnerPersonId: task.assigned_owner_person_id,
      },
    });
    return true;
  }

  /** Enqueues the due timer for escalating severities: delivered when the due instant arrives. */
  private async scheduleDueCheck(
    trx: Trx,
    task: TaskRow,
    correlationId: string | null,
  ): Promise<void> {
    if (!task.due_at) return;
    if ((TERMINAL_OR_RESOLVED as readonly string[]).includes(task.status)) return;
    if (!this.policy.overdueExceptionSeverities.includes(task.severity)) return;
    await this.outbox.enqueue(trx, MaintenanceTaskDueReached, {
      organizationId: task.organization_id,
      aggregateType: 'maintenance_task',
      aggregateId: task.id,
      correlationId,
      availableAt: task.due_at,
      payload: { taskId: task.id, facilityId: task.facility_id, dueAt: task.due_at.toISOString() },
    });
  }

  private defaultDue(now: Date, severity: MaintenanceSeverity): Date {
    return new Date(now.getTime() + this.policy.defaultDueHoursBySeverity[severity] * 3_600_000);
  }
}
