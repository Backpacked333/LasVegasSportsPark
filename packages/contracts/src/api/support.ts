import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { StaffRole } from '../principal';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Support API contract (specification §3.19 SPK-SUPPORT-001..003, §2.3 SPK-UX-006 Today
 * workspace, §4.4 Operations: Case and Exception, SPK-IAM-005 escalation, SPK-AT-026). Every
 * endpoint acts with the operator's own principal: staff never use or need customer credentials
 * (SPK-SUPPORT-002), and support actions run the owning module's normal authorized commands
 * (SPK-SUPPORT-003). Organization scope always comes from the principal.
 */

const Reason = z.string().trim().min(1).max(2000);
const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a lower-case slug (letters, digits, underscore)');

/** A record owned by any module (`{ type: 'order', id }`); support only references it. */
export const RecordReferenceSchema = z
  .object({ type: Slug, id: z.string().trim().min(1).max(200) })
  .strict()
  .openapi('RecordReference');
export type RecordReferenceValue = z.infer<typeof RecordReferenceSchema>;

// ---------------------------------------------------------------------------------------------
// Enumerations (mirrored by the check constraints in migration 1100)
// ---------------------------------------------------------------------------------------------

export const CaseCategorySchema = z
  .enum(['access', 'registration', 'payment', 'schedule', 'team', 'facility', 'other'])
  .openapi('CaseCategory');
export type CaseCategoryValue = z.infer<typeof CaseCategorySchema>;
export const CasePrioritySchema = z
  .enum(['low', 'normal', 'high', 'urgent'])
  .openapi('CasePriority');
export type CasePriorityValue = z.infer<typeof CasePrioritySchema>;
/** CaseMachine states (support.machines.ts). */
export const CaseStatusSchema = z
  .enum(['open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed'])
  .openapi('CaseStatus');
export type CaseStatusValue = z.infer<typeof CaseStatusSchema>;
export const CaseEventNameSchema = z
  .enum(['wait_customer', 'wait_internal', 'resume', 'resolve', 'reopen', 'close'])
  .openapi('CaseTransitionEvent');
export type CaseEventName = z.infer<typeof CaseEventNameSchema>;
/** `action_taken` requires a succeeded case action (SPK-SUPPORT-003, enforced by the database). */
export const CaseResolutionKindSchema = z
  .enum([
    'action_taken',
    'information_provided',
    'no_action_needed',
    'duplicate',
    'customer_unreachable',
  ])
  .openapi('CaseResolutionKind');
export const CaseEventKindSchema = z
  .enum(['note', 'status', 'assignment', 'update', 'action_link'])
  .openapi('CaseEventKind');
export const CaseActionStatusSchema = z
  .enum(['requested', 'succeeded', 'failed', 'unknown'])
  .openapi('CaseActionStatus');
export const CaseActionViaSchema = z.enum(['linked', 'helper']).openapi('CaseActionVia');

// ---------------------------------------------------------------------------------------------
// Cases (SPK-SUPPORT-002)
// ---------------------------------------------------------------------------------------------

export const CaseEventSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    kind: CaseEventKindSchema,
    body: z.string().nullable(),
    fromStatus: CaseStatusSchema.nullable(),
    toStatus: CaseStatusSchema.nullable(),
    caseActionId: z.uuid().nullable(),
    details: z.record(z.string(), z.unknown()),
    actor: ActorSnapshotSchema,
    occurredAt: Instant,
  })
  .openapi('CaseEvent');
export type CaseEvent = z.infer<typeof CaseEventSchema>;

export const CaseActionSchema = z
  .object({
    id: z.uuid(),
    caseId: z.uuid(),
    /** The owning module's action id (`finance.refund`, `identity.revoke_access`, …). */
    actionId: z.string(),
    via: CaseActionViaSchema,
    status: CaseActionStatusSchema,
    /** Operation of the executed command, readable at GET /v1/operations/{id}. */
    commandOperationId: z.uuid().nullable(),
    auditRecordId: z.uuid().nullable(),
    /** Support's coordinating operation for helper commands. */
    supportOperationId: z.uuid().nullable(),
    record: RecordReferenceSchema.nullable(),
    input: z.record(z.string(), z.unknown()),
    error: z
      .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
      .nullable(),
    note: z.string().nullable(),
    actor: ActorSnapshotSchema,
    requestedAt: Instant,
    completedAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('CaseAction');
export type CaseAction = z.infer<typeof CaseActionSchema>;

export const CaseSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid().nullable(),
    category: CaseCategorySchema,
    priority: CasePrioritySchema,
    status: CaseStatusSchema,
    title: z.string(),
    description: z.string().nullable(),
    subject: z.object({ personId: z.uuid().nullable(), householdId: z.uuid().nullable() }),
    owner: z.object({ personId: z.uuid().nullable(), queue: z.string().nullable() }),
    relatedRecords: z.array(RecordReferenceSchema),
    origin: z
      .object({ type: z.enum(['access_review', 'operational_exception']), id: z.uuid() })
      .nullable(),
    dueAt: Instant.nullable(),
    overdue: z.boolean(),
    resolution: z.object({ kind: CaseResolutionKindSchema, summary: z.string() }).nullable(),
    resolvedAt: Instant.nullable(),
    closedAt: Instant.nullable(),
    openedBy: ActorSnapshotSchema,
    /** CaseMachine events the case accepts now (the caller's permission is checked on use). */
    allowedEvents: z.array(CaseEventNameSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Case');
export type Case = z.infer<typeof CaseSchema>;

export const CaseDetailSchema = CaseSchema.extend({
  events: z.array(CaseEventSchema),
  actions: z.array(CaseActionSchema),
}).openapi('CaseDetail');
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const OpenCaseBody = withCommandMeta({
  category: CaseCategorySchema,
  priority: CasePrioritySchema.default('normal'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000).optional(),
  facilityId: z.uuid().optional(),
  subjectPersonId: z.uuid().optional(),
  subjectHouseholdId: z.uuid().optional(),
  ownerPersonId: z.uuid().optional(),
  ownerQueue: Slug.optional(),
  relatedRecords: z.array(RecordReferenceSchema).max(50).default([]),
  /** Open the case to coordinate an operational exception (one live case per exception). */
  originExceptionId: z.uuid().optional(),
})
  .strict()
  .openapi('OpenCaseRequest');
export type OpenCaseInput = z.infer<typeof OpenCaseBody>;

export const UpdateCaseBody = withCommandMeta({
  category: CaseCategorySchema.optional(),
  priority: CasePrioritySchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5000).nullable().optional(),
  facilityId: z.uuid().nullable().optional(),
  relatedRecords: z.array(RecordReferenceSchema).max(50).optional(),
})
  .extend({ expectedRevision: Revision })
  .strict()
  .refine(
    (v) =>
      v.category !== undefined ||
      v.priority !== undefined ||
      v.title !== undefined ||
      v.description !== undefined ||
      v.facilityId !== undefined ||
      v.relatedRecords !== undefined,
    { message: 'Name at least one field to change.' },
  )
  .openapi('UpdateCaseRequest');
export type UpdateCaseInput = z.infer<typeof UpdateCaseBody>;

export const AssignCaseBody = withCommandMeta({
  /** A current staff member who handles cases; null leaves the case to its queue. */
  ownerPersonId: z.uuid().nullable(),
  ownerQueue: Slug.nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('AssignCaseRequest');
export type AssignCaseInput = z.infer<typeof AssignCaseBody>;

export const TransitionCaseBody = withCommandMeta({
  event: CaseEventNameSchema,
  resolution: z
    .object({ kind: CaseResolutionKindSchema, summary: z.string().trim().min(1).max(2000) })
    .strict()
    .optional(),
})
  .extend({ expectedRevision: Revision })
  .strict()
  .refine((v) => v.event !== 'resolve' || v.resolution !== undefined, {
    message: 'Resolving a case records its resolution.',
    path: ['resolution'],
  })
  .refine((v) => v.event === 'resolve' || v.resolution === undefined, {
    message: 'Only resolve carries a resolution.',
    path: ['resolution'],
  })
  .openapi('TransitionCaseRequest');
export type TransitionCaseInput = z.infer<typeof TransitionCaseBody>;

/** A note is history only: it never changes another module's state (SPK-SUPPORT-003). */
export const AddCaseNoteBody = withCommandMeta({ body: z.string().trim().min(1).max(5000) })
  .strict()
  .openapi('AddCaseNoteRequest');
export type AddCaseNoteInput = z.infer<typeof AddCaseNoteBody>;

export const ListCasesQuery = PageRequestSchema.extend({
  status: CaseStatusSchema.optional(),
  category: CaseCategorySchema.optional(),
  ownerPersonId: z.uuid().optional(),
  ownerQueue: Slug.optional(),
  subjectPersonId: z.uuid().optional(),
  facilityId: z.uuid().optional(),
});
export type ListCasesQuery = z.infer<typeof ListCasesQuery>;

/**
 * Links a command the operator already ran (with their own principal) to the case. The evidence
 * is the command's operation or audit record, which must be the operator's own and in the
 * organization; a link without evidence is refused.
 */
export const LinkCaseActionBody = withCommandMeta({
  actionId: z
    .string()
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'must be a registered action id'),
  operationId: z.uuid().optional(),
  auditRecordId: z.uuid().optional(),
  record: RecordReferenceSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
})
  .strict()
  .refine((v) => v.operationId !== undefined || v.auditRecordId !== undefined, {
    message: 'Name the operation or audit record of the executed command.',
    path: ['operationId'],
  })
  .openapi('LinkCaseActionRequest');
export type LinkCaseActionInput = z.infer<typeof LinkCaseActionBody>;

/** Resend a notification to the case's subject person through communications (operator's principal). */
export const ResendNotificationBody = withCommandMeta({ notificationId: z.uuid() })
  .extend({ reason: Reason })
  .strict()
  .openapi('ResendNotificationRequest');
export type ResendNotificationInput = z.infer<typeof ResendNotificationBody>;

/** Request a refund through finance's normal command (`finance.refund`, operator's principal). */
export const RequestRefundBody = withCommandMeta({
  paymentAttemptId: z.uuid(),
  amountMinor: z.number().int().safe().positive(),
})
  .extend({ reason: Reason })
  .strict()
  .openapi('CaseRefundRequest');
export type RequestRefundInput = z.infer<typeof RequestRefundBody>;

/**
 * Settles a helper action whose outcome support could not learn (`unknown`): the reviewer
 * records what the owning module reports. `succeeded` needs the evidence of the command the
 * helper ran (its operation or audit record, by the same operator); `failed` records that the
 * owning module holds no effect of it.
 */
export const SettleCaseActionBody = withCommandMeta({
  outcome: z.enum(['succeeded', 'failed']),
  operationId: z.uuid().optional(),
  auditRecordId: z.uuid().optional(),
  record: RecordReferenceSchema.optional(),
})
  .extend({ reason: Reason })
  .strict()
  .refine(
    (v) => v.outcome === 'failed' || v.operationId !== undefined || v.auditRecordId !== undefined,
    { message: 'A succeeded outcome names the executed command.', path: ['operationId'] },
  )
  .openapi('SettleCaseActionRequest');
export type SettleCaseActionInput = z.infer<typeof SettleCaseActionBody>;

export const CaseActionOutcomeSchema = z
  .object({ case: CaseDetailSchema, action: CaseActionSchema })
  .openapi('CaseActionOutcome');
export type CaseActionOutcome = z.infer<typeof CaseActionOutcomeSchema>;

// ---------------------------------------------------------------------------------------------
// Exception queues and operational exceptions (§4.4 Exception, SPK-UX-006, §5.11)
// ---------------------------------------------------------------------------------------------

export const ExceptionQueueSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    owningRoles: z.array(StaffRole),
    acknowledgeWithinMinutes: z.number().int().nullable(),
    resolveWithinMinutes: z.number().int().nullable(),
    status: z.enum(['active', 'retired']),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ExceptionQueue');
export type ExceptionQueue = z.infer<typeof ExceptionQueueSchema>;

export const CreateExceptionQueueBody = withCommandMeta({
  name: Slug,
  description: z.string().trim().min(1).max(500).optional(),
  owningRoles: z.array(StaffRole).min(1).max(11),
  acknowledgeWithinMinutes: z.number().int().min(1).max(43200).optional(),
  resolveWithinMinutes: z.number().int().min(1).max(129600).optional(),
})
  .strict()
  .refine(
    (v) =>
      v.acknowledgeWithinMinutes === undefined ||
      v.resolveWithinMinutes === undefined ||
      v.acknowledgeWithinMinutes <= v.resolveWithinMinutes,
    { message: 'Acknowledgment cannot be due after resolution.', path: ['resolveWithinMinutes'] },
  )
  .openapi('CreateExceptionQueueRequest');
export type CreateExceptionQueueInput = z.infer<typeof CreateExceptionQueueBody>;

export const UpdateExceptionQueueBody = withCommandMeta({
  description: z.string().trim().min(1).max(500).nullable().optional(),
  owningRoles: z.array(StaffRole).min(1).max(11).optional(),
  acknowledgeWithinMinutes: z.number().int().min(1).max(43200).nullable().optional(),
  resolveWithinMinutes: z.number().int().min(1).max(129600).nullable().optional(),
  status: z.enum(['active', 'retired']).optional(),
})
  .extend({ expectedRevision: Revision })
  .strict()
  .openapi('UpdateExceptionQueueRequest');
export type UpdateExceptionQueueInput = z.infer<typeof UpdateExceptionQueueBody>;

export const ExceptionSeveritySchema = z
  .enum(['info', 'warning', 'high', 'critical'])
  .openapi('ExceptionSeverity');
export const ExceptionStatusSchema = z
  .enum(['open', 'acknowledged', 'resolved', 'closed'])
  .openapi('ExceptionStatus');

/** An action the viewer is permitted to take now (computed with their principal). */
export const NextActionSchema = z
  .object({
    action: z.string(),
    label: z.string(),
    method: z.enum(['GET', 'POST']),
    href: z.string().nullable(),
  })
  .openapi('NextAction');
export type NextAction = z.infer<typeof NextActionSchema>;

export const ResolutionHistoryEntrySchema = z
  .object({
    at: Instant,
    action: z.string(),
    actorLabel: z.string(),
    reason: z.string().nullable(),
  })
  .openapi('ResolutionHistoryEntry');
export type ResolutionHistoryEntry = z.infer<typeof ResolutionHistoryEntrySchema>;

export const OperationalExceptionSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid().nullable(),
    category: z.string(),
    severity: ExceptionSeveritySchema,
    title: z.string(),
    affected: z.object({ type: z.string(), id: z.string() }).nullable(),
    ownerQueue: z.string(),
    status: ExceptionStatusSchema,
    openedAt: Instant,
    ageMinutes: z.number().int(),
    /** The exception's own deadline, else the queue's resolution service level. */
    deadlineAt: Instant.nullable(),
    acknowledgeBy: Instant.nullable(),
    overdue: z.boolean(),
    acknowledgedAt: Instant.nullable(),
    resolvedAt: Instant.nullable(),
    closedAt: Instant.nullable(),
    resolution: z.unknown().nullable(),
    details: z.record(z.string(), z.unknown()),
    revision: Revision,
    history: z.array(ResolutionHistoryEntrySchema),
    nextActions: z.array(NextActionSchema),
    /**
     * SPK-UX-006: acknowledging, resolving or closing the exception never changes the affected
     * payment, booking or delivery; the owning module keeps that state.
     */
    underlyingRecordUnchanged: z.literal(true),
  })
  .openapi('OperationalException');
export type OperationalException = z.infer<typeof OperationalExceptionSchema>;

export const ListExceptionsQuery = PageRequestSchema.extend({
  queue: Slug.optional(),
  status: ExceptionStatusSchema.optional(),
  facilityId: z.uuid().optional(),
  severity: ExceptionSeveritySchema.optional(),
});
export type ListExceptionsQuery = z.infer<typeof ListExceptionsQuery>;

export const AcknowledgeExceptionBody = withCommandMeta({})
  .strict()
  .openapi('AcknowledgeExceptionRequest');
export type AcknowledgeExceptionInput = z.infer<typeof AcknowledgeExceptionBody>;

export const SettleExceptionBody = withCommandMeta({
  resolution: z.record(z.string(), z.unknown()).optional(),
})
  .extend({ reason: Reason })
  .strict()
  .openapi('SettleExceptionRequest');
export type SettleExceptionInput = z.infer<typeof SettleExceptionBody>;

// ---------------------------------------------------------------------------------------------
// Today workspace (SPK-UX-006)
// ---------------------------------------------------------------------------------------------

export const TodayQuery = z.object({ facilityId: z.uuid().optional() });
export type TodayQuery = z.infer<typeof TodayQuery>;

export const TodayItemGroupSchema = z
  .enum([
    'match_readiness',
    'staffing',
    'registration',
    'financial',
    'communications',
    'maintenance',
    'incident',
    'other',
  ])
  .openapi('TodayItemGroup');

export const TodayItemSchema = z
  .object({
    /** Stable per issue: `exception:<id>`, `readiness:<fixtureId>`, `coverage:…`, `restriction:<id>`. */
    id: z.string(),
    source: z.enum(['exception', 'readiness', 'coverage', 'restriction']),
    group: TodayItemGroupSchema,
    category: z.string(),
    title: z.string(),
    severity: ExceptionSeveritySchema,
    facilityId: z.uuid().nullable(),
    affected: z.object({ type: z.string(), id: z.string() }).nullable(),
    ownerQueue: z.string(),
    /** Exception status, or `unresolved` for a condition derived from the owning module now. */
    status: z.enum(['open', 'acknowledged', 'unresolved']),
    openedAt: Instant.nullable(),
    ageMinutes: z.number().int().nullable(),
    deadlineAt: Instant.nullable(),
    overdue: z.boolean(),
    nextActions: z.array(NextActionSchema),
    history: z.array(ResolutionHistoryEntrySchema),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi('TodayItem');
export type TodayItem = z.infer<typeof TodayItemSchema>;

export const TodaySourceSchema = z
  .object({
    source: z.string(),
    facilityId: z.uuid().nullable(),
    /** `not_permitted`: the viewer may not read this source, so it contributes nothing. */
    status: z.enum(['ok', 'not_permitted', 'unavailable']),
    count: z.number().int(),
  })
  .openapi('TodaySource');
export type TodaySource = z.infer<typeof TodaySourceSchema>;

export const TodayFeedSchema = z
  .object({
    generatedAt: Instant,
    facilities: z.array(
      z.object({
        facilityId: z.uuid(),
        name: z.string(),
        timezone: z.string(),
        localDate: z.iso.date(),
        window: z.object({ start: Instant, end: Instant }),
        activities: z.object({
          total: z.number().int(),
          published: z.number().int(),
          canceled: z.number().int(),
          /** False (and the counts zero) when the viewer may not read the facility schedule. */
          visible: z.boolean(),
        }),
      }),
    ),
    items: z.array(TodayItemSchema),
    sources: z.array(TodaySourceSchema),
  })
  .openapi('TodayFeed');
export type TodayFeed = z.infer<typeof TodayFeedSchema>;

// ---------------------------------------------------------------------------------------------
// Customer timeline (SPK-SUPPORT-001)
// ---------------------------------------------------------------------------------------------

export const TimelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Entries strictly older than this cursor (from `nextCursor`). */
  cursor: z.string().max(2048).optional(),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const TimelinePersonSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['adult', 'child']),
    /** A child is shown by given name only, without date of birth or contacts (§4.14). */
    displayName: z.string(),
    status: z.string(),
    minimized: z.boolean(),
  })
  .openapi('TimelinePerson');
export type TimelinePerson = z.infer<typeof TimelinePersonSchema>;

export const TimelineCategorySchema = z
  .enum([
    'registration',
    'participation',
    'order',
    'payment',
    'refund',
    'credit',
    'obligation',
    'schedule',
    'message',
    'support',
  ])
  .openapi('TimelineCategory');

export const TimelineEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: Instant,
    category: TimelineCategorySchema,
    kind: z.string(),
    title: z.string(),
    /** The person in scope the entry concerns; other people are never named (§4.7 invariant 1). */
    personId: z.uuid().nullable(),
    record: z.object({ type: z.string(), id: z.string() }),
    status: z.string().nullable(),
    amount: z.object({ amountMinor: z.number().int(), currency: CurrencyCode }).nullable(),
    facilityId: z.uuid().nullable(),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi('TimelineEntry');
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const CustomerTimelineSchema = z
  .object({
    person: TimelinePersonSchema,
    scope: z.object({
      /** The person and the people they currently hold `view` over (their dependents). */
      personIds: z.array(z.uuid()),
      dependents: z.array(TimelinePersonSchema),
    }),
    entries: z.array(TimelineEntrySchema),
    sources: z.array(
      z.object({
        source: z.string(),
        status: z.enum(['ok', 'not_permitted', 'unavailable']),
        count: z.number().int(),
      }),
    ),
    generatedAt: Instant,
    nextCursor: z.string().nullable(),
  })
  .openapi('CustomerTimeline');
export type CustomerTimeline = z.infer<typeof CustomerTimelineSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const PersonParams = z.object({ personId: z.uuid() });
const TAG = 'Support';
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
  body: z.ZodType,
  response: z.ZodType,
  status = 200,
  params: z.ZodObject<z.ZodRawShape> | undefined = path.includes('{id}') ? IdParams : undefined,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied or participant authority required'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, RESOURCE_CONFLICT, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
  params: z.ZodObject<z.ZodRawShape> | undefined = path.includes('{id}') ? IdParams : undefined,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: { params, query: request ?? undefined },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/customers/{personId}/timeline',
  'Scoped customer timeline: registration, participation, orders, payments, refunds, credits, schedule changes, messages and support cases (SPK-SUPPORT-001)',
  TimelineQuery,
  CustomerTimelineSchema,
  PersonParams,
);
command(
  'post',
  '/cases',
  'Open a support case (SPK-SUPPORT-002)',
  OpenCaseBody,
  CaseDetailSchema,
  201,
);
query('/cases', 'List support cases', ListCasesQuery, pageSchema(CaseSchema));
query('/cases/{id}', 'Read a support case with its history and actions', null, CaseDetailSchema);
command(
  'patch',
  '/cases/{id}',
  'Change case fields (expected revision)',
  UpdateCaseBody,
  CaseDetailSchema,
);
command(
  'post',
  '/cases/{id}/assign',
  'Assign the case owner and queue',
  AssignCaseBody,
  CaseDetailSchema,
);
command(
  'post',
  '/cases/{id}/transition',
  'Move the case through its lifecycle (CaseMachine); resolve records the resolution',
  TransitionCaseBody,
  CaseDetailSchema,
);
command(
  'post',
  '/cases/{id}/notes',
  'Add a note (history only; never a substitute for a refund, permission change or transfer)',
  AddCaseNoteBody,
  CaseDetailSchema,
  201,
);
command(
  'post',
  '/cases/{id}/actions',
  'Link a command the operator ran to the case, with its operation or audit record (SPK-SUPPORT-003)',
  LinkCaseActionBody,
  CaseActionOutcomeSchema,
  201,
);
command(
  'post',
  '/cases/{id}/resend-notification',
  "Resend a notification to the case's subject through communications' normal command",
  ResendNotificationBody,
  CaseActionOutcomeSchema,
  201,
);
command(
  'post',
  '/cases/{id}/request-refund',
  "Request a refund through finance's normal command (finance.refund) and link the outcome",
  RequestRefundBody,
  CaseActionOutcomeSchema,
  201,
);
command(
  'post',
  '/cases/{id}/actions/{actionId}/settle',
  'Record the owning module’s outcome of a helper action whose outcome was unknown',
  SettleCaseActionBody,
  CaseActionOutcomeSchema,
  200,
  z.object({ id: z.uuid(), actionId: z.uuid() }),
);
query('/today', 'Today workspace feed for the viewer (SPK-UX-006)', TodayQuery, TodayFeedSchema);
query(
  '/exceptions',
  'List operational exceptions by queue, status, facility or severity',
  ListExceptionsQuery,
  pageSchema(OperationalExceptionSchema),
);
query(
  '/exceptions/{id}',
  'Read an operational exception with its resolution history',
  null,
  OperationalExceptionSchema,
);
command(
  'post',
  '/exceptions/{id}/acknowledge',
  'Acknowledge an operational exception (the underlying record is unchanged)',
  AcknowledgeExceptionBody,
  OperationalExceptionSchema,
);
command(
  'post',
  '/exceptions/{id}/resolve',
  'Mark an operational exception resolved (the underlying record is unchanged)',
  SettleExceptionBody,
  OperationalExceptionSchema,
);
command(
  'post',
  '/exceptions/{id}/close',
  'Close an operational exception (the underlying record is unchanged)',
  SettleExceptionBody,
  OperationalExceptionSchema,
);
query('/exception-queues', 'List exception queues', null, z.array(ExceptionQueueSchema));
command(
  'post',
  '/exception-queues',
  'Define an exception queue: owning roles and service levels',
  CreateExceptionQueueBody,
  ExceptionQueueSchema,
  201,
);
command(
  'patch',
  '/exception-queues/{id}',
  'Change an exception queue (expected revision)',
  UpdateExceptionQueueBody,
  ExceptionQueueSchema,
);
