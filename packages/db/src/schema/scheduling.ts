import type { ColumnType, Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Scheduling module tables (migration 0300, specification §3.7, §4.4 Scheduling, §4.7 invariant 4).
 * tstzrange columns are written with the `tstzrange()` helper and read back as text; services
 * select `lower(...)`/`upper(...)` when they need instants.
 */
export type TstzRange = ColumnType<string, string, string>;
/** PostgreSQL `time` is read as 'HH:MM:SS' and written as 'HH:MM' or 'HH:MM:SS'. */
export type LocalTime = ColumnType<string, string, string>;

export type ResourceKind = 'pitch' | 'subdivision' | 'room' | 'other';
export type ResourceStatus = 'active' | 'restricted' | 'closed';
export interface ResourcesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  kind: ResourceKind;
  name: string;
  parent_resource_id: string | null;
  dimensions: GeneratedJson<Record<string, unknown>>;
  compatible_formats: Generated<string[]>;
  default_setup_minutes: Generated<number>;
  default_cleanup_minutes: Generated<number>;
  required_equipment: GeneratedJson<unknown[]>;
  staffing_constraints: GeneratedJson<Record<string, unknown>>;
  status: Generated<ResourceStatus>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ResourceConfigurationsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  name: string;
  description: string | null;
  active: Generated<boolean>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ResourceConfigurationMembersTable {
  organization_id: string;
  configuration_id: string;
  resource_id: string;
}

export interface ConflictUnitsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  name: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ResourceConflictUnitsTable {
  organization_id: string;
  resource_id: string;
  conflict_unit_id: string;
}

export interface OperatingHoursTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string | null;
  weekday: number;
  opens_at: LocalTime;
  closes_at: LocalTime;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ClosureSource = 'manual' | 'maintenance' | 'holiday';
export type ClosureStatus = 'pending' | 'active' | 'lifted' | 'withdrawn';
export interface ClosuresTable {
  id: string;
  organization_id: string;
  facility_id: string;
  resource_id: string | null;
  during: TstzRange;
  reason: string;
  source: ClosureSource;
  status: Generated<ClosureStatus>;
  created_by: Json<Record<string, unknown>>;
  impact: Json<JsonObject> | null;
  resolution: Json<JsonObject> | null;
  applied_at: NullableTimestamp;
  lifted_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type EventKind =
  'game' | 'practice' | 'session' | 'rental' | 'party' | 'pickup' | 'maintenance' | 'block';
export type EventStatus = 'draft' | 'published' | 'canceled';
export type DstResolution = 'exact' | 'shifted_forward' | 'first' | 'second';
export type NonexistentTimePolicy = 'shift_forward' | 'skip';
export type AmbiguousTimePolicy = 'first' | 'second';
export type SeriesStatus = 'active' | 'ended';

export interface EventSeriesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  kind: EventKind;
  title: string;
  timezone: string;
  recurrence: Json<Record<string, unknown>>;
  local_start_time: LocalTime;
  duration_minutes: number;
  setup_minutes: Generated<number>;
  cleanup_minutes: Generated<number>;
  nonexistent_policy: Generated<NonexistentTimePolicy>;
  ambiguous_policy: Generated<AmbiguousTimePolicy>;
  exceptions: GeneratedJson<string[]>;
  resource_ids: Generated<string[]>;
  commitments: GeneratedJson<unknown[]>;
  source_type: string | null;
  source_id: string | null;
  status: Generated<SeriesStatus>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EventsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  kind: EventKind;
  title: string;
  format: string | null;
  series_id: string | null;
  occurrence_index: number | null;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  timezone: string;
  setup_minutes: Generated<number>;
  cleanup_minutes: Generated<number>;
  dst_resolution: Generated<DstResolution>;
  status: Generated<EventStatus>;
  published_revision: number | null;
  revision: Generated<number>;
  resource_ids: Generated<string[]>;
  commitments: GeneratedJson<unknown[]>;
  source_type: string | null;
  source_id: string | null;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ReservationStatus = 'active' | 'released';
export interface ReservationsTable {
  id: string;
  organization_id: string;
  event_id: string;
  resource_id: string;
  occupied: TstzRange;
  status: Generated<ReservationStatus>;
  released_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReservationUnitsTable {
  id: string;
  organization_id: string;
  reservation_id: string;
  event_id: string;
  conflict_unit_id: string;
  occupied: TstzRange;
  status: Generated<ReservationStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PartyType = 'team' | 'person' | 'equipment';
export interface EventCommitmentsTable {
  id: string;
  organization_id: string;
  event_id: string;
  party_type: PartyType;
  party_id: string;
  role: Generated<string>;
  occupied: TstzRange;
  status: Generated<ReservationStatus>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ScheduleDraftStatus =
  'editing' | 'validated' | 'publishing' | 'published' | 'failed' | 'discarded';
export interface ScheduleDraftsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  name: string;
  base_revision: Json<{ capturedAt: string; eventRevisions: Record<string, number> }>;
  author: Json<Record<string, unknown>>;
  status: Generated<ScheduleDraftStatus>;
  last_saved_at: GeneratedTimestamp;
  validation_results: Json<JsonObject> | null;
  validated_at: NullableTimestamp;
  published_at: NullableTimestamp;
  publication_group_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type DraftChangeKind = 'create' | 'move' | 'cancel' | 'resize' | 'resource_change';
export interface DraftChangesTable {
  id: string;
  organization_id: string;
  draft_id: string;
  sequence: number;
  kind: DraftChangeKind;
  target_event_id: string | null;
  base_event_revision: number | null;
  proposed: GeneratedJson<Record<string, unknown>>;
  proposed_resource_ids: Generated<string[]>;
  created_at: GeneratedTimestamp;
}

export interface PublicationsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  draft_id: string;
  actor: Json<Record<string, unknown>>;
  committed_at: Timestamp;
  event_ids: Generated<string[]>;
  notice_event_ids: Generated<string[]>;
  summary: GeneratedJson<Record<string, unknown>>;
  operation_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface SchedulingTables {
  resources: ResourcesTable;
  resource_configurations: ResourceConfigurationsTable;
  resource_configuration_members: ResourceConfigurationMembersTable;
  conflict_units: ConflictUnitsTable;
  resource_conflict_units: ResourceConflictUnitsTable;
  operating_hours: OperatingHoursTable;
  closures: ClosuresTable;
  event_series: EventSeriesTable;
  events: EventsTable;
  reservations: ReservationsTable;
  reservation_units: ReservationUnitsTable;
  event_commitments: EventCommitmentsTable;
  schedule_drafts: ScheduleDraftsTable;
  draft_changes: DraftChangesTable;
  publications: PublicationsTable;
}
