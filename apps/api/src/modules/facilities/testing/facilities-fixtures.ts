import {
  newId,
  systemPrincipal,
  type AssetKind,
  type EvidenceReference,
  type Inspection,
  type MaintenanceSeverity,
  type MaintenanceTask,
  type PreventiveSchedule,
  type Principal,
  type RecurrenceRule,
  type Restriction,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { MaintenanceTasksService } from '../services/maintenance-tasks.service';
import type { PreventiveSchedulesService } from '../services/preventive-schedules.service';
import type { RestrictionsService } from '../services/restrictions.service';

/**
 * Fixtures for downstream modules (reporting, support, automation, communications). Assets are
 * written directly through Kysely; tasks, inspections, restrictions and schedules go through the
 * services so closures, audit and outbox follow-ups are real.
 */

export interface SeedAssetOptions {
  organizationId: string;
  facilityId: string;
  resourceId?: string | null;
  kind?: AssetKind;
  name?: string;
  identifier?: string | null;
  status?: 'in_service' | 'restricted' | 'out_of_service';
  attributes?: Record<string, unknown>;
}

export async function seedAsset(db: Db, options: SeedAssetOptions): Promise<string> {
  const id = newId();
  await db
    .insertInto('assets')
    .values({
      id,
      organization_id: options.organizationId,
      facility_id: options.facilityId,
      resource_id: options.resourceId ?? null,
      kind: options.kind ?? 'turf',
      name: options.name ?? `Asset ${id.slice(0, 4)}`,
      identifier: options.identifier ?? null,
      attributes: json(options.attributes ?? {}),
      status: options.status ?? 'in_service',
    })
    .execute();
  return id;
}

export interface ReportTaskOptions {
  organizationId: string;
  facilityId: string;
  assetId?: string | null;
  resourceId?: string | null;
  issue?: string;
  severity?: MaintenanceSeverity;
  evidence?: EvidenceReference[];
  dueAt?: string | null;
  requiresInspection?: boolean;
  principal?: Principal;
}

/** Reports a task through the service (audit, report event and due timer included). */
export async function reportMaintenanceTask(
  tasks: MaintenanceTasksService,
  options: ReportTaskOptions,
): Promise<MaintenanceTask> {
  return tasks.reportIssue(
    options.principal ?? systemPrincipal(options.organizationId, 'fixtures'),
    {
      facilityId: options.facilityId,
      assetId: options.assetId ?? null,
      resourceId: options.resourceId ?? null,
      issue: options.issue ?? 'Turf seam lifted near the penalty spot',
      severity: options.severity ?? 'high',
      evidence: options.evidence ?? [{ kind: 'photo', reference: 'evidence/turf-seam.jpg' }],
      dueAt: options.dueAt,
      requiresInspection: options.requiresInspection ?? false,
    },
  );
}

export async function recordInspection(
  tasks: MaintenanceTasksService,
  options: {
    organizationId: string;
    taskId: string;
    outcome: 'passed' | 'failed';
    notes?: string;
    inspectedAt?: string;
    principal?: Principal;
  },
): Promise<Inspection> {
  return tasks.recordInspection(
    options.principal ?? systemPrincipal(options.organizationId, 'fixtures'),
    options.taskId,
    { outcome: options.outcome, notes: options.notes, inspectedAt: options.inspectedAt },
  );
}

export interface ActiveRestrictionOptions {
  organizationId: string;
  facilityId: string;
  resourceId?: string | null;
  assetId?: string | null;
  taskId?: string | null;
  kind?: 'closed' | 'limited';
  start: string;
  end: string;
  reason?: string;
  resolutionMode?: 'cancel_affected' | 'leave_for_resolution';
  principal?: Principal;
}

/** Proposes and approves a restriction: the scheduling closure is created and applied for real (SPK-FAC-003). */
export async function createActiveRestriction(
  restrictions: RestrictionsService,
  options: ActiveRestrictionOptions,
): Promise<Restriction> {
  const principal = options.principal ?? systemPrincipal(options.organizationId, 'fixtures');
  return restrictions.create(principal, {
    facilityId: options.facilityId,
    resourceId: options.resourceId ?? undefined,
    assetId: options.assetId ?? undefined,
    taskId: options.taskId ?? undefined,
    kind: options.kind ?? 'closed',
    interval: { start: options.start, end: options.end },
    reason: options.reason ?? 'Turf repair',
    approve: true,
    resolutionMode: options.resolutionMode,
  });
}

export interface PreventiveScheduleOptions {
  organizationId: string;
  facilityId: string;
  resourceId?: string | null;
  assetId?: string | null;
  name?: string;
  recurrence: RecurrenceRule;
  localStartTime?: string;
  durationMinutes?: number;
  severity?: MaintenanceSeverity;
  requiresInspection?: boolean;
  restrictionKind?: 'closed' | 'limited';
  leadTimeDays?: number;
  principal?: Principal;
}

export async function createPreventiveSchedule(
  schedules: PreventiveSchedulesService,
  options: PreventiveScheduleOptions,
): Promise<PreventiveSchedule> {
  return schedules.create(
    options.principal ?? systemPrincipal(options.organizationId, 'fixtures'),
    {
      facilityId: options.facilityId,
      resourceId: options.resourceId ?? undefined,
      assetId: options.assetId ?? undefined,
      name: options.name ?? 'Monthly turf grooming',
      recurrence: options.recurrence,
      localStartTime: options.localStartTime ?? '06:00',
      durationMinutes: options.durationMinutes ?? 120,
      taskTemplate: {
        issue: 'Groom turf and check infill depth',
        severity: options.severity ?? 'medium',
        requiresInspection: options.requiresInspection ?? false,
        assignedOwnerPersonId: null,
      },
      restrictionKind: options.restrictionKind ?? 'closed',
      leadTimeDays: options.leadTimeDays,
    },
  );
}
