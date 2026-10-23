import type { ColumnType, Generated, JSONColumnType } from 'kysely';

/** Timestamp columns: read as Date, written as Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** bigint minor units are parsed to JavaScript numbers by the drivers (safe-integer checked). */
export type MinorUnits = ColumnType<number, number, number>;
export type JsonObject = Record<string, unknown> | unknown[];
export type Json<T extends object | null = JsonObject> = JSONColumnType<T>;
/** JSON column with a database default (Kysely's Generated<> does not unwrap ColumnType). */
export type GeneratedJson<T extends object | null = JsonObject> = ColumnType<
  T,
  string | undefined,
  string
>;

export type OrganizationStatus = 'active' | 'suspended' | 'archived';
export interface OrganizationsTable {
  id: string;
  slug: string;
  name: string;
  status: Generated<OrganizationStatus>;
  settings: GeneratedJson<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type FacilityStatus = 'active' | 'closed' | 'archived';
export interface FacilitiesTable {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  timezone: string;
  address: Json<Record<string, unknown>> | null;
  status: Generated<FacilityStatus>;
  settings: GeneratedJson<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuditRecordsTable {
  id: string;
  organization_id: string;
  occurred_at: GeneratedTimestamp;
  actor: Json<Record<string, unknown>>;
  action: string;
  target_type: string;
  target_id: string;
  before_revision: number | null;
  after_revision: number | null;
  reason: string | null;
  correlation_id: string | null;
  operation_id: string | null;
  details: GeneratedJson<Record<string, unknown>>;
}

export type OperationStatusValue =
  'pending' | 'running' | 'succeeded' | 'failed' | 'recovery_required' | 'compensated';
export interface OperationsTable {
  id: string;
  organization_id: string;
  kind: string;
  status: OperationStatusValue;
  requested_by: Json<Record<string, unknown>>;
  correlation_id: string | null;
  input: Json<JsonObject> | null;
  result: Json<JsonObject> | null;
  error: Json<{ code: string; message: string; details?: unknown }> | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
}

export interface IdempotencyKeysTable {
  organization_id: string;
  scope_key: string;
  idempotency_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: Json<JsonObject> | null;
  operation_id: string | null;
  created_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
  expires_at: Timestamp;
}

export type OutboxStatus = 'pending' | 'dispatched' | 'dead';
export interface OutboxEventsTable {
  id: string;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Json<JsonObject>;
  occurred_at: GeneratedTimestamp;
  correlation_id: string | null;
  causation_id: string | null;
  operation_id: string | null;
  status: Generated<OutboxStatus>;
  available_at: GeneratedTimestamp;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  last_error: string | null;
  locked_by: string | null;
  locked_until: NullableTimestamp;
  dispatched_at: NullableTimestamp;
  failure_owner: string | null;
}

export type InboxStatus = 'received' | 'processed' | 'failed' | 'ignored' | 'dead';
export interface InboxEventsTable {
  id: string;
  provider: string;
  provider_event_id: string;
  organization_id: string | null;
  event_type: string;
  payload: Json<JsonObject>;
  signature_verified: Generated<boolean>;
  received_at: GeneratedTimestamp;
  status: Generated<InboxStatus>;
  attempts: Generated<number>;
  last_error: string | null;
  processed_at: NullableTimestamp;
}

export interface EventConsumptionsTable {
  handler: string;
  event_id: string;
  consumed_at: GeneratedTimestamp;
}

export interface JobAttemptsTable {
  id: string;
  organization_id: string | null;
  source: 'outbox' | 'inbox' | 'scheduled';
  source_id: string;
  handler: string;
  attempt_number: number;
  worker_id: string;
  started_at: GeneratedTimestamp;
  finished_at: NullableTimestamp;
  outcome: 'succeeded' | 'failed' | 'skipped' | null;
  error: string | null;
  correlation_id: string | null;
}

export type ExceptionSeverity = 'info' | 'warning' | 'high' | 'critical';
export type ExceptionStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';
export interface OperationalExceptionsTable {
  id: string;
  organization_id: string;
  facility_id: string | null;
  category: string;
  severity: ExceptionSeverity;
  title: string;
  affected_type: string | null;
  affected_id: string | null;
  owner_queue: string;
  status: Generated<ExceptionStatus>;
  opened_at: GeneratedTimestamp;
  deadline_at: NullableTimestamp;
  acknowledged_at: NullableTimestamp;
  resolved_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  resolution: Json<JsonObject> | null;
  details: GeneratedJson<Record<string, unknown>>;
  dedupe_key: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
}

export interface CoreTables {
  organizations: OrganizationsTable;
  facilities: FacilitiesTable;
  audit_records: AuditRecordsTable;
  operations: OperationsTable;
  idempotency_keys: IdempotencyKeysTable;
  outbox_events: OutboxEventsTable;
  inbox_events: InboxEventsTable;
  event_consumptions: EventConsumptionsTable;
  job_attempts: JobAttemptsTable;
  operational_exceptions: OperationalExceptionsTable;
  schema_migrations: SchemaMigrationsTable;
}
