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
 * Automation module tables (migrations 1400 and 1401, specification §3.21 SPK-AUTO-001..005, §4.2
 * "Automation: reviewable recommendations", SPK-AT-026). Assistant requests with their supporting
 * evidence and missing evidence, reviewable recommendations, and the append-only log of every
 * module query or command the assistant used or a reviewer applied.
 */

export type AssistantRequestStatus = 'processing' | 'answered' | 'failed';

/** Principal snapshot (kernel `snapshotActor`): kind, account, person, staff roles, session, label. */
export type PrincipalSnapshot = Record<string, unknown>;

export interface AssistantRequestsTable {
  id: string;
  organization_id: string;
  requester: Json<PrincipalSnapshot>;
  requester_account_id: string;
  requester_person_id: string;
  facility_id: string | null;
  prompt: string;
  attachments: GeneratedJson<Record<string, unknown>[]>;
  context_references: GeneratedJson<Record<string, unknown>[]>;
  status: Generated<AssistantRequestStatus>;
  provider: string;
  turns: Generated<number>;
  response_text: string | null;
  evidence: GeneratedJson<Record<string, unknown>[]>;
  missing_evidence: GeneratedJson<Record<string, unknown>[]>;
  error: Json<{ code: string; message: string; details?: unknown }> | null;
  operation_id: string;
  received_at: Timestamp;
  completed_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RecommendationKind =
  | 'schedule_repair'
  | 'communication_draft'
  | 'readiness_explanation'
  | 'financial_exception_explanation'
  | 'demand_summary'
  | 'policy_lookup'
  | 'issue_summary';
export type RecommendationStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'expired';
export type RecommendationCommandAction =
  'scheduling.publish_schedule' | 'communications.send' | 'finance.refund';

export interface RecommendationsTable {
  id: string;
  organization_id: string;
  assistant_request_id: string;
  facility_id: string | null;
  kind: RecommendationKind;
  title: string;
  summary: string;
  payload: GeneratedJson<Record<string, unknown>>;
  command_action_id: RecommendationCommandAction | null;
  /** `{ input, target }`: the owning module's command input and its authorization target. */
  command: Json<Record<string, unknown>> | null;
  evidence: GeneratedJson<Record<string, unknown>[]>;
  missing_evidence: GeneratedJson<Record<string, unknown>[]>;
  requester: Json<PrincipalSnapshot>;
  requester_account_id: string;
  requester_person_id: string;
  status: Generated<RecommendationStatus>;
  proposed_at: Timestamp;
  expires_at: Timestamp;
  reviewed_by: Json<PrincipalSnapshot> | null;
  reviewed_by_account_id: string | null;
  reviewed_by_person_id: string | null;
  reviewed_at: NullableTimestamp;
  review_decision: 'approved' | 'rejected' | null;
  review_reason: string | null;
  review_policy_references: GeneratedJson<string[]>;
  apply_operation_id: string | null;
  apply_started_at: NullableTimestamp;
  applied_by: Json<PrincipalSnapshot> | null;
  applied_by_account_id: string | null;
  applied_by_person_id: string | null;
  applied_at: NullableTimestamp;
  applied_audit_record_id: string | null;
  applied_command_operation_id: string | null;
  applied_record_type: string | null;
  applied_record_id: string | null;
  last_apply_error: Json<{ code: string; message: string; details?: unknown }> | null;
  expired_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ToolInvocationPhase = 'assist' | 'apply';
export type ToolKind = 'query' | 'command' | 'unknown';
export type ToolOutcome = 'succeeded' | 'denied' | 'failed' | 'unsupported' | 'invalid' | 'unknown';

/** Append-only (forbid_mutation): one row per module query or command used or applied. */
export interface ToolInvocationsTable {
  id: string;
  organization_id: string;
  assistant_request_id: string;
  recommendation_id: string | null;
  sequence: number;
  phase: ToolInvocationPhase;
  tool: string;
  action_id: string | null;
  tool_kind: ToolKind;
  principal: Json<PrincipalSnapshot>;
  principal_account_id: string;
  principal_person_id: string;
  arguments: GeneratedJson<Record<string, unknown>>;
  outcome: ToolOutcome;
  error_code: string | null;
  error_message: string | null;
  result_refs: GeneratedJson<JsonObject>;
  occurred_at: Timestamp;
  correlation_id: string | null;
  operation_id: string | null;
}

export type ApplySettlementOutcome = 'applied' | 'not_applied';

/**
 * Append-only (forbid_mutation, migration 1401, AUT-03): the reconciled outcome of an apply whose
 * outcome the owning module did not report; one per apply operation.
 */
export interface RecommendationApplySettlementsTable {
  id: string;
  organization_id: string;
  recommendation_id: string;
  apply_operation_id: string;
  outcome: ApplySettlementOutcome;
  evidence: string;
  reason: string;
  policy_references: GeneratedJson<string[]>;
  settled_by: Json<PrincipalSnapshot>;
  settled_by_account_id: string;
  settled_by_person_id: string;
  settled_at: Timestamp;
  audit_record_id: string;
  correlation_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface AutomationTables {
  assistant_requests: AssistantRequestsTable;
  recommendations: RecommendationsTable;
  tool_invocations: ToolInvocationsTable;
  recommendation_apply_settlements: RecommendationApplySettlementsTable;
}
