import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Support module tables (migration 1100, specification §3.19 SPK-SUPPORT-001..003, §2.3
 * SPK-UX-006, §4.4 Operations: Case and Exception). Cases and their history, links from cases to
 * authorized command outcomes, exception queues, and the append-only timeline reference index.
 */

export type CaseCategory =
  'access' | 'registration' | 'payment' | 'schedule' | 'team' | 'facility' | 'other';
export type CasePriority = 'low' | 'normal' | 'high' | 'urgent';
export type CaseStatus = 'open' | 'waiting_customer' | 'waiting_internal' | 'resolved' | 'closed';
export type CaseResolutionKind =
  | 'action_taken'
  | 'information_provided'
  | 'no_action_needed'
  | 'duplicate'
  | 'customer_unreachable';

/** A reference to a record owned by any module: `{ type: 'order', id: '…' }`. */
export interface RecordReference {
  type: string;
  id: string;
}

export interface CasesTable {
  id: string;
  organization_id: string;
  facility_id: string | null;
  category: CaseCategory;
  priority: Generated<CasePriority>;
  status: Generated<CaseStatus>;
  title: string;
  description: string | null;
  subject_person_id: string | null;
  subject_household_id: string | null;
  owner_person_id: string | null;
  owner_queue: string | null;
  related_records: GeneratedJson<RecordReference[]>;
  origin_access_review_id: string | null;
  origin_exception_id: string | null;
  due_at: NullableTimestamp;
  resolution_kind: CaseResolutionKind | null;
  resolution_summary: string | null;
  resolved_at: NullableTimestamp;
  resolved_by: Json<Record<string, unknown>> | null;
  closed_at: NullableTimestamp;
  opened_by: Json<Record<string, unknown>>;
  opened_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CaseActionVia = 'linked' | 'helper';
export type CaseActionStatus = 'requested' | 'succeeded' | 'failed' | 'unknown';
export interface CaseActionsTable {
  id: string;
  organization_id: string;
  case_id: string;
  action_id: string;
  via: CaseActionVia;
  status: CaseActionStatus;
  command_operation_id: string | null;
  audit_record_id: string | null;
  support_operation_id: string | null;
  record_type: string | null;
  record_id: string | null;
  request_key: string | null;
  input: GeneratedJson<Record<string, unknown>>;
  error: Json<{ code: string; message: string; details?: unknown }> | null;
  note: string | null;
  actor: Json<Record<string, unknown>>;
  actor_person_id: string | null;
  requested_at: Timestamp;
  completed_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CaseEventKind = 'note' | 'status' | 'assignment' | 'update' | 'action_link';
export interface CaseEventsTable {
  id: string;
  organization_id: string;
  case_id: string;
  sequence: number;
  kind: CaseEventKind;
  body: string | null;
  from_status: CaseStatus | null;
  to_status: CaseStatus | null;
  case_action_id: string | null;
  details: GeneratedJson<Record<string, unknown>>;
  actor: Json<Record<string, unknown>>;
  actor_person_id: string | null;
  occurred_at: Timestamp;
}

export type ExceptionQueueStatus = 'active' | 'retired';
export interface ExceptionQueuesTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  owning_roles: string[];
  acknowledge_within_minutes: number | null;
  resolve_within_minutes: number | null;
  status: Generated<ExceptionQueueStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TimelineRecordType =
  | 'payment_attempt'
  | 'refund_attempt'
  | 'order'
  | 'notification'
  | 'scheduling_event'
  | 'support_case';
export type TimelineRelation =
  'payer' | 'recipient' | 'subject' | 'committed_party' | 'team_member';
export interface TimelineReferencesTable {
  id: string;
  organization_id: string;
  person_id: string;
  record_type: TimelineRecordType;
  record_id: string;
  relation: TimelineRelation;
  facility_id: string | null;
  occurred_at: Timestamp;
  source_event_id: string;
  source_event_type: string;
  summary: GeneratedJson<JsonObject>;
  recorded_at: GeneratedTimestamp;
}

export interface SupportTables {
  cases: CasesTable;
  case_actions: CaseActionsTable;
  case_events: CaseEventsTable;
  exception_queues: ExceptionQueuesTable;
  timeline_references: TimelineReferencesTable;
}
