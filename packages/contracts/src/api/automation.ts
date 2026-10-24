import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Automation API contract (specification §3.21 SPK-AUTO-001..005, §4.2 "Automation: reviewable
 * recommendations", SPK-AT-026). The assistant is optional (feature flag AUTOMATION_ENABLED,
 * default off): while it is off every endpoint answers INTEGRATION_UNAVAILABLE and every other
 * module keeps working (SPK-AUTO-005). The assistant acts only with the caller's own principal,
 * through the owning modules' services (SPK-AUTO-004); imported text, attachments and messages are
 * data, never authority. Answers name their supporting records with freshness and keep missing
 * evidence visible (SPK-AUTO-002). Consequential changes are recommendations a person approves and
 * applies through the owning module's normal command with their own principal (SPK-AUTO-003).
 */

const Text = (max: number) => z.string().trim().min(1).max(max);
const Reason = Text(2000);
const Slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const ToolName = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);

// ---------------------------------------------------------------------------------------------
// Enumerations (mirrored by the check constraints in migration 1400)
// ---------------------------------------------------------------------------------------------

/** Kinds that carry no command: explanation, lookup and summary only. */
export const INFORMATIONAL_RECOMMENDATION_KINDS = [
  'readiness_explanation',
  'demand_summary',
  'policy_lookup',
  'issue_summary',
] as const;
export const RecommendationKindSchema = z
  .enum([
    'schedule_repair',
    'communication_draft',
    'readiness_explanation',
    'financial_exception_explanation',
    'demand_summary',
    'policy_lookup',
    'issue_summary',
  ])
  .openapi('RecommendationKind');
export type RecommendationKindValue = z.infer<typeof RecommendationKindSchema>;
export const InformationalRecommendationKindSchema = z
  .enum(INFORMATIONAL_RECOMMENDATION_KINDS)
  .openapi('InformationalRecommendationKind');
export type InformationalRecommendationKind = z.infer<typeof InformationalRecommendationKindSchema>;

/** RecommendationMachine states (automation.machines.ts). */
export const RecommendationStatusSchema = z
  .enum(['proposed', 'approved', 'rejected', 'applied', 'expired'])
  .openapi('RecommendationStatus');
export type RecommendationStatusValue = z.infer<typeof RecommendationStatusSchema>;

/** AssistantRequestMachine states (automation.machines.ts). */
export const AssistantRequestStatusSchema = z
  .enum(['processing', 'answered', 'failed'])
  .openapi('AssistantRequestStatus');
export type AssistantRequestStatusValue = z.infer<typeof AssistantRequestStatusSchema>;

/**
 * SPK-AUTO-002 freshness of a supporting record:
 *   `live`    the owning module's current state, read at `observedAt` with the caller's principal;
 *   `recent`  a computed or stored result whose `asOf` lies within the evidence age window;
 *   `stale`   a computed or stored result older than the window (shown, never presented as current);
 *   `unknown` the source states no as-of instant.
 */
export const EvidenceFreshnessSchema = z
  .enum(['live', 'recent', 'stale', 'unknown'])
  .openapi('EvidenceFreshness');
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;

/**
 * Why evidence is missing. `not_available` covers both "does not exist" and "you may not see it"
 * so a denial never reveals another household's record (§4.10, SPK-AT-026).
 */
export const MissingEvidenceReasonSchema = z
  .enum([
    'not_available',
    'unknown_evidence',
    'not_evaluated',
    'source_unavailable',
    'unsupported_request',
    'invalid_request',
    'limit_reached',
  ])
  .openapi('MissingEvidenceReason');
export type MissingEvidenceReason = z.infer<typeof MissingEvidenceReasonSchema>;

export const ToolOutcomeSchema = z
  .enum(['succeeded', 'denied', 'failed', 'unsupported', 'invalid', 'unknown'])
  .openapi('ToolOutcome');
export type ToolOutcomeValue = z.infer<typeof ToolOutcomeSchema>;

export const ContextReferenceTypeSchema = z
  .enum(['person', 'payment_attempt', 'fixture', 'schedule_draft'])
  .openapi('AssistantContextReferenceType');
export type ContextReferenceType = z.infer<typeof ContextReferenceTypeSchema>;

// ---------------------------------------------------------------------------------------------
// Evidence (SPK-AUTO-002)
// ---------------------------------------------------------------------------------------------

export const AssistantEvidenceSchema = z
  .object({
    recordType: Slug,
    recordId: z.string().min(1).max(200),
    /** The module query that produced it (`competition.fixture_readiness`, …). */
    source: ToolName,
    label: z.string().max(200).nullable(),
    /** When the assistant read it, with the caller's principal. */
    observedAt: Instant,
    /** The source's own as-of instant: last change of a record, computation instant of a result. */
    asOf: Instant.nullable(),
    ageSeconds: z.number().int().min(0).nullable(),
    freshness: EvidenceFreshnessSchema,
    /** For a context reference: whether the record changed after the client observed it. */
    changedSinceClientObservation: z.boolean().nullable(),
  })
  .openapi('AssistantEvidence');
export type AssistantEvidence = z.infer<typeof AssistantEvidenceSchema>;

export const AssistantMissingEvidenceSchema = z
  .object({
    recordType: Slug,
    recordId: z.string().min(1).max(200).nullable(),
    source: ToolName.nullable(),
    reason: MissingEvidenceReasonSchema,
    description: z.string().min(1).max(500),
  })
  .openapi('AssistantMissingEvidence');
export type AssistantMissingEvidence = z.infer<typeof AssistantMissingEvidenceSchema>;

// ---------------------------------------------------------------------------------------------
// Assistant requests (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004)
// ---------------------------------------------------------------------------------------------

/** Imported text, a forwarded message or a document's text. Data, never authority (SPK-AUTO-004). */
export const AssistantAttachmentInputSchema = z
  .object({
    name: Text(200),
    kind: z.enum(['text', 'message', 'document']),
    content: z.string().min(1).max(20000),
  })
  .strict()
  .openapi('AssistantAttachmentInput');
export type AssistantAttachmentInput = z.infer<typeof AssistantAttachmentInputSchema>;

export const AssistantContextReferenceInputSchema = z
  .object({
    type: ContextReferenceTypeSchema,
    id: z.uuid(),
    /** When the client last saw the record; the assistant re-reads it and reports any change. */
    observedAt: Instant.optional(),
  })
  .strict()
  .openapi('AssistantContextReferenceInput');
export type AssistantContextReferenceInput = z.infer<typeof AssistantContextReferenceInputSchema>;

export const CreateAssistantRequestBody = withCommandMeta({
  prompt: Text(4000),
  facilityId: z.uuid().optional(),
  attachments: z.array(AssistantAttachmentInputSchema).max(5).default([]),
  context: z.array(AssistantContextReferenceInputSchema).max(20).default([]),
})
  .strict()
  .openapi('CreateAssistantRequest');
export type CreateAssistantRequestInput = z.infer<typeof CreateAssistantRequestBody>;

export const AssistantAttachmentSchema = z
  .object({
    name: z.string(),
    kind: z.enum(['text', 'message', 'document']),
    length: z.number().int(),
    sha256: z.string(),
    /** Always `data`: nothing inside an attachment is treated as an instruction or a permission. */
    treatedAs: z.literal('data'),
  })
  .openapi('AssistantAttachment');
export type AssistantAttachment = z.infer<typeof AssistantAttachmentSchema>;

export const AssistantContextReferenceSchema = z
  .object({
    type: ContextReferenceTypeSchema,
    id: z.uuid(),
    observedAt: Instant.nullable(),
    /** Whether the assistant could read it with the requester's principal. */
    resolved: z.boolean(),
  })
  .openapi('AssistantContextReference');
export type AssistantContextReference = z.infer<typeof AssistantContextReferenceSchema>;

export const ToolInvocationSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    phase: z.enum(['assist', 'apply']),
    tool: z.string(),
    actionId: z.string().nullable(),
    toolKind: z.enum(['query', 'command', 'unknown']),
    /** The principal the module saw: the requester (assist) or the reviewer (apply). */
    principal: ActorSnapshotSchema,
    recommendationId: z.uuid().nullable(),
    outcome: ToolOutcomeSchema,
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    resultRefs: z.array(z.object({ type: z.string(), id: z.string() })),
    occurredAt: Instant,
  })
  .openapi('ToolInvocation');
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;

export const RecommendationCommandSchema = z
  .object({
    actionId: z.enum(['scheduling.publish_schedule', 'communications.send', 'finance.refund']),
    input: z.record(z.string(), z.unknown()),
    target: z.object({
      type: z.string(),
      id: z.string().nullable(),
      facilityId: z.uuid().nullable(),
    }),
  })
  .openapi('RecommendationCommand');
export type RecommendationCommand = z.infer<typeof RecommendationCommandSchema>;

export const RecommendationSchema = z
  .object({
    id: z.uuid(),
    assistantRequestId: z.uuid(),
    kind: RecommendationKindSchema,
    /** True when applying it would run an owning module's command (SPK-AUTO-003). */
    consequential: z.boolean(),
    title: z.string(),
    summary: z.string(),
    facilityId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    command: RecommendationCommandSchema.nullable(),
    evidence: z.array(AssistantEvidenceSchema),
    missingEvidence: z.array(AssistantMissingEvidenceSchema),
    status: RecommendationStatusSchema,
    requester: ActorSnapshotSchema,
    proposedAt: Instant,
    expiresAt: Instant,
    review: z
      .object({
        decision: z.enum(['approved', 'rejected']),
        reviewer: ActorSnapshotSchema,
        reviewedAt: Instant,
        reason: z.string().nullable(),
        policyReferences: z.array(z.string()),
      })
      .nullable(),
    apply: z.object({
      /** `not_applicable` for informational kinds. */
      state: z.enum(['not_applicable', 'pending', 'running', 'applied', 'not_applied']),
      operationId: z.uuid().nullable(),
      startedAt: Instant.nullable(),
      appliedBy: ActorSnapshotSchema.nullable(),
      appliedAt: Instant.nullable(),
      auditRecordId: z.uuid().nullable(),
      commandOperationId: z.uuid().nullable(),
      record: z.object({ type: z.string(), id: z.string() }).nullable(),
      lastError: z
        .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
        .nullable(),
    }),
    expiredAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('Recommendation');
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const AssistantRequestSchema = z
  .object({
    id: z.uuid(),
    status: AssistantRequestStatusSchema,
    prompt: z.string(),
    facilityId: z.uuid().nullable(),
    requester: ActorSnapshotSchema,
    attachments: z.array(AssistantAttachmentSchema),
    contextReferences: z.array(AssistantContextReferenceSchema),
    provider: z.string(),
    turns: z.number().int(),
    response: z.object({ text: z.string() }).nullable(),
    evidence: z.array(AssistantEvidenceSchema),
    missingEvidence: z.array(AssistantMissingEvidenceSchema),
    recommendations: z.array(RecommendationSchema),
    toolInvocations: z.array(ToolInvocationSchema),
    error: z
      .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
      .nullable(),
    operationId: z.uuid(),
    receivedAt: Instant,
    completedAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('AssistantRequest');
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Review (SPK-AUTO-003): explicit approval, rejection, apply by the approving reviewer
// ---------------------------------------------------------------------------------------------

export const ApproveRecommendationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('ApproveRecommendationRequest');
export type ApproveRecommendationInput = z.infer<typeof ApproveRecommendationBody>;

export const RejectRecommendationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .strict()
  .openapi('RejectRecommendationRequest');
export type RejectRecommendationInput = z.infer<typeof RejectRecommendationBody>;

export const ApplyRecommendationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('ApplyRecommendationRequest');
export type ApplyRecommendationInput = z.infer<typeof ApplyRecommendationBody>;

export const ListRecommendationsQuery = PageRequestSchema.extend({
  status: RecommendationStatusSchema.optional(),
  kind: RecommendationKindSchema.optional(),
});
export type ListRecommendationsQuery = z.infer<typeof ListRecommendationsQuery>;
export const RecommendationPageSchema =
  pageSchema(RecommendationSchema).openapi('RecommendationPage');

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Automation';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const unavailable = err(
  'INTEGRATION_UNAVAILABLE: the assistant is disabled (AUTOMATION_ENABLED=false, SPK-AUTO-005)',
);

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status: number,
) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied (raised by the owning module when applying)'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, RESOURCE_CONFLICT, IDEMPOTENCY_*)'),
      503: unavailable,
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      404: err('Not found or not visible'),
      503: unavailable,
    },
  });
}

command(
  '/assistant/requests',
  'Ask the assistant; it uses only the caller’s own permissions and names its evidence (SPK-AUTO-001, SPK-AUTO-002, SPK-AUTO-004)',
  CreateAssistantRequestBody,
  AssistantRequestSchema,
  201,
);
query(
  '/assistant/requests/{id}',
  'Read an assistant request with its evidence, missing evidence, tool invocations and recommendations (requester only)',
  null,
  AssistantRequestSchema,
);
query(
  '/recommendations',
  'Recommendations the viewer requested or may apply',
  ListRecommendationsQuery,
  RecommendationPageSchema,
);
query(
  '/recommendations/{id}',
  'Read a recommendation (requester, or a person authorized for its command)',
  null,
  RecommendationSchema,
);
command(
  '/recommendations/{id}/approve',
  'Explicitly approve a recommendation (SPK-AUTO-003)',
  ApproveRecommendationBody,
  RecommendationSchema,
  200,
);
command(
  '/recommendations/{id}/reject',
  'Reject a recommendation with a reason (SPK-AUTO-003)',
  RejectRecommendationBody,
  RecommendationSchema,
  200,
);
command(
  '/recommendations/{id}/apply',
  'Apply an approved recommendation through the owning module’s command with the reviewer’s principal (SPK-AUTO-003, SPK-AUTO-004)',
  ApplyRecommendationBody,
  RecommendationSchema,
  200,
);
