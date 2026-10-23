import { z } from '../zod';
import { CommandMetaSchema, Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant, IntervalSchema } from '../time';
import { LocalTime, RecurrenceRuleSchema, ResourceKind, ResourceStatus } from './scheduling';

/**
 * Facilities API contract (specification §3.17 SPK-FAC-001..005, §4.4 Facilities, §4.8
 * `POST /v1/maintenance-restrictions`, SPK-AT-021). Organization scope always comes from the
 * principal; facility ids in bodies are validated against it.
 */

// ---------------------------------------------------------------------------------------------
// Enumerations (mirrored by the database check constraints in migration 0900)
// ---------------------------------------------------------------------------------------------

export const AssetKind = z.enum([
  'turf',
  'goal',
  'net',
  'boards',
  'divider',
  'lighting',
  'scoreboard',
  'equipment',
  'other',
]);
export type AssetKind = z.infer<typeof AssetKind>;
export const AssetStatus = z.enum(['in_service', 'restricted', 'out_of_service', 'retired']);
export type AssetStatus = z.infer<typeof AssetStatus>;
export const MaintenanceSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type MaintenanceSeverity = z.infer<typeof MaintenanceSeverity>;
export const MaintenanceTaskStatus = z.enum([
  'open',
  'assigned',
  'in_progress',
  'resolved',
  'closed',
]);
export type MaintenanceTaskStatus = z.infer<typeof MaintenanceTaskStatus>;
export const InspectionOutcome = z.enum(['passed', 'failed']);
export type InspectionOutcome = z.infer<typeof InspectionOutcome>;
export const RestrictionKind = z.enum(['closed', 'limited']);
export type RestrictionKind = z.infer<typeof RestrictionKind>;
export const RestrictionStatus = z.enum(['proposed', 'approved', 'active', 'released']);
export type RestrictionStatus = z.infer<typeof RestrictionStatus>;
export const PreventiveScheduleStatus = z.enum(['active', 'paused', 'ended']);
export type PreventiveScheduleStatus = z.infer<typeof PreventiveScheduleStatus>;
export const OperatingStatus = z.enum(['in_service', 'restricted']);
export type OperatingStatus = z.infer<typeof OperatingStatus>;

/** Actor snapshot recorded on reports, approvals, inspections and releases (never child information). */
export const ActorSnapshotSchema = z
  .object({
    kind: z.string(),
    accountId: z.uuid().nullable(),
    personId: z.uuid().nullable(),
    staffRoles: z.array(z.string()).optional(),
    sessionId: z.string().nullable().optional(),
    actorLabel: z.string(),
  })
  .openapi('ActorSnapshot');
export type ActorSnapshot = z.infer<typeof ActorSnapshotSchema>;

/** Supporting evidence is stored by reference only (storage keys, links); never binary content (SPK-FAC-002). */
export const EvidenceReferenceSchema = z
  .object({
    kind: z.enum(['photo', 'document', 'link', 'note']),
    reference: z.string().min(1).max(2000),
    label: z.string().max(200).optional(),
    recordedAt: Instant.optional(),
  })
  .openapi('EvidenceReference');
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

// ---------------------------------------------------------------------------------------------
// Assets (SPK-FAC-001)
// ---------------------------------------------------------------------------------------------

export const AssetSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    kind: AssetKind,
    name: z.string(),
    identifier: z.string().nullable(),
    attributes: z.record(z.string(), z.unknown()),
    status: AssetStatus,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Asset');
export type Asset = z.infer<typeof AssetSchema>;

export const CreateAssetBody = withCommandMeta({
  facilityId: z.uuid(),
  /** The scheduling resource (space) the asset belongs to, when it is part of one. */
  resourceId: z.uuid().optional(),
  kind: AssetKind,
  name: z.string().min(1).max(200),
  identifier: z.string().min(1).max(100).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  status: AssetStatus.exclude(['retired']).optional(),
}).openapi('CreateAssetBody');
export type CreateAssetBody = z.infer<typeof CreateAssetBody>;

export const UpdateAssetBody = withCommandMeta({
  resourceId: z.uuid().nullable().optional(),
  kind: AssetKind.optional(),
  name: z.string().min(1).max(200).optional(),
  identifier: z.string().min(1).max(100).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  status: AssetStatus.optional(),
}).openapi('UpdateAssetBody');
export type UpdateAssetBody = z.infer<typeof UpdateAssetBody>;

export const RetireAssetBody = withCommandMeta({}).openapi('RetireAssetBody');
export type RetireAssetBody = z.infer<typeof RetireAssetBody>;

export const ListAssetsQuery = z.object({
  facilityId: z.uuid(),
  resourceId: z.uuid().optional(),
  kind: AssetKind.optional(),
  status: AssetStatus.optional(),
  includeRetired: z.coerce.boolean().optional(),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuery>;

// ---------------------------------------------------------------------------------------------
// Maintenance tasks and inspections (SPK-FAC-002, SPK-FAC-004)
// ---------------------------------------------------------------------------------------------

export const TaskResolutionSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    evidence: z.array(EvidenceReferenceSchema).max(50).optional(),
    resolvedBy: ActorSnapshotSchema.optional(),
    resolvedAt: Instant.optional(),
  })
  .openapi('TaskResolution');
export type TaskResolution = z.infer<typeof TaskResolutionSchema>;

export const InspectionSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    inspector: ActorSnapshotSchema,
    outcome: InspectionOutcome,
    notes: z.string().nullable(),
    inspectedAt: Instant,
    createdAt: Instant,
  })
  .openapi('Inspection');
export type Inspection = z.infer<typeof InspectionSchema>;

export const MaintenanceTaskSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    assetId: z.uuid().nullable(),
    resourceId: z.uuid().nullable(),
    issue: z.string(),
    severity: MaintenanceSeverity,
    reporter: ActorSnapshotSchema,
    reportedAt: Instant,
    evidence: z.array(EvidenceReferenceSchema),
    assignedOwnerPersonId: z.uuid().nullable(),
    dueAt: Instant.nullable(),
    status: MaintenanceTaskStatus,
    requiresInspection: z.boolean(),
    resolution: TaskResolutionSchema.nullable(),
    resolvedAt: Instant.nullable(),
    closedAt: Instant.nullable(),
    preventiveScheduleId: z.uuid().nullable(),
    occurrenceIndex: z.number().int().nullable(),
    /** The most recent inspection, when any (SPK-FAC-004 decides on the latest outcome). */
    latestInspection: InspectionSchema.nullable(),
    /** Operating restrictions of this task that have not been released (never reopened silently). */
    openRestrictionIds: z.array(z.uuid()),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('MaintenanceTask');
export type MaintenanceTask = z.infer<typeof MaintenanceTaskSchema>;

export const ReportMaintenanceTaskBody = withCommandMeta({
  facilityId: z.uuid(),
  /** An asset or a space is required (SPK-FAC-002 "asset or space"). */
  assetId: z.uuid().optional(),
  resourceId: z.uuid().optional(),
  issue: z.string().min(1).max(4000),
  severity: MaintenanceSeverity,
  evidence: z.array(EvidenceReferenceSchema).max(50).optional(),
  /** Omitted: the proposed default lead time for the severity applies (pending operations decision). */
  dueAt: Instant.optional(),
  requiresInspection: z.boolean().optional(),
})
  .refine((b) => b.assetId !== undefined || b.resourceId !== undefined, {
    message: 'assetId or resourceId is required',
    path: ['assetId'],
  })
  .openapi('ReportMaintenanceTaskBody');
export type ReportMaintenanceTaskBody = z.infer<typeof ReportMaintenanceTaskBody>;

/**
 * Field edits and lifecycle transitions of a task. `assignedOwnerPersonId` assigns (or, with null,
 * unassigns); `status` requests a transition (in_progress, resolved, closed); resolved/closed need a
 * resolution. Closing never releases an operating restriction (SPK-FAC-004): see /release.
 */
export const UpdateMaintenanceTaskBody = withCommandMeta({
  issue: z.string().min(1).max(4000).optional(),
  severity: MaintenanceSeverity.optional(),
  evidence: z.array(EvidenceReferenceSchema).max(50).optional(),
  assignedOwnerPersonId: z.uuid().nullable().optional(),
  dueAt: Instant.nullable().optional(),
  requiresInspection: z.boolean().optional(),
  status: MaintenanceTaskStatus.extract(['in_progress', 'resolved', 'closed']).optional(),
  resolution: TaskResolutionSchema.pick({ summary: true, evidence: true }).optional(),
}).openapi('UpdateMaintenanceTaskBody');
export type UpdateMaintenanceTaskBody = z.infer<typeof UpdateMaintenanceTaskBody>;

export const RecordInspectionBody = withCommandMeta({
  outcome: InspectionOutcome,
  notes: z.string().max(4000).optional(),
  /** Defaults to now. */
  inspectedAt: Instant.optional(),
}).openapi('RecordInspectionBody');
export type RecordInspectionBody = z.infer<typeof RecordInspectionBody>;

export const ListMaintenanceTasksQuery = PageRequestSchema.extend({
  facilityId: z.uuid(),
  status: MaintenanceTaskStatus.optional(),
  severity: MaintenanceSeverity.optional(),
  assetId: z.uuid().optional(),
  resourceId: z.uuid().optional(),
  assignedOwnerPersonId: z.uuid().optional(),
  /** Only tasks whose due instant is in the past and that are not resolved or closed. */
  overdue: z.coerce.boolean().optional(),
});
export type ListMaintenanceTasksQuery = z.infer<typeof ListMaintenanceTasksQuery>;

// ---------------------------------------------------------------------------------------------
// Operating restrictions (SPK-FAC-003/004, SPK-AT-021)
// ---------------------------------------------------------------------------------------------

export const RestrictionSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    /** The affected physical area: a whole pitch blocks every subdivision, a subdivision only itself. */
    resourceId: z.uuid(),
    assetId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
    preventiveScheduleId: z.uuid().nullable(),
    occurrenceIndex: z.number().int().nullable(),
    kind: RestrictionKind,
    interval: IntervalSchema,
    reason: z.string(),
    /** Conflict units blocked by the restriction, derived from scheduling when it was activated. */
    affectedConflictUnitIds: z.array(z.uuid()),
    status: RestrictionStatus,
    approvedBy: ActorSnapshotSchema.nullable(),
    approvedAt: Instant.nullable(),
    schedulingClosureId: z.uuid().nullable(),
    releasedBy: ActorSnapshotSchema.nullable(),
    releasedAt: Instant.nullable(),
    releaseReason: z.string().nullable(),
    /** The last approve/release operation (readable at GET /v1/operations/{id}). */
    operationId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Restriction');
export type Restriction = z.infer<typeof RestrictionSchema>;

export const ClosureResolutionModeForRestriction = z.enum([
  'cancel_affected',
  'leave_for_resolution',
]);

/**
 * `reason` is the restriction's own reason (required) and is reused as the command reason.
 * With `approve` (default true) the restriction is approved and made effective in the same request:
 * the scheduling closure is created and applied through the scheduling authority (SPK-FAC-003).
 */
export const CreateRestrictionBody = z
  .object({
    ...CommandMetaSchema.shape,
    facilityId: z.uuid(),
    /** The affected area; required unless an asset attached to a space is given. */
    resourceId: z.uuid().optional(),
    assetId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    kind: RestrictionKind,
    interval: IntervalSchema,
    reason: z.string().min(1).max(2000),
    approve: z.boolean().default(true),
    /** How already-booked events in the interval are handled when the closure is applied (default: left for staff resolution). */
    resolutionMode: ClosureResolutionModeForRestriction.optional(),
  })
  .refine((b) => b.resourceId !== undefined || b.assetId !== undefined, {
    message: 'resourceId or assetId is required',
    path: ['resourceId'],
  })
  .openapi('CreateRestrictionBody');
export type CreateRestrictionBody = z.infer<typeof CreateRestrictionBody>;

export const ApproveRestrictionBody = withCommandMeta({
  resolutionMode: ClosureResolutionModeForRestriction.optional(),
}).openapi('ApproveRestrictionBody');
export type ApproveRestrictionBody = z.infer<typeof ApproveRestrictionBody>;

/** `reason` is the release reason (required): a release is an authorized, explained act (SPK-FAC-004). */
export const ReleaseRestrictionBody = z
  .object({ ...CommandMetaSchema.shape, reason: z.string().min(1).max(2000) })
  .openapi('ReleaseRestrictionBody');
export type ReleaseRestrictionBody = z.infer<typeof ReleaseRestrictionBody>;

export const ListRestrictionsQuery = z.object({
  facilityId: z.uuid(),
  status: RestrictionStatus.optional(),
  resourceId: z.uuid().optional(),
  taskId: z.uuid().optional(),
});
export type ListRestrictionsQuery = z.infer<typeof ListRestrictionsQuery>;

export const ResourceOperatingStatusSchema = z
  .object({
    resourceId: z.uuid(),
    name: z.string(),
    kind: ResourceKind,
    parentResourceId: z.uuid().nullable(),
    /** The scheduling inventory status (long-term), distinct from time-bound restrictions. */
    inventoryStatus: ResourceStatus,
    conflictUnitIds: z.array(z.uuid()),
    status: OperatingStatus,
    restrictions: z.array(
      z.object({
        restrictionId: z.uuid(),
        kind: RestrictionKind,
        reason: z.string(),
        interval: IntervalSchema,
        taskId: z.uuid().nullable(),
        resourceId: z.uuid(),
        affectedConflictUnitIds: z.array(z.uuid()),
      }),
    ),
  })
  .openapi('ResourceOperatingStatus');
export type ResourceOperatingStatus = z.infer<typeof ResourceOperatingStatusSchema>;

export const FacilityOperatingStatusSchema = z
  .object({
    facilityId: z.uuid(),
    at: Instant,
    resources: z.array(ResourceOperatingStatusSchema),
  })
  .openapi('FacilityOperatingStatus');
export type FacilityOperatingStatus = z.infer<typeof FacilityOperatingStatusSchema>;

export const OperatingStatusQuery = z.object({
  /** Instant to evaluate (default: now). */
  at: Instant.optional(),
});
export type OperatingStatusQuery = z.infer<typeof OperatingStatusQuery>;

// ---------------------------------------------------------------------------------------------
// Preventive maintenance schedules (SPK-FAC-005)
// ---------------------------------------------------------------------------------------------

export const PreventiveTaskTemplateSchema = z
  .object({
    issue: z.string().min(1).max(4000),
    severity: MaintenanceSeverity,
    requiresInspection: z.boolean().default(false),
    assignedOwnerPersonId: z.uuid().nullable().default(null),
  })
  .openapi('PreventiveTaskTemplate');
export type PreventiveTaskTemplate = z.infer<typeof PreventiveTaskTemplateSchema>;

export const PreventiveScheduleSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid(),
    assetId: z.uuid().nullable(),
    name: z.string(),
    recurrence: RecurrenceRuleSchema,
    localStartTime: LocalTime,
    durationMinutes: z.number().int(),
    timezone: z.string(),
    taskTemplate: PreventiveTaskTemplateSchema,
    restrictionKind: RestrictionKind,
    leadTimeDays: z.number().int(),
    status: PreventiveScheduleStatus,
    lastGeneratedAt: Instant.nullable(),
    lastGeneratedThrough: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PreventiveSchedule');
export type PreventiveSchedule = z.infer<typeof PreventiveScheduleSchema>;

export const CreatePreventiveScheduleBody = withCommandMeta({
  facilityId: z.uuid(),
  resourceId: z.uuid().optional(),
  assetId: z.uuid().optional(),
  name: z.string().min(1).max(200),
  recurrence: RecurrenceRuleSchema,
  localStartTime: LocalTime,
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60),
  taskTemplate: PreventiveTaskTemplateSchema,
  restrictionKind: RestrictionKind.default('closed'),
  /** Days ahead for which tasks and restrictions are materialized (default from policy). */
  leadTimeDays: z.number().int().min(0).max(366).optional(),
})
  .refine((b) => b.resourceId !== undefined || b.assetId !== undefined, {
    message: 'resourceId or assetId is required',
    path: ['resourceId'],
  })
  .openapi('CreatePreventiveScheduleBody');
export type CreatePreventiveScheduleBody = z.infer<typeof CreatePreventiveScheduleBody>;

export const UpdatePreventiveScheduleBody = withCommandMeta({
  name: z.string().min(1).max(200).optional(),
  taskTemplate: PreventiveTaskTemplateSchema.optional(),
  restrictionKind: RestrictionKind.optional(),
  leadTimeDays: z.number().int().min(0).max(366).optional(),
  status: PreventiveScheduleStatus.optional(),
}).openapi('UpdatePreventiveScheduleBody');
export type UpdatePreventiveScheduleBody = z.infer<typeof UpdatePreventiveScheduleBody>;

export const GeneratePreventiveOccurrencesBody = withCommandMeta({
  /** Materialize occurrences starting up to this instant (default: now + lead time). */
  through: Instant.optional(),
  resolutionMode: ClosureResolutionModeForRestriction.optional(),
}).openapi('GeneratePreventiveOccurrencesBody');
export type GeneratePreventiveOccurrencesBody = z.infer<typeof GeneratePreventiveOccurrencesBody>;

export const PreventiveGenerationResultSchema = z
  .object({
    scheduleId: z.uuid(),
    operationId: z.uuid(),
    horizon: Instant,
    generated: z.array(
      z.object({
        occurrenceIndex: z.number().int(),
        interval: IntervalSchema,
        taskId: z.uuid(),
        restrictionId: z.uuid(),
      }),
    ),
    /** Occurrences inside the horizon that were materialized by an earlier run. */
    alreadyGeneratedOccurrenceIndexes: z.array(z.number().int()),
  })
  .openapi('PreventiveGenerationResult');
export type PreventiveGenerationResult = z.infer<typeof PreventiveGenerationResultSchema>;

export const ListPreventiveSchedulesQuery = z.object({
  facilityId: z.uuid(),
  status: PreventiveScheduleStatus.optional(),
});
export type ListPreventiveSchedulesQuery = z.infer<typeof ListPreventiveSchedulesQuery>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Facilities';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().min(8).max(128),
});

function command(
  method: 'post' | 'patch' | 'delete',
  path: string,
  summary: string,
  body: z.ZodType | null,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
      422: err('Eligibility failed (for example an inspection is still required)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  'post',
  '/assets',
  'Register a maintainable asset (SPK-FAC-001)',
  CreateAssetBody,
  AssetSchema,
);
query('/assets', 'List facility assets', ListAssetsQuery, z.array(AssetSchema));
query('/assets/{id}', 'Read an asset', null, AssetSchema);
command('patch', '/assets/{id}', 'Update an asset', UpdateAssetBody, AssetSchema, 200);
command(
  'delete',
  '/assets/{id}',
  'Retire an asset (kept for history)',
  RetireAssetBody,
  AssetSchema,
  200,
);

command(
  'post',
  '/maintenance-tasks',
  'Report a maintenance issue (SPK-FAC-002); any staff may report',
  ReportMaintenanceTaskBody,
  MaintenanceTaskSchema,
);
query(
  '/maintenance-tasks',
  'List maintenance tasks',
  ListMaintenanceTasksQuery,
  pageSchema(MaintenanceTaskSchema),
);
query('/maintenance-tasks/{id}', 'Read a maintenance task', null, MaintenanceTaskSchema);
command(
  'patch',
  '/maintenance-tasks/{id}',
  'Assign, edit, start, resolve or close a maintenance task (SPK-FAC-002/004)',
  UpdateMaintenanceTaskBody,
  MaintenanceTaskSchema,
  200,
);
command(
  'post',
  '/maintenance-tasks/{id}/inspections',
  'Record an inspection outcome (SPK-FAC-002/004)',
  RecordInspectionBody,
  InspectionSchema,
);
query(
  '/maintenance-tasks/{id}/inspections',
  'List the inspections of a task (append-only)',
  null,
  z.array(InspectionSchema),
);

command(
  'post',
  '/maintenance-restrictions',
  'Apply an approved operating restriction: a scheduling closure on the affected area (SPK-FAC-003, SPK-AT-021)',
  CreateRestrictionBody,
  RestrictionSchema,
);
query(
  '/maintenance-restrictions',
  'List restrictions',
  ListRestrictionsQuery,
  z.array(RestrictionSchema),
);
query('/maintenance-restrictions/{id}', 'Read a restriction', null, RestrictionSchema);
command(
  'post',
  '/maintenance-restrictions/{id}/approve',
  'Approve a proposed restriction and make it effective through the scheduling authority (SPK-FAC-003)',
  ApproveRestrictionBody,
  RestrictionSchema,
  200,
);
command(
  'post',
  '/maintenance-restrictions/{id}/release',
  'Authorized release: return the area to service by lifting the closure (SPK-FAC-004)',
  ReleaseRestrictionBody,
  RestrictionSchema,
  200,
);
query(
  '/facilities/{id}/operating-status',
  'Operating status per resource: in service, or restricted with reasons and intervals',
  OperatingStatusQuery,
  FacilityOperatingStatusSchema,
);

command(
  'post',
  '/preventive-schedules',
  'Create a preventive maintenance schedule (SPK-FAC-005)',
  CreatePreventiveScheduleBody,
  PreventiveScheduleSchema,
);
query(
  '/preventive-schedules',
  'List preventive schedules',
  ListPreventiveSchedulesQuery,
  z.array(PreventiveScheduleSchema),
);
query('/preventive-schedules/{id}', 'Read a preventive schedule', null, PreventiveScheduleSchema);
command(
  'patch',
  '/preventive-schedules/{id}',
  'Update, pause, resume or end a preventive schedule',
  UpdatePreventiveScheduleBody,
  PreventiveScheduleSchema,
  200,
);
command(
  'post',
  '/preventive-schedules/{id}/generate',
  'Materialize due occurrences as tasks and future restrictions through the scheduling authority (SPK-FAC-005)',
  GeneratePreventiveOccurrencesBody,
  PreventiveGenerationResultSchema,
  200,
);
