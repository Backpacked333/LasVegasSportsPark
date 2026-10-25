import type { ColumnType, Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Entry module tables (migration 0800, specification §3.14 SPK-ENTRY-001..008, §4.4 Arrival,
 * §4.15 offline behaviour). Attendance observations, departures, release records, offline batches
 * and occupancy snapshots are append-only (the database refuses UPDATE and DELETE).
 */

/** A text[] column written as a plain array (PostgreSQL arrays round-trip through both drivers). */
export type TextArray<T extends string = string> = ColumnType<T[], T[] | undefined, T[]>;
export type UuidArray = ColumnType<string[], string[] | undefined, string[]>;

export type PassHolderKind = 'person' | 'household';
export type PassStatus = 'active' | 'revoked';
export interface PassesTable {
  id: string;
  organization_id: string;
  holder_kind: PassHolderKind;
  holder_person_id: string | null;
  holder_household_id: string | null;
  reference_hash: string;
  status: Generated<PassStatus>;
  issued_at: Timestamp;
  issued_by: Json<Record<string, unknown>>;
  issued_by_person_id: string | null;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OfflineSyncBatchesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  device_id: string;
  client_batch_id: string;
  snapshot_reference: string;
  snapshot_taken_at: Timestamp;
  received_at: Timestamp;
  snapshot_age_seconds: number;
  max_roster_age_minutes: number;
  item_count: number;
  accepted_count: number;
  conflict_count: number;
  duplicate_count: number;
  rejected_count: number;
  stale_count: number;
  stale: boolean;
  results: Json<unknown[]>;
  exception_ids: UuidArray;
  /** SHA-256 of the canonical request (facility, snapshot, items); null for batches before 0801. */
  request_fingerprint: ColumnType<string | null, string | null | undefined, string | null>;
  operation_id: string | null;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  created_at: GeneratedTimestamp;
}

export type VisitorCategoryValue =
  'participant' | 'guardian' | 'spectator' | 'staff' | 'contractor' | 'unclassified';
export type VisitSource = 'desk' | 'offline_sync' | 'access_control';
export type VisitStatus = 'on_site' | 'departed' | 'voided';
export interface VisitsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  person_id: string | null;
  visitor_description: string | null;
  party_size: Generated<number>;
  visitor_category: VisitorCategoryValue;
  arrived_at: Timestamp;
  pass_id: string | null;
  source: VisitSource;
  device_id: string | null;
  client_observation_id: string | null;
  sync_batch_id: string | null;
  access_event_ref: string | null;
  status: Generated<VisitStatus>;
  departed_at: NullableTimestamp;
  voided_at: NullableTimestamp;
  void_reason: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  received_at: Timestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ActivityTypeValue = 'session' | 'event';
export type CheckinBasisKind =
  'enrollment' | 'session_booking' | 'event_commitment' | 'roster_membership';
export type SessionCheckinStatus = 'held' | 'admitted' | 'withdrawn';
export interface SessionCheckinsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  visit_id: string | null;
  person_id: string;
  activity_type: ActivityTypeValue;
  activity_id: string;
  offering_id: string | null;
  offering_session_id: string | null;
  scheduling_event_id: string | null;
  activity_start: Timestamp;
  activity_end: Timestamp;
  basis_kind: CheckinBasisKind | null;
  enrollment_id: string | null;
  session_booking_id: string | null;
  basis_reference: string | null;
  status: SessionCheckinStatus;
  issues: Json<unknown[]>;
  checked_in_at: Timestamp;
  evaluated_at: Timestamp;
  admitted_at: NullableTimestamp;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ObservedStateValue = 'present' | 'absent' | 'late' | 'left_early';
export type ObservationSource = 'online' | 'offline_sync';
export type ObservationFlag = 'stale_snapshot' | 'conflict';
export interface AttendanceObservationsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  person_id: string;
  activity_type: ActivityTypeValue;
  activity_id: string;
  offering_id: string | null;
  offering_session_id: string | null;
  scheduling_event_id: string | null;
  observed_state: ObservedStateValue;
  observed_at: Timestamp;
  received_at: Timestamp;
  source: ObservationSource;
  device_id: string | null;
  client_observation_id: string | null;
  sync_batch_id: string | null;
  snapshot_reference: string | null;
  snapshot_taken_at: NullableTimestamp;
  flags: TextArray<ObservationFlag>;
  corrects_observation_id: string | null;
  correction_reason: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  created_at: GeneratedTimestamp;
}

export type ReleaseVerificationMethod = 'online_relationship_check' | 'manual_outage_procedure';
export type ReleaseVerificationOutcome =
  'verified' | 'denied' | 'escalated' | 'manual_outage_procedure';
export type ReleaseOutcomeValue = 'released' | 'not_released';
export interface ReleaseRecordsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  child_person_id: string;
  collector_person_id: string | null;
  collector_description: string | null;
  activity_type: ActivityTypeValue | null;
  activity_id: string | null;
  offering_id: string | null;
  offering_session_id: string | null;
  scheduling_event_id: string | null;
  visit_id: string | null;
  verification_method: ReleaseVerificationMethod;
  verification_outcome: ReleaseVerificationOutcome;
  authority_basis: 'relationship_permission:collect' | null;
  authority_checked_at: Timestamp;
  collector_permissions: TextArray;
  denial_reason: string | null;
  restriction_notes: string | null;
  escalation_notes: string | null;
  escalation_exception_id: string | null;
  manual_procedure_reference: string | null;
  post_sync_authority: 'held' | 'not_held' | null;
  outcome: ReleaseOutcomeValue;
  decided_at: Timestamp;
  released_at: NullableTimestamp;
  staff_actor: Json<Record<string, unknown>>;
  staff_person_id: string | null;
  source: ObservationSource;
  device_id: string | null;
  client_observation_id: string | null;
  sync_batch_id: string | null;
  received_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type DepartureSource = 'desk' | 'offline_sync' | 'release';
export interface DeparturesTable {
  id: string;
  organization_id: string;
  facility_id: string;
  visit_id: string;
  person_id: string | null;
  departed_at: Timestamp;
  release_record_id: string | null;
  source: DepartureSource;
  device_id: string | null;
  client_observation_id: string | null;
  sync_batch_id: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  received_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface OccupancySnapshotsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  taken_at: Timestamp;
  window_start: Timestamp;
  window_end: Timestamp;
  arrivals: number;
  departures: number;
  recorded_on_site: number;
  open_from_earlier_days: number;
  reconciled: boolean;
  counted_on_site: number | null;
  verified_occupancy: number | null;
  discrepancy: number | null;
  reconciliation_note: string | null;
  taken_by: Json<Record<string, unknown>>;
  taken_by_person_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface EntryTables {
  passes: PassesTable;
  offline_sync_batches: OfflineSyncBatchesTable;
  visits: VisitsTable;
  session_checkins: SessionCheckinsTable;
  attendance_observations: AttendanceObservationsTable;
  release_records: ReleaseRecordsTable;
  departures: DeparturesTable;
  occupancy_snapshots: OccupancySnapshotsTable;
}
