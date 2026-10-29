import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant, IntervalSchema } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Workforce API contract (specification §3.10 SPK-STAFF-001..006, §2.4 SPK-UX-007, §4.4
 * Workforce, §4.6 Assignment machine, §4.8 `POST /v1/assignments/{id}/accept`, SPK-AT-012).
 * Organization scope always comes from the principal; ids in bodies are validated against it.
 * Fee records support payment administration and never execute payroll (§1.7, SPK-STAFF-006).
 */

const Reason = z.string().trim().min(1).max(2000);
/** Role and qualification identifiers are lower-case slugs (mirrored by database checks). */
export const WorkforceSlug = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a lower-case slug (letters, digits, underscore)');

// ---------------------------------------------------------------------------------------------
// Enumerations (mirrored by the check constraints in migration 0700)
// ---------------------------------------------------------------------------------------------

export const AssignmentKindSchema = z
  .enum(['official', 'coach', 'supervisor', 'organizer'])
  .openapi('AssignmentKind');
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;
export const AssignmentTargetTypeSchema = z
  .enum(['fixture', 'event', 'session'])
  .openapi('AssignmentTargetType');
export type AssignmentTargetType = z.infer<typeof AssignmentTargetTypeSchema>;
/** §4.6 Assignment lifecycle (AssignmentMachine in state-machines.ts). */
export const AssignmentStatusSchema = z
  .enum(['proposed', 'offered', 'accepted', 'declined', 'withdrawn', 'completed'])
  .openapi('AssignmentStatus');
export type AssignmentStatus = z.infer<typeof AssignmentStatusSchema>;
/** Temporary and substitute work receives time-bounded staff access (SPK-STAFF-004). */
export const AssignmentEngagementSchema = z
  .enum(['regular', 'temporary', 'substitute'])
  .openapi('AssignmentEngagement');
export type AssignmentEngagement = z.infer<typeof AssignmentEngagementSchema>;
export const AssignmentAccessStatusSchema = z
  .enum(['not_applicable', 'pending', 'granted', 'failed', 'ended'])
  .openapi('AssignmentAccessStatus');
export type AssignmentAccessStatus = z.infer<typeof AssignmentAccessStatusSchema>;
export const AvailabilityKindSchema = z
  .enum(['available', 'unavailable'])
  .openapi('AvailabilityKind');
export type AvailabilityKind = z.infer<typeof AvailabilityKindSchema>;
export const AvailabilityStatusSchema = z
  .enum(['active', 'withdrawn'])
  .openapi('AvailabilityStatus');
export const QualificationStatusSchema = z
  .enum(['pending_verification', 'verified', 'rejected', 'revoked'])
  .openapi('QualificationStatus');
export type QualificationStatus = z.infer<typeof QualificationStatusSchema>;
export const FeeSubmissionStatusSchema = z
  .enum(['submitted', 'approved', 'adjusted', 'rejected', 'exported'])
  .openapi('FeeSubmissionStatus');
export type FeeSubmissionStatus = z.infer<typeof FeeSubmissionStatusSchema>;

const BooleanQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

// ---------------------------------------------------------------------------------------------
// Availability (SPK-STAFF-001)
// ---------------------------------------------------------------------------------------------

export const StaffAvailabilitySchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    interval: z.object({ start: Instant, end: Instant }),
    kind: AvailabilityKindSchema,
    note: z.string().nullable(),
    status: AvailabilityStatusSchema,
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('StaffAvailability');
export type StaffAvailability = z.infer<typeof StaffAvailabilitySchema>;

export const CreateAvailabilityBody = withCommandMeta({
  /** Defaults to the caller's own person; staff with availability management may name another. */
  personId: z.uuid().optional(),
  interval: IntervalSchema,
  kind: AvailabilityKindSchema,
  note: z.string().trim().min(1).max(500).optional(),
}).openapi('CreateAvailabilityRequest');
export type CreateAvailabilityBody = z.infer<typeof CreateAvailabilityBody>;

export const WithdrawAvailabilityBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('WithdrawAvailabilityRequest');
export type WithdrawAvailabilityBody = z.infer<typeof WithdrawAvailabilityBody>;

export const ListAvailabilityQuery = z.object({
  personId: z.uuid().optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  includeWithdrawn: BooleanQuery,
});
export type ListAvailabilityQuery = z.infer<typeof ListAvailabilityQuery>;

// ---------------------------------------------------------------------------------------------
// Qualifications (SPK-STAFF-001: qualification evidence where required)
// ---------------------------------------------------------------------------------------------

export const QualificationSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    kind: z.string(),
    level: z.string().nullable(),
    evidenceReference: z.string().nullable(),
    validFrom: Instant,
    validTo: Instant.nullable(),
    status: QualificationStatusSchema,
    verifiedAt: Instant.nullable(),
    verifiedBy: ActorSnapshotSchema.nullable(),
    statusReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Qualification');
export type Qualification = z.infer<typeof QualificationSchema>;

export const CreateQualificationBody = withCommandMeta({
  /** Defaults to the caller (self-submitted evidence awaits verification). */
  personId: z.uuid().optional(),
  kind: WorkforceSlug,
  level: z.string().trim().min(1).max(100).optional(),
  evidenceReference: z.string().trim().min(1).max(2000).optional(),
  validFrom: Instant,
  validTo: Instant.optional(),
  /** Staff holding qualification management may record it as verified directly. */
  verify: z.boolean().default(false),
})
  .refine((v) => !v.validTo || new Date(v.validFrom) < new Date(v.validTo), {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  })
  .openapi('CreateQualificationRequest');
export type CreateQualificationBody = z.infer<typeof CreateQualificationBody>;

export const QualificationDecisionBody = withCommandMeta({}).openapi(
  'QualificationDecisionRequest',
);
export type QualificationDecisionBody = z.infer<typeof QualificationDecisionBody>;
export const QualificationReasonBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('QualificationReasonRequest');
export type QualificationReasonBody = z.infer<typeof QualificationReasonBody>;

export const ListQualificationsQuery = z.object({
  personId: z.uuid().optional(),
  kind: WorkforceSlug.optional(),
  status: QualificationStatusSchema.optional(),
});
export type ListQualificationsQuery = z.infer<typeof ListQualificationsQuery>;

// ---------------------------------------------------------------------------------------------
// Targets and requirements (SPK-STAFF-001 assignment scope, SPK-STAFF-002 required acceptance)
// ---------------------------------------------------------------------------------------------

const targetRefinement = <T extends { targetType?: AssignmentTargetType; offeringId?: string }>(
  v: T,
) => v.targetType !== 'session' || !!v.offeringId;
const targetRefinementMessage = {
  message: 'offeringId is required for a session target',
  path: ['offeringId'],
};

export const RequirementCoverageSchema = z
  .object({
    accepted: z.number().int(),
    offered: z.number().int(),
    proposed: z.number().int(),
    /** Slots without an accepted (or completed) assignment; proposed and offered never count (SPK-STAFF-002). */
    uncoveredSlots: z.array(z.number().int()),
  })
  .openapi('RequirementCoverage');

export const AssignmentRequirementSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    targetType: AssignmentTargetTypeSchema,
    targetId: z.uuid(),
    offeringId: z.uuid().nullable(),
    kind: AssignmentKindSchema,
    role: z.string(),
    requiredCount: z.number().int(),
    mustBeAccepted: z.boolean(),
    requiredQualifications: z.array(z.string()),
    coverage: RequirementCoverageSchema,
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('AssignmentRequirement');
export type AssignmentRequirement = z.infer<typeof AssignmentRequirementSchema>;

export const CreateAssignmentRequirementBody = withCommandMeta({
  targetType: AssignmentTargetTypeSchema,
  targetId: z.uuid(),
  offeringId: z.uuid().optional(),
  kind: AssignmentKindSchema,
  role: WorkforceSlug,
  requiredCount: z.number().int().min(1).max(50),
  mustBeAccepted: z.boolean().default(true),
  requiredQualifications: z.array(WorkforceSlug).max(20).default([]),
})
  .refine(targetRefinement, targetRefinementMessage)
  .openapi('CreateAssignmentRequirementRequest');
export type CreateAssignmentRequirementBody = z.infer<typeof CreateAssignmentRequirementBody>;

export const UpdateAssignmentRequirementBody = withCommandMeta({
  requiredCount: z.number().int().min(1).max(50).optional(),
  mustBeAccepted: z.boolean().optional(),
  requiredQualifications: z.array(WorkforceSlug).max(20).optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateAssignmentRequirementRequest');
export type UpdateAssignmentRequirementBody = z.infer<typeof UpdateAssignmentRequirementBody>;

export const AssignmentTargetQuery = z.object({
  targetType: AssignmentTargetTypeSchema,
  targetId: z.uuid(),
});
export type AssignmentTargetQuery = z.infer<typeof AssignmentTargetQuery>;

// ---------------------------------------------------------------------------------------------
// Assignments (§4.6, SPK-STAFF-002/003/004)
// ---------------------------------------------------------------------------------------------

export const AssignmentAccessSchema = z
  .object({
    status: AssignmentAccessStatusSchema,
    staffMembershipId: z.uuid().nullable(),
    from: Instant.nullable(),
    until: Instant.nullable(),
    /** Whether the time-bounded access is in effect at the evaluation instant. */
    active: z.boolean(),
  })
  .openapi('AssignmentAccess');

export const AssignmentSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    personId: z.uuid(),
    kind: AssignmentKindSchema,
    targetType: AssignmentTargetTypeSchema,
    targetId: z.uuid(),
    offeringId: z.uuid().nullable(),
    schedulingEventId: z.uuid().nullable(),
    targetTitle: z.string(),
    role: z.string(),
    slot: z.number().int(),
    engagement: AssignmentEngagementSchema,
    status: AssignmentStatusSchema,
    scheduledStart: Instant,
    scheduledEnd: Instant,
    turnaroundMinutes: z.number().int(),
    /** End of the interval the person is held for (scheduled end plus turnaround, SPK-STAFF-003). */
    committedUntil: Instant,
    replacesAssignmentId: z.uuid().nullable(),
    offeredAt: Instant.nullable(),
    respondedAt: Instant.nullable(),
    acceptedAt: Instant.nullable(),
    declinedAt: Instant.nullable(),
    declineReason: z.string().nullable(),
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
    completedAt: Instant.nullable(),
    access: AssignmentAccessSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Assignment');
export type Assignment = z.infer<typeof AssignmentSchema>;

export const CreateAssignmentBody = withCommandMeta({
  personId: z.uuid(),
  kind: AssignmentKindSchema,
  targetType: AssignmentTargetTypeSchema,
  targetId: z.uuid(),
  offeringId: z.uuid().optional(),
  role: WorkforceSlug,
  slot: z.number().int().min(1).max(50).optional(),
  engagement: AssignmentEngagementSchema.default('regular'),
  /** Overrides the policy turnaround for this assignment (SPK-STAFF-003); below the policy it needs a reason and `workforce.override_turnaround` (§4.9). */
  turnaroundMinutes: z.number().int().min(0).max(720).optional(),
  /** Create directly in `offered` (propose then offer in one command). */
  offer: z.boolean().default(false),
})
  .refine(targetRefinement, targetRefinementMessage)
  .openapi('CreateAssignmentRequest');
export type CreateAssignmentBody = z.infer<typeof CreateAssignmentBody>;

export const AssignmentTransitionBody = withCommandMeta({}).openapi('AssignmentTransitionRequest');
export type AssignmentTransitionBody = z.infer<typeof AssignmentTransitionBody>;
export const DeclineAssignmentBody = withCommandMeta({}).openapi('DeclineAssignmentRequest');
export type DeclineAssignmentBody = z.infer<typeof DeclineAssignmentBody>;
export const WithdrawAssignmentBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('WithdrawAssignmentRequest');
export type WithdrawAssignmentBody = z.infer<typeof WithdrawAssignmentBody>;

export const UncoveredNoticeSchema = z
  .object({
    exceptionId: z.uuid(),
    role: z.string(),
    slot: z.number().int(),
    startsAt: Instant,
  })
  .openapi('UncoveredAssignmentNotice');

export const AssignmentOutcomeSchema = z
  .object({
    assignment: AssignmentSchema,
    /** Multi-step commands (time-bounded access, replacement) expose their outcome at GET /operations/{id}. */
    operationId: z.uuid().nullable(),
    /** Present when the command left a required slot uncovered inside the escalation window. */
    uncovered: UncoveredNoticeSchema.nullable(),
  })
  .openapi('AssignmentOutcome');
export type AssignmentOutcome = z.infer<typeof AssignmentOutcomeSchema>;

/** §4.6 Assignment machine events (AssignmentMachine in state-machines.ts). */
export const AssignmentEventSchema = z
  .enum(['offer', 'accept', 'decline', 'withdraw', 'complete'])
  .openapi('AssignmentEvent');
export type AssignmentEventValue = z.infer<typeof AssignmentEventSchema>;

/**
 * An assignment in the staff list (WRK-01, SCR-S-32/33, SPK-STAFF-001..004): the assignment and
 * the machine events the caller may perform on it now — allowed from its current state (and, for
 * offer and accept, before the activity ends; complete once it has started), and kept only when
 * the caller holds the action that performs the event at the assignment's facility.
 */
export const StaffAssignmentSchema = AssignmentSchema.extend({
  availableActions: z.array(AssignmentEventSchema),
}).openapi('StaffAssignment');
export type StaffAssignment = z.infer<typeof StaffAssignmentSchema>;

export const ListAssignmentsQuery = PageRequestSchema.extend({
  targetType: AssignmentTargetTypeSchema.optional(),
  targetId: z.uuid().optional(),
  personId: z.uuid().optional(),
  status: AssignmentStatusSchema.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
});
export type ListAssignmentsQuery = z.infer<typeof ListAssignmentsQuery>;

// ---------------------------------------------------------------------------------------------
// Replacement workflow (SPK-STAFF-003, SPK-AT-012)
// ---------------------------------------------------------------------------------------------

export const CandidateReasonSchema = z
  .object({
    code: z.string(),
    severity: z.enum(['blocking', 'warning', 'info', 'positive']),
    message: z.string(),
    sourceType: z.string().nullable(),
    sourceIds: z.array(z.uuid()),
  })
  .openapi('ReplacementCandidateReason');
export type CandidateReason = z.infer<typeof CandidateReasonSchema>;

export const ReplacementCandidateSchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    /** Qualified, not declared unavailable and free of conflicting commitments. */
    eligible: z.boolean(),
    reasons: z.array(CandidateReasonSchema),
  })
  .openapi('ReplacementCandidate');
export type ReplacementCandidate = z.infer<typeof ReplacementCandidateSchema>;

export const ReplacementListSchema = z
  .object({
    assignmentId: z.uuid(),
    targetType: AssignmentTargetTypeSchema,
    targetId: z.uuid(),
    role: z.string(),
    slot: z.number().int(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    requiredQualifications: z.array(z.string()),
    evaluatedAt: Instant,
    candidates: z.array(ReplacementCandidateSchema),
  })
  .openapi('ReplacementCandidates');
export type ReplacementList = z.infer<typeof ReplacementListSchema>;

export const CreateReplacementBody = withCommandMeta({
  personId: z.uuid(),
  engagement: AssignmentEngagementSchema.default('substitute'),
  /** Offer the replacement immediately (default) or only propose it. */
  offer: z.boolean().default(true),
  /** Withdraw the original assignment in the same command (absent official, SPK-STAFF-003). */
  withdrawOriginal: z.boolean().default(false),
})
  .extend({ reason: Reason })
  .openapi('CreateReplacementRequest');
export type CreateReplacementBody = z.infer<typeof CreateReplacementBody>;

export const ReplacementOutcomeSchema = z
  .object({
    original: AssignmentSchema,
    replacement: AssignmentSchema,
    operationId: z.uuid(),
    uncovered: UncoveredNoticeSchema.nullable(),
  })
  .openapi('ReplacementOutcome');
export type ReplacementOutcome = z.infer<typeof ReplacementOutcomeSchema>;

// ---------------------------------------------------------------------------------------------
// Fees (SPK-STAFF-006): assignment, rate basis, submitted amount, approver, adjustments, export
// ---------------------------------------------------------------------------------------------

const MinorAmount = z.number().int().min(0).max(100_000_000);

export const RateBasisSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('per_assignment'),
      rateMinor: MinorAmount,
      rateReference: z.string().trim().min(1).max(200).optional(),
    }),
    z.object({
      kind: z.literal('hourly'),
      /** Minor units per hour; the computed amount rounds half up to whole minor units. */
      rateMinor: MinorAmount,
      minutes: z.number().int().min(1).max(1440),
      rateReference: z.string().trim().min(1).max(200).optional(),
    }),
    z.object({
      kind: z.literal('flat'),
      amountMinor: MinorAmount,
      rateReference: z.string().trim().min(1).max(200).optional(),
    }),
  ])
  .openapi('RateBasis');
export type RateBasis = z.infer<typeof RateBasisSchema>;

export const FeeAdjustmentSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    previousAmountMinor: z.number().int(),
    adjustedAmountMinor: z.number().int(),
    currency: z.string(),
    reason: z.string(),
    adjustedBy: ActorSnapshotSchema,
    adjustedAt: Instant,
  })
  .openapi('FeeAdjustment');
export type FeeAdjustment = z.infer<typeof FeeAdjustmentSchema>;

export const FeeSubmissionSchema = z
  .object({
    id: z.uuid(),
    assignmentId: z.uuid(),
    personId: z.uuid(),
    rateBasis: RateBasisSchema,
    computedAmountMinor: z.number().int(),
    submittedAmountMinor: z.number().int(),
    currency: z.string(),
    note: z.string().nullable(),
    status: FeeSubmissionStatusSchema,
    submittedAt: Instant,
    approvedAmountMinor: z.number().int().nullable(),
    approver: ActorSnapshotSchema.nullable(),
    approvedAt: Instant.nullable(),
    rejectedAt: Instant.nullable(),
    rejectionReason: z.string().nullable(),
    exportBatchId: z.uuid().nullable(),
    exportedAt: Instant.nullable(),
    adjustments: z.array(FeeAdjustmentSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('FeeSubmission');
export type FeeSubmission = z.infer<typeof FeeSubmissionSchema>;

export const CreateFeeSubmissionBody = withCommandMeta({
  assignmentId: z.uuid(),
  rateBasis: RateBasisSchema,
  submittedAmountMinor: MinorAmount,
  currency: CurrencyCode,
  note: z.string().trim().min(1).max(2000).optional(),
}).openapi('CreateFeeSubmissionRequest');
export type CreateFeeSubmissionBody = z.infer<typeof CreateFeeSubmissionBody>;

export const ApproveFeeBody = withCommandMeta({}).openapi('ApproveFeeRequest');
export type ApproveFeeBody = z.infer<typeof ApproveFeeBody>;
// §4.9: an adjustment edits the approved amount (money), so a stale edit must fail rather than
// overwrite newer work; the current revision is required. Approve and reject are state transitions
// that FeeSubmissionMachine already refuses from any state but `submitted`.
export const AdjustFeeBody = withCommandMeta({ amountMinor: MinorAmount })
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('AdjustFeeRequest');
export type AdjustFeeBody = z.infer<typeof AdjustFeeBody>;
export const RejectFeeBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RejectFeeRequest');
export type RejectFeeBody = z.infer<typeof RejectFeeBody>;

export const ListFeeSubmissionsQuery = PageRequestSchema.extend({
  status: FeeSubmissionStatusSchema.optional(),
  currency: CurrencyCode.optional(),
  personId: z.uuid().optional(),
});
export type ListFeeSubmissionsQuery = z.infer<typeof ListFeeSubmissionsQuery>;

export const FeeExportLineSchema = z
  .object({
    feeSubmissionId: z.uuid(),
    assignmentId: z.uuid(),
    personId: z.uuid(),
    role: z.string(),
    targetType: AssignmentTargetTypeSchema,
    targetId: z.uuid(),
    scheduledStart: Instant,
    amountMinor: z.number().int(),
    currency: z.string(),
  })
  .openapi('FeeExportLine');
export type FeeExportLine = z.infer<typeof FeeExportLineSchema>;

export const FeeExportBatchSchema = z
  .object({
    id: z.uuid(),
    currency: z.string(),
    submissionCount: z.number().int(),
    totalMinor: z.number().int(),
    lines: z.array(FeeExportLineSchema),
    note: z.string().nullable(),
    createdBy: ActorSnapshotSchema,
    operationId: z.uuid().nullable(),
    createdAt: Instant,
  })
  .openapi('FeeExportBatch');
export type FeeExportBatch = z.infer<typeof FeeExportBatchSchema>;

export const CreateFeeExportBatchBody = withCommandMeta({
  currency: CurrencyCode,
  /** Defaults to every approved or adjusted submission in the currency not yet exported. */
  submissionIds: z.array(z.uuid()).min(1).max(500).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
}).openapi('CreateFeeExportBatchRequest');
export type CreateFeeExportBatchBody = z.infer<typeof CreateFeeExportBatchBody>;

// ---------------------------------------------------------------------------------------------
// Coach and referee workspace (SPK-UX-007): only assigned activities and permitted information
// ---------------------------------------------------------------------------------------------

export const WorkspaceParticipantSchema = z
  .object({
    side: z.enum(['home', 'away']).nullable(),
    teamEntryId: z.uuid().nullable(),
    name: z.string(),
  })
  .openapi('WorkspaceParticipant');

/**
 * The facility an activity takes place at (WRK-01, SPK-SCHED-008): its name and IANA time zone,
 * the zone the activity's times are shown in.
 */
export const AssignmentFacilitySchema = z
  .object({ id: z.uuid(), name: z.string(), timezone: z.string() })
  .openapi('AssignmentFacility');
export type AssignmentFacility = z.infer<typeof AssignmentFacilitySchema>;

export const WorkspaceAssignmentSchema = z
  .object({
    assignment: AssignmentSchema,
    activity: z.object({
      targetType: AssignmentTargetTypeSchema,
      targetId: z.uuid(),
      title: z.string(),
      facilityId: z.uuid(),
      /** WRK-01, SPK-SCHED-008, SPK-UX-007: show the activity's times in this facility's zone. */
      facility: AssignmentFacilitySchema,
      scheduledStart: Instant,
      scheduledEnd: Instant,
      /** Team names only for fixtures; never dates of birth, contacts or payment data (§4.14). */
      participants: z.array(WorkspaceParticipantSchema),
    }),
    fee: FeeSubmissionSchema.nullable(),
    /** Commands the assignee may perform now (accept, decline, withdraw, submit_fee). */
    availableActions: z.array(z.string()),
  })
  .openapi('WorkspaceAssignment');
export type WorkspaceAssignment = z.infer<typeof WorkspaceAssignmentSchema>;

export const MyAssignmentsQuery = z.object({
  from: Instant.optional(),
  to: Instant.optional(),
  status: AssignmentStatusSchema.optional(),
});
export type MyAssignmentsQuery = z.infer<typeof MyAssignmentsQuery>;

export const MyAssignmentsSchema = z
  .object({ evaluatedAt: Instant, items: z.array(WorkspaceAssignmentSchema) })
  .openapi('MyAssignments');
export type MyAssignments = z.infer<typeof MyAssignmentsSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Workforce';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(
  method: 'post' | 'patch',
  path: string,
  summary: string,
  body: z.ZodType | null,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied or participant authority required'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
      422: err('Eligibility failed (for example a required qualification is missing)'),
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
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  'post',
  '/availability',
  'Record an availability or unavailability window (SPK-STAFF-001)',
  CreateAvailabilityBody,
  StaffAvailabilitySchema,
);
query(
  '/availability',
  'List availability windows (own, or staff with workforce read)',
  ListAvailabilityQuery,
  z.array(StaffAvailabilitySchema),
);
command(
  'post',
  '/availability/{id}/withdraw',
  'Withdraw an availability window (kept for history)',
  WithdrawAvailabilityBody,
  StaffAvailabilitySchema,
  200,
);

command(
  'post',
  '/qualifications',
  'Record qualification evidence (SPK-STAFF-001)',
  CreateQualificationBody,
  QualificationSchema,
);
query(
  '/qualifications',
  'List qualifications',
  ListQualificationsQuery,
  z.array(QualificationSchema),
);
command(
  'post',
  '/qualifications/{id}/verify',
  'Verify qualification evidence',
  QualificationDecisionBody,
  QualificationSchema,
  200,
);
command(
  'post',
  '/qualifications/{id}/reject',
  'Reject qualification evidence',
  QualificationReasonBody,
  QualificationSchema,
  200,
);
command(
  'post',
  '/qualifications/{id}/revoke',
  'Revoke a verified qualification (kept for history)',
  QualificationReasonBody,
  QualificationSchema,
  200,
);

command(
  'post',
  '/assignment-requirements',
  'Declare how many accepted people a target needs in a role (SPK-STAFF-002)',
  CreateAssignmentRequirementBody,
  AssignmentRequirementSchema,
);
query(
  '/assignment-requirements',
  'Requirements and coverage of a target, including uncovered slots (SPK-UX-006)',
  AssignmentTargetQuery,
  z.array(AssignmentRequirementSchema),
);
command(
  'patch',
  '/assignment-requirements/{id}',
  'Change a requirement',
  UpdateAssignmentRequirementBody,
  AssignmentRequirementSchema,
  200,
);

command(
  'post',
  '/assignments',
  'Propose (or propose and offer) an assignment, checking qualification, availability, overlaps and turnaround (SPK-STAFF-001..003)',
  CreateAssignmentBody,
  AssignmentOutcomeSchema,
);
query(
  '/assignments',
  'List assignments with the machine events the caller may perform on each now (WRK-01)',
  ListAssignmentsQuery,
  pageSchema(StaffAssignmentSchema),
);
query('/assignments/{id}', 'Read an assignment (staff or the assignee)', null, AssignmentSchema);
command(
  'post',
  '/assignments/{id}/offer',
  'Offer a proposed assignment to the person',
  AssignmentTransitionBody,
  AssignmentOutcomeSchema,
  200,
);
command(
  'post',
  '/assignments/{id}/accept',
  'Accept an authorized assignment: only the assignee; the database rejects overlapping commitments (§4.8, SPK-STAFF-003/004)',
  AssignmentTransitionBody,
  AssignmentOutcomeSchema,
  200,
);
command(
  'post',
  '/assignments/{id}/decline',
  'Decline an offered assignment (only the assignee; SPK-AT-012)',
  DeclineAssignmentBody,
  AssignmentOutcomeSchema,
  200,
);
command(
  'post',
  '/assignments/{id}/withdraw',
  'Withdraw an assignment; a required slot left uncovered close to kickoff is escalated (SPK-STAFF-003)',
  WithdrawAssignmentBody,
  AssignmentOutcomeSchema,
  200,
);
command(
  'post',
  '/assignments/{id}/complete',
  'Mark accepted work completed (time-bounded access then expires on schedule, SPK-STAFF-004)',
  AssignmentTransitionBody,
  AssignmentOutcomeSchema,
  200,
);
query(
  '/assignments/{id}/replacements',
  'Qualified, available, non-conflicting replacement candidates with reasons (SPK-AT-012)',
  null,
  ReplacementListSchema,
);
command(
  'post',
  '/assignments/{id}/replacements',
  'Offer the slot to a replacement (optionally withdrawing the original)',
  CreateReplacementBody,
  ReplacementOutcomeSchema,
);

command(
  'post',
  '/fee-submissions',
  'Submit a fee or hours against a completed assignment (SPK-STAFF-006)',
  CreateFeeSubmissionBody,
  FeeSubmissionSchema,
);
query(
  '/fee-submissions',
  'List fee submissions (finance)',
  ListFeeSubmissionsQuery,
  pageSchema(FeeSubmissionSchema),
);
query('/fee-submissions/{id}', 'Read a fee submission', null, FeeSubmissionSchema);
command(
  'post',
  '/fee-submissions/{id}/approve',
  'Approve a submitted fee as submitted',
  ApproveFeeBody,
  FeeSubmissionSchema,
  200,
);
command(
  'post',
  '/fee-submissions/{id}/adjust',
  'Approve with an adjusted amount (appends to the adjustment history)',
  AdjustFeeBody,
  FeeSubmissionSchema,
  200,
);
command(
  'post',
  '/fee-submissions/{id}/reject',
  'Reject a submitted fee',
  RejectFeeBody,
  FeeSubmissionSchema,
  200,
);
command(
  'post',
  '/fee-export-batches',
  'Export approved fees for payment administration; no payroll is executed (SPK-STAFF-006, §1.7)',
  CreateFeeExportBatchBody,
  FeeExportBatchSchema,
);
query('/fee-export-batches/{id}', 'Read an export batch', null, FeeExportBatchSchema);

query(
  '/me/assignments',
  'Coach and referee workspace: assigned activities, permitted participant information, fees (SPK-UX-007)',
  MyAssignmentsQuery,
  MyAssignmentsSchema,
);
