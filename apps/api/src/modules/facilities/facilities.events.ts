import { defineEvent, z } from '@sportspark/contracts';

/**
 * Facilities domain events (§4.12). Restriction events carry the affected conflict units so
 * reporting and communications can explain exactly which area is blocked (SPK-FAC-003).
 */

const Severity = z.enum(['low', 'medium', 'high', 'critical']);
const Interval = z.object({ start: z.string(), end: z.string() });

export const MaintenanceTaskReported = defineEvent(
  'facilities.maintenance_task_reported',
  z.object({
    taskId: z.uuid(),
    facilityId: z.uuid(),
    assetId: z.uuid().nullable(),
    resourceId: z.uuid().nullable(),
    severity: Severity,
    issue: z.string(),
    dueAt: z.string().nullable(),
    requiresInspection: z.boolean(),
    preventiveScheduleId: z.uuid().nullable(),
  }),
);

export const MaintenanceTaskChange = z.enum([
  'assigned',
  'unassigned',
  'started',
  'resolved',
  'closed',
  'reopened',
  'updated',
]);
export type MaintenanceTaskChange = z.infer<typeof MaintenanceTaskChange>;

export const MaintenanceTaskUpdated = defineEvent(
  'facilities.maintenance_task_updated',
  z.object({
    taskId: z.uuid(),
    facilityId: z.uuid(),
    changes: z.array(MaintenanceTaskChange),
    status: z.enum(['open', 'assigned', 'in_progress', 'resolved', 'closed']),
    severity: Severity,
    assignedOwnerPersonId: z.uuid().nullable(),
    dueAt: z.string().nullable(),
    /** Restrictions still in force after the change: closing never reopens a space (SPK-FAC-004). */
    openRestrictionIds: z.array(z.uuid()),
  }),
);

export const InspectionRecorded = defineEvent(
  'facilities.inspection_recorded',
  z.object({
    inspectionId: z.uuid(),
    taskId: z.uuid(),
    facilityId: z.uuid(),
    outcome: z.enum(['passed', 'failed']),
    inspectedAt: z.string(),
    taskStatus: z.enum(['open', 'assigned', 'in_progress', 'resolved', 'closed']),
  }),
);

export const RestrictionActivated = defineEvent(
  'facilities.restriction_activated',
  z.object({
    restrictionId: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid(),
    assetId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
    kind: z.enum(['closed', 'limited']),
    interval: Interval,
    reason: z.string(),
    affectedConflictUnitIds: z.array(z.uuid()),
    schedulingClosureId: z.uuid(),
  }),
);

export const RestrictionReleased = defineEvent(
  'facilities.restriction_released',
  z.object({
    restrictionId: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid(),
    assetId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
    interval: Interval,
    reason: z.string(),
    affectedConflictUnitIds: z.array(z.uuid()),
    schedulingClosureId: z.uuid(),
  }),
);

/** Internal timer: enqueued with `availableAt = dueAt` so an overdue critical task is escalated (dedupe per task). */
export const MaintenanceTaskDueReached = defineEvent(
  'facilities.maintenance_task_due_reached',
  z.object({ taskId: z.uuid(), facilityId: z.uuid(), dueAt: z.string() }),
);

export const PreventiveOccurrencesGenerated = defineEvent(
  'facilities.preventive_occurrences_generated',
  z.object({
    scheduleId: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid(),
    horizon: z.string(),
    generated: z.array(
      z.object({
        occurrenceIndex: z.number().int(),
        taskId: z.uuid(),
        restrictionId: z.uuid(),
        interval: Interval,
      }),
    ),
  }),
);

export const FacilitiesEvents = {
  MaintenanceTaskReported,
  MaintenanceTaskUpdated,
  InspectionRecorded,
  RestrictionActivated,
  RestrictionReleased,
  MaintenanceTaskDueReached,
  PreventiveOccurrencesGenerated,
};
