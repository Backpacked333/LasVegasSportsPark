import {
  DomainError,
  errors,
  type ActorSnapshot,
  type AssistantEvidence,
  type AssistantMissingEvidence,
  type Principal,
  type Recommendation,
  type RecommendationCommand,
  type ToolInvocation,
} from '@sportspark/contracts';
import type {
  AssistantRequestsTable,
  Db,
  RecommendationsTable,
  ToolInvocationsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../kernel';
import type { AutomationSettings } from './automation.settings';

export type Reader = Db | Trx;
export type AssistantRequestRow = Selectable<AssistantRequestsTable>;
export type RecommendationRow = Selectable<RecommendationsTable>;
export type ToolInvocationRow = Selectable<ToolInvocationsTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

/**
 * The assistant acts for a signed-in person only, never as a system principal (SPK-AUTO-004):
 * requests, reviews and applies all carry a customer or staff principal with an account and a
 * person, and the database refuses any other requester or reviewer snapshot.
 */
export function requirePerson(principal: Principal): {
  organizationId: string;
  accountId: string;
  personId: string;
} {
  if (principal.kind === 'anonymous') throw errors.authenticationRequired();
  if (
    (principal.kind !== 'customer' && principal.kind !== 'staff') ||
    !principal.accountId ||
    !principal.personId
  ) {
    throw errors.accessDenied('The assistant acts only for a signed-in person.');
  }
  return {
    organizationId: organizationOf(principal),
    accountId: principal.accountId,
    personId: principal.personId,
  };
}

export function assertEnabled(settings: AutomationSettings): void {
  if (!settings.enabled) throw automationUnavailable();
}

/** SPK-AUTO-005: the optional assistant is off; every other module keeps working. */
export function automationUnavailable(): DomainError {
  return new DomainError('INTEGRATION_UNAVAILABLE', 'The assistant is not enabled.', {
    details: { capability: 'automation', reason: 'disabled' },
  });
}

/** Domain errors that mean "this principal may not see or do this" (a denial, not a failure). */
export const DENIAL_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'ACCESS_DENIED',
  'PARTICIPANT_AUTHORITY_REQUIRED',
  'AUTHENTICATION_REQUIRED',
]);

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function actorOf(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Partial<ActorSnapshot>;
  return {
    kind: typeof v.kind === 'string' ? v.kind : 'unknown',
    accountId: typeof v.accountId === 'string' ? v.accountId : null,
    personId: typeof v.personId === 'string' ? v.personId : null,
    staffRoles: Array.isArray(v.staffRoles) ? v.staffRoles.map(String) : [],
    sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
    actorLabel: typeof v.actorLabel === 'string' ? v.actorLabel : 'unknown',
  };
}

export function commandOf(row: RecommendationRow): RecommendationCommand | null {
  if (!row.command_action_id || !row.command) return null;
  const c = row.command as { input?: Record<string, unknown>; target?: Record<string, unknown> };
  const target = c.target ?? {};
  return {
    actionId: row.command_action_id,
    input: c.input ?? {},
    target: {
      type: typeof target['type'] === 'string' ? target['type'] : 'record',
      id: typeof target['id'] === 'string' ? target['id'] : null,
      facilityId: typeof target['facilityId'] === 'string' ? target['facilityId'] : null,
    },
  };
}

export function toRecommendation(row: RecommendationRow): Recommendation {
  const command = commandOf(row);
  const applyState: Recommendation['apply']['state'] = !command
    ? 'not_applicable'
    : row.status === 'applied'
      ? 'applied'
      : row.apply_operation_id
        ? 'running'
        : row.status === 'proposed' || row.status === 'approved'
          ? 'pending'
          : 'not_applied';
  return {
    id: row.id,
    assistantRequestId: row.assistant_request_id,
    kind: row.kind,
    consequential: command !== null,
    title: row.title,
    summary: row.summary,
    facilityId: row.facility_id,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    command,
    evidence: (row.evidence ?? []) as unknown as AssistantEvidence[],
    missingEvidence: (row.missing_evidence ?? []) as unknown as AssistantMissingEvidence[],
    status: row.status,
    requester: actorOf(row.requester),
    proposedAt: iso(row.proposed_at),
    expiresAt: iso(row.expires_at),
    review:
      row.review_decision && row.reviewed_at
        ? {
            decision: row.review_decision,
            reviewer: actorOf(row.reviewed_by),
            reviewedAt: iso(row.reviewed_at),
            reason: row.review_reason,
            policyReferences: (row.review_policy_references ?? []).map(String),
          }
        : null,
    apply: {
      state: applyState,
      operationId: row.apply_operation_id,
      startedAt: isoOrNull(row.apply_started_at),
      appliedBy: row.applied_by ? actorOf(row.applied_by) : null,
      appliedAt: isoOrNull(row.applied_at),
      auditRecordId: row.applied_audit_record_id,
      commandOperationId: row.applied_command_operation_id,
      record:
        row.applied_record_type && row.applied_record_id
          ? { type: row.applied_record_type, id: row.applied_record_id }
          : null,
      lastError: row.last_apply_error ?? null,
    },
    expiredAt: isoOrNull(row.expired_at),
    revision: row.revision,
  };
}

export function toToolInvocation(row: ToolInvocationRow): ToolInvocation {
  const refs = Array.isArray(row.result_refs) ? row.result_refs : [];
  return {
    id: row.id,
    sequence: row.sequence,
    phase: row.phase,
    tool: row.tool,
    actionId: row.action_id,
    toolKind: row.tool_kind,
    principal: actorOf(row.principal),
    recommendationId: row.recommendation_id,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultRefs: refs
      .filter((r): r is { type: string; id: string } => typeof r === 'object' && r !== null)
      .map((r) => ({ type: String(r.type), id: String(r.id) })),
    occurredAt: iso(row.occurred_at),
  };
}
