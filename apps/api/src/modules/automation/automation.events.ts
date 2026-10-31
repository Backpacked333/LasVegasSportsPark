import { defineEvent, z } from '@sportspark/contracts';

/**
 * Automation domain events (§4.12). Payloads carry identifiers and enumerations only — never the
 * prompt, attachments, response text or any record content (§4.14).
 */
const Kind = z.enum([
  'schedule_repair',
  'communication_draft',
  'readiness_explanation',
  'financial_exception_explanation',
  'demand_summary',
  'policy_lookup',
  'issue_summary',
]);

export const AssistantRequestCompleted = defineEvent(
  'automation.assistant_request_completed',
  z.object({
    assistantRequestId: z.uuid(),
    status: z.enum(['answered', 'failed']),
    toolInvocations: z.number().int(),
    deniedToolInvocations: z.number().int(),
    recommendationIds: z.array(z.uuid()),
  }),
);

/**
 * A tool call the assistant proposed was refused by the owning module's authorization under the
 * requester's principal (SPK-AT-026). Raised for monitoring; nothing was disclosed or changed.
 */
export const ToolInvocationDenied = defineEvent(
  'automation.tool_invocation_denied',
  z.object({
    assistantRequestId: z.uuid(),
    toolInvocationId: z.uuid(),
    tool: z.string(),
    actionId: z.string().nullable(),
    errorCode: z.string(),
    phase: z.enum(['assist', 'apply']),
  }),
);

export const RecommendationProposed = defineEvent(
  'automation.recommendation_proposed',
  z.object({
    recommendationId: z.uuid(),
    assistantRequestId: z.uuid(),
    kind: Kind,
    commandActionId: z.string().nullable(),
    facilityId: z.uuid().nullable(),
    expiresAt: z.iso.datetime(),
  }),
);

export const RecommendationReviewed = defineEvent(
  'automation.recommendation_reviewed',
  z.object({
    recommendationId: z.uuid(),
    decision: z.enum(['approved', 'rejected']),
    revision: z.number().int(),
  }),
);

/**
 * The recommendation's command took effect: reported by the apply itself, or by the settlement of
 * an apply whose outcome was unknown (AUT-03; `settlementId` set, `commandOperationId` null).
 */
export const RecommendationApplied = defineEvent(
  'automation.recommendation_applied',
  z.object({
    recommendationId: z.uuid(),
    commandActionId: z.string(),
    commandOperationId: z.uuid().nullable(),
    record: z.object({ type: z.string(), id: z.string() }).nullable(),
    settlementId: z.uuid().optional(),
  }),
);

/**
 * An apply did not take effect: refused or failed by the owning module, of unknown outcome, or
 * settled as not applied after reconciliation (AUT-03; `settlementId` set, outcome `failed`).
 */
export const RecommendationApplyFailed = defineEvent(
  'automation.recommendation_apply_failed',
  z.object({
    recommendationId: z.uuid(),
    commandActionId: z.string(),
    errorCode: z.string(),
    outcome: z.enum(['denied', 'failed', 'unknown']),
    settlementId: z.uuid().optional(),
  }),
);

export const RecommendationExpired = defineEvent(
  'automation.recommendation_expired',
  z.object({ recommendationId: z.uuid(), expiredAt: z.iso.datetime() }),
);

/** Timer: delivered at `expiresAt`; the handler expires the recommendation if still open. */
export const RecommendationExpiryDue = defineEvent(
  'automation.recommendation_expiry_due',
  z.object({ recommendationId: z.uuid() }),
);

export const AutomationEvents = {
  assistantRequestCompleted: AssistantRequestCompleted,
  toolInvocationDenied: ToolInvocationDenied,
  recommendationProposed: RecommendationProposed,
  recommendationReviewed: RecommendationReviewed,
  recommendationApplied: RecommendationApplied,
  recommendationApplyFailed: RecommendationApplyFailed,
  recommendationExpired: RecommendationExpired,
  recommendationExpiryDue: RecommendationExpiryDue,
} as const;
