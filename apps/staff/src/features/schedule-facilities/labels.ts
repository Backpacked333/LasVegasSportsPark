/**
 * Staff status labels for scheduling and facilities records (docs/package-a/journeys.md section 3,
 * rule 4: staff labels use the machine state names verbatim; SPK-UX-009: every status is a glyph
 * and text through `StatusBadge`, never colour alone). The states mirror the API's enumerations
 * (`packages/contracts/src/api/scheduling.ts`, `facilities.ts`).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export interface Badge {
  tone: StatusTone;
  label: string;
}

type DraftStatus = Schema<'ScheduleDraft'>['status'];
type EventStatus = Schema<'Event'>['status'];
type ClosureStatus = Schema<'Closure'>['status'];
type RestrictionStatus = Schema<'Restriction'>['status'];
type TaskStatus = Schema<'MaintenanceTask'>['status'];
type Severity = Schema<'MaintenanceTask'>['severity'];
type AssetStatus = Schema<'Asset'>['status'];
type ResourceStatus = Schema<'Resource'>['status'];
type OperationStatus = Schema<'Operation'>['status'];
type PreventiveStatus = Schema<'PreventiveSchedule'>['status'];

/** "Draft (autosaved <time>)", "Validation failed", "Published" (journeys.md section 3). */
export function draftBadge(status: DraftStatus, savedAt?: string): Badge {
  switch (status) {
    case 'editing':
      return {
        tone: 'info',
        label: `editing: Draft${savedAt ? ` (autosaved ${savedAt})` : ''}`,
      };
    case 'validated':
      return { tone: 'success', label: 'validated: Validation passed' };
    case 'publishing':
      return { tone: 'pending', label: 'publishing: Publication in progress' };
    case 'published':
      return { tone: 'success', label: 'published' };
    case 'failed':
      return { tone: 'danger', label: 'failed: Validation failed' };
    case 'discarded':
      return { tone: 'neutral', label: 'discarded' };
  }
}

export function eventBadge(status: EventStatus, publishedRevision?: number | null): Badge {
  switch (status) {
    case 'draft':
      return { tone: 'pending', label: 'draft: not published' };
    case 'published':
      return {
        tone: 'success',
        label: `published${publishedRevision ? `: revision ${publishedRevision}` : ''}`,
      };
    case 'canceled':
      return { tone: 'neutral', label: 'canceled' };
  }
}

export const CLOSURE_BADGE: Record<ClosureStatus, Badge> = {
  pending: { tone: 'pending', label: 'pending: impact preview, not applied' },
  active: { tone: 'danger', label: 'active: space closed' },
  lifted: { tone: 'neutral', label: 'lifted' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

export const RESTRICTION_BADGE: Record<RestrictionStatus, Badge> = {
  proposed: { tone: 'pending', label: 'proposed: awaiting approval' },
  approved: { tone: 'warning', label: 'approved: activation not complete' },
  active: { tone: 'danger', label: 'active: area restricted' },
  released: { tone: 'success', label: 'released: returned to service' },
};

export const TASK_BADGE: Record<TaskStatus, Badge> = {
  open: { tone: 'warning', label: 'open' },
  assigned: { tone: 'info', label: 'assigned' },
  in_progress: { tone: 'info', label: 'in_progress' },
  resolved: { tone: 'success', label: 'resolved' },
  closed: { tone: 'neutral', label: 'closed' },
};

export const SEVERITY_BADGE: Record<Severity, Badge> = {
  low: { tone: 'neutral', label: 'Severity: low' },
  medium: { tone: 'info', label: 'Severity: medium' },
  high: { tone: 'warning', label: 'Severity: high' },
  critical: { tone: 'danger', label: 'Severity: critical' },
};

export const ASSET_BADGE: Record<AssetStatus, Badge> = {
  in_service: { tone: 'success', label: 'in_service' },
  restricted: { tone: 'warning', label: 'restricted' },
  out_of_service: { tone: 'danger', label: 'out_of_service' },
  retired: { tone: 'neutral', label: 'retired' },
};

export const RESOURCE_BADGE: Record<ResourceStatus, Badge> = {
  active: { tone: 'success', label: 'active' },
  restricted: { tone: 'warning', label: 'restricted' },
  closed: { tone: 'danger', label: 'closed' },
};

/** Operation labels: machine state plus the shared phrase ("Processing", "Done", "Needs attention"). */
export const OPERATION_BADGE: Record<OperationStatus, Badge> = {
  pending: { tone: 'pending', label: 'Operation pending: Processing' },
  running: { tone: 'pending', label: 'Operation running: Processing' },
  succeeded: { tone: 'success', label: 'Operation succeeded: Done' },
  failed: { tone: 'danger', label: 'Operation failed: Failed' },
  recovery_required: { tone: 'danger', label: 'Operation recovery_required: Needs attention' },
  compensated: { tone: 'neutral', label: 'Operation compensated' },
};

export const PREVENTIVE_BADGE: Record<PreventiveStatus, Badge> = {
  active: { tone: 'success', label: 'active' },
  paused: { tone: 'warning', label: 'paused' },
  ended: { tone: 'neutral', label: 'ended' },
};

export const EVENT_KIND_LABEL: Record<Schema<'Event'>['kind'], string> = {
  game: 'Game',
  practice: 'Practice',
  session: 'Program session',
  rental: 'Rental',
  party: 'Party',
  pickup: 'Pickup session',
  maintenance: 'Maintenance',
  block: 'Block',
};

export const RESOURCE_KIND_LABEL: Record<Schema<'Resource'>['kind'], string> = {
  pitch: 'Pitch',
  subdivision: 'Subdivision',
  room: 'Room',
  other: 'Other space',
};

export const ASSET_KIND_LABEL: Record<Schema<'Asset'>['kind'], string> = {
  turf: 'Turf area',
  goal: 'Goal',
  net: 'Net',
  boards: 'Boards',
  divider: 'Divider',
  lighting: 'Lighting',
  scoreboard: 'Scoreboard',
  equipment: 'Equipment',
  other: 'Other',
};

export const WEEKDAY_LABEL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
