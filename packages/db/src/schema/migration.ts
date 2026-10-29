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
 * Migration module tables (migration 1200, specification §5.3..§5.8, §4.4 Migration:
 * ExternalMapping, ImportBatch, ImportException, AuthorityAssignment; §4.7 invariant 11).
 * Reconciliation discrepancies and approvals are append-only (the database refuses UPDATE and
 * DELETE); every other table refuses DELETE and guards its lifecycle with a trigger.
 */

/** The §5.3 migration inventory: one staged entity type per inventory line. */
export type ImportEntityType =
  | 'person'
  | 'household'
  | 'relationship_evidence'
  | 'account'
  | 'program'
  | 'season'
  | 'team'
  | 'roster'
  | 'future_schedule'
  | 'attendance_history'
  | 'result'
  | 'order'
  | 'open_obligation'
  | 'credit'
  | 'refund'
  | 'document'
  | 'communication_preference';

/** Entity types whose rows the module applies through the owning module's public service. */
export type MappedEntityType =
  'person' | 'household' | 'relationship_evidence' | 'program' | 'open_obligation' | 'credit';

export type ImportBatchStatus = 'received' | 'validated' | 'reviewed' | 'applied' | 'aborted';
export type ImportRowOutcome = 'created' | 'matched' | 'updated' | 'skipped' | 'exception';
export type ImportExceptionKind =
  'ambiguous_relationship' | 'ambiguous_balance' | 'conflict' | 'validation';
export type ImportExceptionStatus = 'open' | 'decided' | 'withdrawn';
export type ImportExceptionDecision = 'accept' | 'reject' | 'defer';
export type AuthoritativeSystem = 'legacy' | 'sportspark';
export type AuthorityScopeKind = 'organization' | 'facility' | 'program' | 'competition';
export type ReconciliationLevel =
  'control_totals' | 'record_identity' | 'relationships' | 'operational_outcomes';
export type ReconciliationArea = 'identity' | 'participation' | 'schedule' | 'finance';
export type ReconciliationStatus = 'balanced' | 'discrepancy';
export type ReconciliationApprovalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

/** text[] column written as a plain array (round-trips through both drivers). */
export type MigrationTextArray<T extends string = string> = ColumnType<T[], T[] | undefined, T[]>;
/** Stored generated columns are read-only. */
export type MigrationGenerated<T> = ColumnType<T, never, never>;

export interface ImportBatchesTable {
  id: string;
  organization_id: string;
  source_system: string;
  snapshot_taken_at: Timestamp;
  received_at: Timestamp;
  transformation_version: string;
  declared_checksum: string | null;
  declared_row_count: number | null;
  checksum: string | null;
  extraction: GeneratedJson<Record<string, unknown>>;
  control_totals: Json<Record<string, unknown>>;
  status: Generated<ImportBatchStatus>;
  row_count: Generated<number>;
  planned_counts: GeneratedJson<Record<string, unknown>>;
  validation_summary: GeneratedJson<Record<string, unknown>>;
  created_count: Generated<number>;
  matched_count: Generated<number>;
  updated_count: Generated<number>;
  skipped_count: Generated<number>;
  exception_count: Generated<number>;
  validated_at: NullableTimestamp;
  validated_by: Json<Record<string, unknown>> | null;
  reviewed_at: NullableTimestamp;
  reviewed_by: Json<Record<string, unknown>> | null;
  review_reason: string | null;
  apply_started_at: NullableTimestamp;
  apply_lock_operation_id: string | null;
  apply_lock_until: NullableTimestamp;
  applied_operation_id: string | null;
  applied_at: NullableTimestamp;
  applied_by: Json<Record<string, unknown>> | null;
  aborted_at: NullableTimestamp;
  aborted_by: Json<Record<string, unknown>> | null;
  abort_reason: string | null;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ImportRowsTable {
  id: string;
  organization_id: string;
  batch_id: string;
  sequence: number;
  entity_type: ImportEntityType;
  external_id: string;
  payload: Json<Record<string, unknown>>;
  payload_hash: string;
  planned_outcome: ImportRowOutcome | null;
  outcome: ImportRowOutcome | null;
  mapping_id: string | null;
  reasons: GeneratedJson<unknown[]>;
  applied_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ExternalMappingsTable {
  id: string;
  organization_id: string;
  source_system: string;
  entity_type: MappedEntityType;
  external_id: string;
  status: Generated<'pending' | 'linked'>;
  person_id: string | null;
  household_id: string | null;
  relationship_id: string | null;
  program_id: string | null;
  obligation_id: string | null;
  credit_id: string | null;
  internal_id: MigrationGenerated<string | null>;
  applied_payload_hash: string | null;
  first_seen_batch_id: string;
  last_seen_batch_id: string;
  provenance: Json<Record<string, unknown>>;
  linked_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ImportExceptionsTable {
  id: string;
  organization_id: string;
  batch_id: string;
  row_id: string;
  kind: ImportExceptionKind;
  phase: 'validation' | 'apply';
  reasons: Json<unknown[]>;
  review_owner_role: string;
  status: Generated<ImportExceptionStatus>;
  decision: ImportExceptionDecision | null;
  resolution: Json<Record<string, unknown>> | null;
  decision_reason: string | null;
  decided_by: Json<Record<string, unknown>> | null;
  decided_by_person_id: string | null;
  decided_at: NullableTimestamp;
  withdrawn_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuthorityAssignmentsTable {
  id: string;
  organization_id: string;
  record_category: ImportEntityType;
  scope_kind: AuthorityScopeKind;
  facility_id: string | null;
  program_id: string | null;
  competition_id: string | null;
  authoritative_system: AuthoritativeSystem;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  effective: MigrationGenerated<string>;
  reason: string;
  policy_references: MigrationTextArray;
  approved_by: Json<Record<string, unknown>>;
  approved_by_person_id: string | null;
  supersedes_assignment_id: string | null;
  ended_at: NullableTimestamp;
  ended_by: Json<Record<string, unknown>> | null;
  end_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReconciliationReportsTable {
  id: string;
  organization_id: string;
  batch_id: string;
  generated_at: Timestamp;
  generated_by: Json<Record<string, unknown>>;
  generated_by_person_id: string | null;
  status: ReconciliationStatus;
  levels: Json<unknown[]>;
  discrepancy_count: number;
  // `text[] not null` with no default (migration 1200): required on insert, unlike
  // policy_references, which defaults to '{}'.
  required_areas: ColumnType<ReconciliationArea[], ReconciliationArea[], ReconciliationArea[]>;
  approval_status: Generated<ReconciliationApprovalStatus>;
  approval_completed_at: NullableTimestamp;
  superseded_by_report_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReconciliationDiscrepanciesTable {
  id: string;
  organization_id: string;
  report_id: string;
  level: ReconciliationLevel;
  area: ReconciliationArea;
  entity_type: ImportEntityType;
  code: string;
  external_id: string | null;
  internal_id: string | null;
  expected: Json<JsonObject> | null;
  actual: Json<JsonObject> | null;
  currency: string | null;
  difference_minor: number | null;
  count_difference: number | null;
  details: GeneratedJson<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export interface ReconciliationApprovalsTable {
  id: string;
  organization_id: string;
  report_id: string;
  area: ReconciliationArea;
  decision: 'approved' | 'rejected';
  approver: Json<Record<string, unknown>>;
  approver_person_id: string;
  approver_role: string;
  reason: string | null;
  acknowledged_discrepancies: number;
  decided_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface MigrationTables {
  import_batches: ImportBatchesTable;
  import_rows: ImportRowsTable;
  external_mappings: ExternalMappingsTable;
  import_exceptions: ImportExceptionsTable;
  authority_assignments: AuthorityAssignmentsTable;
  reconciliation_reports: ReconciliationReportsTable;
  reconciliation_discrepancies: ReconciliationDiscrepanciesTable;
  reconciliation_approvals: ReconciliationApprovalsTable;
}
