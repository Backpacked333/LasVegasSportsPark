import type { ColumnType, Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';
import type { LocalTime, TstzRange } from './scheduling';

/**
 * Facilities module tables (migration 0900, specification §3.17 SPK-FAC-001..005, §4.4 Facilities).
 * Restrictions reference scheduling closures by id; the closure itself is owned and written by the
 * scheduling module (SPK-FAC-003).
 */

export type AssetKind =
  | 'turf'
  | 'goal'
  | 'net'
  | 'boards'
  | 'divider'
  | 'lighting'
  | 'scoreboard'
  | 'equipment'
  | 'other';
export type AssetStatus = 'in_service' | 'restricted' | 'out_of_service' | 'retired';
export interface AssetsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string | null;
  kind: AssetKind;
  name: string;
  identifier: string | null;
  attributes: GeneratedJson<Record<string, unknown>>;
  status: Generated<AssetStatus>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PreventiveScheduleStatus = 'active' | 'paused' | 'ended';
export type RestrictionKind = 'closed' | 'limited';
export interface PreventiveSchedulesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string;
  asset_id: string | null;
  name: string;
  recurrence: Json<Record<string, unknown>>;
  local_start_time: LocalTime;
  duration_minutes: number;
  timezone: string;
  task_template: Json<Record<string, unknown>>;
  restriction_kind: RestrictionKind;
  lead_time_days: number;
  status: Generated<PreventiveScheduleStatus>;
  last_generated_at: NullableTimestamp;
  last_generated_through: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MaintenanceSeverity = 'low' | 'medium' | 'high' | 'critical';
export type MaintenanceTaskStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';
export interface MaintenanceTasksTable {
  id: string;
  organization_id: string;
  facility_id: string;
  asset_id: string | null;
  resource_id: string | null;
  issue: string;
  severity: MaintenanceSeverity;
  reporter: Json<Record<string, unknown>>;
  reported_at: Timestamp;
  evidence: GeneratedJson<unknown[]>;
  assigned_owner_person_id: string | null;
  due_at: NullableTimestamp;
  status: Generated<MaintenanceTaskStatus>;
  requires_inspection: Generated<boolean>;
  resolution: Json<JsonObject> | null;
  resolved_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  preventive_schedule_id: string | null;
  occurrence_index: number | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type InspectionOutcome = 'passed' | 'failed';
export interface InspectionsTable {
  id: string;
  organization_id: string;
  task_id: string;
  inspector: Json<Record<string, unknown>>;
  outcome: InspectionOutcome;
  notes: string | null;
  inspected_at: Timestamp;
  created_at: GeneratedTimestamp;
}

/** `withdrawn` (migration 0903, FAC-01): a proposed or approved restriction that never took effect. */
export type RestrictionStatus = 'proposed' | 'approved' | 'active' | 'released' | 'withdrawn';
export interface RestrictionsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string;
  asset_id: string | null;
  task_id: string | null;
  preventive_schedule_id: string | null;
  occurrence_index: number | null;
  kind: RestrictionKind;
  during: TstzRange;
  reason: string;
  affected_conflict_unit_ids: Generated<string[]>;
  status: Generated<RestrictionStatus>;
  approved_by: Json<Record<string, unknown>> | null;
  approved_at: NullableTimestamp;
  scheduling_closure_id: string | null;
  released_by: Json<Record<string, unknown>> | null;
  released_at: NullableTimestamp;
  release_reason: string | null;
  /** Migration 0903 (FAC-01): set exactly when the restriction is withdrawn, with actor and reason. */
  withdrawn_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  withdrawn_by: ColumnType<
    Record<string, unknown> | null,
    string | null | undefined,
    string | null
  >;
  withdrawal_reason: ColumnType<string | null, string | null | undefined, string | null>;
  operation_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FacilitiesTables {
  assets: AssetsTable;
  preventive_schedules: PreventiveSchedulesTable;
  maintenance_tasks: MaintenanceTasksTable;
  inspections: InspectionsTable;
  restrictions: RestrictionsTable;
}
