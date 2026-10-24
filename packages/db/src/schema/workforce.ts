import type { ColumnType, Generated } from 'kysely';
import type { GeneratedTimestamp, Json, MinorUnits, NullableTimestamp, Timestamp } from './core';

/**
 * Workforce module tables (migration 0700, specification §3.10 SPK-STAFF-001..006, §4.4
 * Workforce, §4.6 Assignment machine). Generated range columns (`during`, `committed`) are
 * computed by PostgreSQL from the instants next to them and are never written by the application.
 */

/** A stored generated column: readable (as range text), never inserted or updated. */
export type GeneratedRange = ColumnType<string, never, never>;

export type AvailabilityKind = 'available' | 'unavailable';
export type AvailabilityStatus = 'active' | 'withdrawn';
export interface AvailabilityTable {
  id: string;
  organization_id: string;
  person_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  during: GeneratedRange;
  kind: AvailabilityKind;
  note: string | null;
  status: Generated<AvailabilityStatus>;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type QualificationStatus = 'pending_verification' | 'verified' | 'rejected' | 'revoked';
export interface QualificationsTable {
  id: string;
  organization_id: string;
  person_id: string;
  kind: string;
  level: string | null;
  evidence_reference: string | null;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  status: Generated<QualificationStatus>;
  verified_by: Json<Record<string, unknown>> | null;
  verified_by_person_id: string | null;
  verified_at: NullableTimestamp;
  status_reason: string | null;
  status_changed_at: NullableTimestamp;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AssignmentKind = 'official' | 'coach' | 'supervisor' | 'organizer';
export type AssignmentTargetType = 'fixture' | 'event' | 'session';

export interface AssignmentRequirementsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  target_type: AssignmentTargetType;
  target_id: string;
  fixture_id: string | null;
  scheduling_event_id: string | null;
  offering_session_id: string | null;
  offering_id: string | null;
  kind: AssignmentKind;
  role: string;
  required_count: number;
  must_be_accepted: Generated<boolean>;
  required_qualifications: Generated<string[]>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AssignmentStatusValue =
  'proposed' | 'offered' | 'accepted' | 'declined' | 'withdrawn' | 'completed';
export type AssignmentEngagement = 'regular' | 'temporary' | 'substitute';
export type AssignmentAccessStatus = 'not_applicable' | 'pending' | 'granted' | 'failed' | 'ended';

export interface AssignmentsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  person_id: string;
  kind: AssignmentKind;
  target_type: AssignmentTargetType;
  target_id: string;
  fixture_id: string | null;
  scheduling_event_id: string | null;
  offering_session_id: string | null;
  offering_id: string | null;
  target_title: string;
  role: string;
  slot: Generated<number>;
  engagement: Generated<AssignmentEngagement>;
  status: Generated<AssignmentStatusValue>;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  turnaround_minutes: Generated<number>;
  committed_end: Timestamp;
  committed: GeneratedRange;
  replaces_assignment_id: string | null;
  offered_at: NullableTimestamp;
  responded_at: NullableTimestamp;
  accepted_at: NullableTimestamp;
  declined_at: NullableTimestamp;
  decline_reason: string | null;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  withdrawn_by: Json<Record<string, unknown>> | null;
  completed_at: NullableTimestamp;
  completed_by: Json<Record<string, unknown>> | null;
  access_status: Generated<AssignmentAccessStatus>;
  access_membership_id: string | null;
  access_from: NullableTimestamp;
  access_until: NullableTimestamp;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FeeExportBatchesTable {
  id: string;
  organization_id: string;
  currency: string;
  submission_count: number;
  total_minor: MinorUnits;
  lines: Json<Array<Record<string, unknown>>>;
  note: string | null;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  operation_id: string | null;
  created_at: GeneratedTimestamp;
}

export type FeeSubmissionStatus = 'submitted' | 'approved' | 'adjusted' | 'rejected' | 'exported';
export interface FeeSubmissionsTable {
  id: string;
  organization_id: string;
  assignment_id: string;
  person_id: string;
  rate_basis: Json<Record<string, unknown>>;
  computed_amount_minor: MinorUnits;
  submitted_amount_minor: MinorUnits;
  currency: string;
  note: string | null;
  status: Generated<FeeSubmissionStatus>;
  submitted_by: Json<Record<string, unknown>>;
  submitted_at: Timestamp;
  approved_amount_minor: ColumnType<number | null, number | null, number | null>;
  approver: Json<Record<string, unknown>> | null;
  approver_person_id: string | null;
  approved_at: NullableTimestamp;
  rejected_at: NullableTimestamp;
  rejection_reason: string | null;
  export_batch_id: string | null;
  exported_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FeeAdjustmentsTable {
  id: string;
  organization_id: string;
  fee_submission_id: string;
  sequence: number;
  previous_amount_minor: MinorUnits;
  adjusted_amount_minor: MinorUnits;
  currency: string;
  reason: string;
  adjusted_by: Json<Record<string, unknown>>;
  adjusted_by_person_id: string | null;
  adjusted_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface WorkforceTables {
  availability: AvailabilityTable;
  qualifications: QualificationsTable;
  assignment_requirements: AssignmentRequirementsTable;
  assignments: AssignmentsTable;
  fee_export_batches: FeeExportBatchesTable;
  fee_submissions: FeeSubmissionsTable;
  fee_adjustments: FeeAdjustmentsTable;
}
