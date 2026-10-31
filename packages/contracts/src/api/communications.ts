import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { StaffRole } from '../principal';
import { Instant } from '../time';

/**
 * Communications module API contract (specification §3.18 SPK-COMMS-001..008, §4.4
 * Communications, §4.5 "Messages must represent actual delivery states", SPK-UX-003/006).
 * Organization context always comes from the authenticated principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------
/** SPK-COMMS-002 triggers plus staff broadcasts (SPK-COMMS-006). */
export const NotificationKindSchema = z
  .enum([
    'registration_outcome',
    'team_invitation',
    'placement',
    'waitlist_offer',
    'schedule_published',
    'schedule_changed',
    'cancellation',
    'payment_attention',
    'assignment_offer',
    'result_published',
    'renewal_opportunity',
    'youth_feedback',
    'staff_broadcast',
    // SPK-CAP-001 "request availability, remind" (COM-06, migration 1007)
    'availability_request',
    'activity_reminder',
  ])
  .openapi('NotificationKind');
export type NotificationKindValue = z.infer<typeof NotificationKindSchema>;

/** SPK-COMMS-007: essential operational communications and promotional messages are separate. */
export const NotificationCategorySchema = z
  .enum(['operational', 'promotional'])
  .openapi('NotificationCategory');
export type NotificationCategoryValue = z.infer<typeof NotificationCategorySchema>;

export const NotificationStatusSchema = z
  .enum(['composed', 'queued', 'dispatched', 'suppressed'])
  .openapi('NotificationStatus');
export type NotificationStatusValue = z.infer<typeof NotificationStatusSchema>;
export const SuppressionReasonSchema = z
  .enum(['obsolete', 'no_recipients', 'authority_revoked'])
  .openapi('SuppressionReason');
export const RecipientBasisSchema = z
  .enum(['self', 'receive_messages', 'staff_role', 'team_member', 'explicit'])
  .openapi('RecipientBasis');
export type RecipientBasisValue = z.infer<typeof RecipientBasisSchema>;
export const RecipientStatusSchema = z
  .enum(['pending', 'authorized', 'revoked'])
  .openapi('RecipientStatus');
export const DeliveryChannelSchema = z
  .enum(['in_app', 'push', 'email', 'sms'])
  .openapi('DeliveryChannel');
export type DeliveryChannelValue = z.infer<typeof DeliveryChannelSchema>;
/** SPK-COMMS-004: the exact states the platform can tell apart. */
export const DeliveryStatusSchema = z
  .enum(['queued', 'provider_accepted', 'delivered', 'failed', 'unknown', 'read', 'acknowledged'])
  .openapi('DeliveryStatus');
export type DeliveryStatusValue = z.infer<typeof DeliveryStatusSchema>;
export const DeliveryFailureCodeSchema = z
  .enum(['RECIPIENT_REVOKED', 'NO_ADDRESS', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'SUPERSEDED'])
  .openapi('DeliveryFailureCode');
export type DeliveryFailureCodeValue = z.infer<typeof DeliveryFailureCodeSchema>;
export const AcknowledgmentViaSchema = DeliveryChannelSchema;

const Title = z.string().trim().min(1).max(200);
const Body = z.string().trim().min(1).max(4000);
const Reason = z.string().trim().min(1).max(2000);
const Label = z.string().trim().min(1).max(100);

/** Practical details shown old/new on schedule notices (SPK-COMMS-005); shape owned by the source module. */
export const PracticalDetailsSchema = z.record(z.string(), z.unknown()).openapi('PracticalDetails');
export type PracticalDetails = z.infer<typeof PracticalDetailsSchema>;

export const NotificationSubjectSchema = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(200) })
  .openapi('NotificationSubject');
export type NotificationSubject = z.infer<typeof NotificationSubjectSchema>;

/**
 * How recipients are resolved — always from CURRENT permissions (SPK-COMMS-003): holders of
 * `receive_messages` over each subject person (plus active adult subjects themselves), staff
 * currently holding a role (optionally within one facility), members of team entries (and the
 * guardians of child members), and explicit person ids.
 */
export const AudienceSchema = z
  .object({
    subjectPersonIds: z.array(z.uuid()).max(500).default([]),
    staffRoles: z.array(StaffRole).max(20).default([]),
    facilityId: z.uuid().nullable().default(null),
    teamEntryIds: z.array(z.uuid()).max(100).default([]),
    personIds: z.array(z.uuid()).max(500).default([]),
  })
  .refine(
    (a) =>
      a.subjectPersonIds.length + a.staffRoles.length + a.teamEntryIds.length + a.personIds.length >
      0,
    {
      message:
        'An audience must name at least one subject person, staff role, team entry or person.',
    },
  )
  .openapi('Audience');
export type Audience = z.infer<typeof AudienceSchema>;
export type AudienceInput = z.input<typeof AudienceSchema>;

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------
export const NotificationSchema = z
  .object({
    id: z.uuid(),
    kind: NotificationKindSchema,
    category: NotificationCategorySchema,
    status: NotificationStatusSchema,
    suppressionReason: SuppressionReasonSchema.nullable(),
    facilityId: z.uuid().nullable(),
    subject: NotificationSubjectSchema.nullable(),
    audience: AudienceSchema,
    title: z.string(),
    body: z.string(),
    detailsBefore: PracticalDetailsSchema.nullable(),
    detailsAfter: PracticalDetailsSchema.nullable(),
    protected: z.boolean(),
    scheduledFor: Instant.nullable(),
    supersedesNotificationId: z.uuid().nullable(),
    supersededByNotificationId: z.uuid().nullable(),
    createdByPersonId: z.uuid().nullable(),
    sourceEventId: z.uuid().nullable(),
    operationId: z.uuid().nullable(),
    queuedAt: Instant.nullable(),
    dispatchedAt: Instant.nullable(),
    suppressedAt: Instant.nullable(),
    correlationId: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Notification');
export type Notification = z.infer<typeof NotificationSchema>;

export const ComposeNotificationBody = withCommandMeta({
  kind: NotificationKindSchema,
  /**
   * SPK-COMMS-007: essential and promotional messages are separate. The communication policy binds
   * most kinds to a category (an essential kind is always operational, a renewal opportunity is
   * promotional); a mismatch is refused. Kinds the policy leaves open (a staff broadcast) must name
   * their category: there is no default.
   */
  category: NotificationCategorySchema.optional(),
  facilityId: z.uuid().optional(),
  subject: NotificationSubjectSchema.optional(),
  audience: AudienceSchema,
  title: Title,
  body: Body,
  detailsBefore: PracticalDetailsSchema.optional(),
  detailsAfter: PracticalDetailsSchema.optional(),
  /** Contains participant-private information: recipients are re-checked before dispatch (SPK-COMMS-003). */
  protected: z.boolean().default(false),
  /** Deliver no earlier than this instant (reminders); an obsolete unsent reminder is suppressed (SPK-COMMS-005). */
  scheduledFor: Instant.optional(),
}).openapi('ComposeNotificationRequest');
export type ComposeNotificationInput = z.infer<typeof ComposeNotificationBody>;

export const SendNotificationBody = withCommandMeta({}).openapi('SendNotificationRequest');
export type SendNotificationInput = z.infer<typeof SendNotificationBody>;

export const ListNotificationsQuery = PageRequestSchema.extend({
  status: NotificationStatusSchema.optional(),
  kind: NotificationKindSchema.optional(),
  facilityId: z.uuid().optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;
export const NotificationPageSchema = pageSchema(NotificationSchema).openapi('NotificationPage');

/** SPK-COMMS-006: names and a count, never a shared contact list. */
export const RecipientPreviewEntrySchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    basis: RecipientBasisSchema,
    basisDetail: z.string().nullable(),
    subjectPersonIds: z.array(z.uuid()),
  })
  .openapi('RecipientPreviewEntry');

export const RecipientPreviewSchema = z
  .object({
    notificationId: z.uuid(),
    /** Recipients are resolved from current permissions at preview time and again when sent. */
    resolvedAt: Instant,
    count: z.number().int().min(0),
    recipients: z.array(RecipientPreviewEntrySchema),
  })
  .openapi('RecipientPreview');
export type RecipientPreview = z.infer<typeof RecipientPreviewSchema>;

export const NotificationRecipientSchema = z
  .object({
    id: z.uuid(),
    notificationId: z.uuid(),
    personId: z.uuid(),
    basis: RecipientBasisSchema,
    basisDetail: z.string().nullable(),
    subjectPersonIds: z.array(z.uuid()),
    /** The recipient's name from the person directory (SPK-UX-006); null when it has none. */
    displayName: z.string().nullable(),
    status: RecipientStatusSchema,
    resolvedAt: Instant,
    authorizedAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
    revocationReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('NotificationRecipient');
export type NotificationRecipient = z.infer<typeof NotificationRecipientSchema>;

export const DeliveryAttemptSchema = z
  .object({
    id: z.uuid(),
    notificationId: z.uuid(),
    recipientId: z.uuid(),
    channel: DeliveryChannelSchema,
    provider: z.string(),
    providerMessageId: z.string().nullable(),
    status: DeliveryStatusSchema,
    queuedAt: Instant,
    attemptedAt: Instant.nullable(),
    acceptedAt: Instant.nullable(),
    deliveredAt: Instant.nullable(),
    failedAt: Instant.nullable(),
    readAt: Instant.nullable(),
    acknowledgedAt: Instant.nullable(),
    failureCode: DeliveryFailureCodeSchema.nullable(),
    error: z.string().nullable(),
    /** The failed attempt this one retries (SPK-COMMS-004, COM-02); null for a first attempt. */
    retryOfAttemptId: z.uuid().nullable(),
    revision: Revision,
  })
  .openapi('DeliveryAttempt');
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

export const NotificationDeliveriesSchema = z
  .object({
    notification: NotificationSchema,
    recipients: z.array(NotificationRecipientSchema),
    attempts: z.array(DeliveryAttemptSchema),
  })
  .openapi('NotificationDeliveries');
export type NotificationDeliveries = z.infer<typeof NotificationDeliveriesSchema>;

/**
 * SPK-COMMS-004 (COM-02): retry one failed external delivery as a new attempt. An unknown outcome
 * is never retried (it may have reached the person); a revoked recipient is refused.
 */
export const RetryDeliveryBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RetryDeliveryRequest');
export type RetryDeliveryInput = z.infer<typeof RetryDeliveryBody>;

// ---------------------------------------------------------------------------------------------
// Inbox (in-app notices = delivery attempts on the in_app channel; SPK-UX-003)
// ---------------------------------------------------------------------------------------------
export const InboxItemSchema = z
  .object({
    attemptId: z.uuid(),
    notificationId: z.uuid(),
    kind: NotificationKindSchema,
    category: NotificationCategorySchema,
    title: z.string(),
    body: z.string(),
    facilityId: z.uuid().nullable(),
    subject: NotificationSubjectSchema.nullable(),
    detailsBefore: PracticalDetailsSchema.nullable(),
    detailsAfter: PracticalDetailsSchema.nullable(),
    status: DeliveryStatusSchema,
    deliveredAt: Instant.nullable(),
    readAt: Instant.nullable(),
    acknowledgedAt: Instant.nullable(),
    /** Set when a newer notice about the same subject replaced this one (SPK-COMMS-005). */
    supersededByNotificationId: z.uuid().nullable(),
    /**
     * The participants this notice concerns for the reader (SPK-UX-003 "each action must identify
     * the participant"): the reader themself, or the people whose `receive_messages` grant reached
     * them. Ids only; names come from the person directory.
     */
    subjectPersonIds: z.array(z.uuid()),
    /** Revision of the delivery attempt; send it as `expectedRevision` to read or acknowledge. */
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('InboxItem');
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxQuery = PageRequestSchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

export const InboxPageSchema = pageSchema(InboxItemSchema).openapi('InboxPage');
export type InboxPage = z.infer<typeof InboxPageSchema>;

export const MarkReadBody = withCommandMeta({}).openapi('MarkNotificationReadRequest');
export type MarkReadInput = z.infer<typeof MarkReadBody>;

export const AcknowledgeBody = withCommandMeta({
  note: z.string().trim().min(1).max(2000).optional(),
}).openapi('AcknowledgeNotificationRequest');
export type AcknowledgeInput = z.infer<typeof AcknowledgeBody>;

// ---------------------------------------------------------------------------------------------
// Preferences (SPK-COMMS-007)
// ---------------------------------------------------------------------------------------------
export const CommunicationPreferenceSchema = z
  .object({
    channel: DeliveryChannelSchema,
    category: NotificationCategorySchema,
    enabled: z.boolean(),
    /** False when the value is the policy default rather than a stored choice. */
    stored: z.boolean(),
    /** Operational in-app notices cannot be disabled (SPK-COMMS-007). */
    locked: z.boolean(),
    updatedAt: Instant.nullable(),
  })
  .openapi('CommunicationPreference');
export type CommunicationPreference = z.infer<typeof CommunicationPreferenceSchema>;

export const CommunicationPreferencesSchema = z
  .object({
    personId: z.uuid(),
    preferences: z.array(CommunicationPreferenceSchema),
  })
  .openapi('CommunicationPreferences');
export type CommunicationPreferences = z.infer<typeof CommunicationPreferencesSchema>;

export const UpdatePreferencesBody = withCommandMeta({
  preferences: z
    .array(
      z.object({
        channel: DeliveryChannelSchema,
        category: NotificationCategorySchema,
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(8),
}).openapi('UpdateCommunicationPreferencesRequest');
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesBody>;

// ---------------------------------------------------------------------------------------------
// Calendar feeds (SPK-COMMS-008)
// ---------------------------------------------------------------------------------------------
export const CalendarFeedScopeSchema = z
  .object({ subjectPersonIds: z.array(z.uuid()) })
  .openapi('CalendarFeedScope');
export type CalendarFeedScope = z.infer<typeof CalendarFeedScopeSchema>;

export const CalendarFeedSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    label: z.string().nullable(),
    scope: CalendarFeedScopeSchema,
    lastAccessedAt: Instant.nullable(),
    accessCount: z.number().int().min(0),
    revokedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('CalendarFeed');
export type CalendarFeed = z.infer<typeof CalendarFeedSchema>;

export const CreateCalendarFeedBody = withCommandMeta({
  label: Label.optional(),
  /** Other people whose activities the feed includes; the owner must hold `view` over each (re-checked on every fetch). */
  subjectPersonIds: z.array(z.uuid()).max(50).default([]),
}).openapi('CreateCalendarFeedRequest');
export type CreateCalendarFeedInput = z.infer<typeof CreateCalendarFeedBody>;

/** The token is returned exactly once; only its hash is stored. */
export const CalendarFeedCreatedSchema = CalendarFeedSchema.extend({
  token: z.string(),
  path: z.string(),
}).openapi('CalendarFeedCreated');
export type CalendarFeedCreated = z.infer<typeof CalendarFeedCreatedSchema>;

export const RevokeCalendarFeedBody = withCommandMeta({
  reason: Reason.optional(),
}).openapi('RevokeCalendarFeedRequest');
export type RevokeCalendarFeedInput = z.infer<typeof RevokeCalendarFeedBody>;

export const CalendarFeedListSchema = z
  .object({ feeds: z.array(CalendarFeedSchema) })
  .openapi('CalendarFeedList');

// ---------------------------------------------------------------------------------------------
// Push devices (SPK-UX-001 push notification registration, SPK-COMMS-003/004, SPK-IAM-006; COM-01)
// ---------------------------------------------------------------------------------------------
export const PushPlatformSchema = z.enum(['ios', 'android', 'web']).openapi('PushPlatform');
export type PushPlatformValue = z.infer<typeof PushPlatformSchema>;
export const PushDeviceStatusSchema = z.enum(['active', 'revoked']).openapi('PushDeviceStatus');
export type PushDeviceStatusValue = z.infer<typeof PushDeviceStatusSchema>;

/** A registered device. The token is never returned, logged or audited: only its last 4 characters. */
export const PushDeviceSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    accountId: z.uuid(),
    platform: PushPlatformSchema,
    tokenHint: z.string(),
    appVersion: z.string().nullable(),
    status: PushDeviceStatusSchema,
    registeredAt: Instant,
    lastSeenAt: Instant,
    revokedAt: Instant.nullable(),
    revokedReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('PushDevice');
export type PushDevice = z.infer<typeof PushDeviceSchema>;

export const RegisterPushDeviceBody = withCommandMeta({
  platform: PushPlatformSchema,
  /** The platform push token of this app install (opaque; stored only while the device is active). */
  token: z.string().trim().min(1).max(4096),
  appVersion: z.string().trim().min(1).max(50).optional(),
}).openapi('RegisterPushDeviceRequest');
export type RegisterPushDeviceInput = z.infer<typeof RegisterPushDeviceBody>;

export const RevokePushDeviceBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokePushDeviceRequest');
export type RevokePushDeviceInput = z.infer<typeof RevokePushDeviceBody>;

export const PushDeviceListSchema = z
  .object({ devices: z.array(PushDeviceSchema) })
  .openapi('PushDeviceList');
export type PushDeviceList = z.infer<typeof PushDeviceListSchema>;

// ---------------------------------------------------------------------------------------------
// Provider delivery receipts (webhooks, §4.11): authenticated, durably recorded, duplicate-tolerant
// ---------------------------------------------------------------------------------------------
export const DeliveryReceiptStatusSchema = z
  .enum(['accepted', 'delivered', 'failed'])
  .openapi('DeliveryReceiptStatus');
export type DeliveryReceiptStatus = z.infer<typeof DeliveryReceiptStatusSchema>;

export const DeliveryReceiptSchema = z
  .object({
    attemptId: z.uuid(),
    organizationId: z.uuid(),
    providerMessageId: z.string().min(1).max(200),
    status: DeliveryReceiptStatusSchema,
    error: z.string().max(2000).nullable().default(null),
    occurredAt: Instant.optional(),
  })
  .openapi('DeliveryReceipt');
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

/** Envelope the fake messaging provider posts; a real provider adapter maps its own envelope to this. */
export const MessagingWebhookBody = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal('delivery.receipt'),
    data: DeliveryReceiptSchema,
  })
  .openapi('MessagingWebhookRequest');
export type MessagingWebhookInput = z.infer<typeof MessagingWebhookBody>;

export const WebhookAcceptedSchema = z
  .object({ inboxEventId: z.uuid(), duplicate: z.boolean() })
  .openapi('WebhookAccepted');

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

function register(input: {
  method: 'get' | 'post' | 'patch';
  path: string;
  summary: string;
  requirements: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201 | 202;
  idempotent?: boolean;
  public?: boolean;
}): void {
  const status = input.status ?? (input.method === 'post' ? 201 : 200);
  openApiRegistry.registerPath({
    method: input.method,
    path: input.path,
    summary: input.summary,
    description: `Implements ${input.requirements}.${
      input.idempotent ? ' Requires an Idempotency-Key header (§4.9).' : ''
    }`,
    tags: ['Communications'],
    ...(input.public ? { security: [] } : {}),
    request: {
      ...(input.params ? { params: input.params as never } : {}),
      ...(input.query ? { query: input.query as never } : {}),
      ...(input.body ? { body: { content: { 'application/json': { schema: input.body } } } } : {}),
    },
    responses: {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: input.response } },
      },
      400: errorResponse('Validation failed'),
      401: errorResponse('Authentication required'),
      403: errorResponse('Access denied or participant authority required'),
      404: errorResponse('Not found or not visible'),
      409: errorResponse('Conflict (stale revision, invalid transition, idempotency)'),
    },
  });
}

register({
  method: 'post',
  path: '/notifications',
  summary: 'Compose a notification against an authorized audience (staff)',
  requirements: 'SPK-COMMS-002, SPK-COMMS-006, SPK-COMMS-007',
  body: ComposeNotificationBody,
  response: NotificationSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/notifications',
  summary: 'List notifications of the organization (staff), newest first',
  requirements: 'SPK-COMMS-006, SPK-UX-006',
  query: ListNotificationsQuery,
  response: NotificationPageSchema,
});
register({
  method: 'get',
  path: '/notifications/{id}',
  summary: 'Read a notification (staff)',
  requirements: 'SPK-COMMS-006',
  params: IdParams,
  response: NotificationSchema,
});
register({
  method: 'get',
  path: '/notifications/{id}/recipients',
  summary:
    'Preview the recipients resolved from current permissions: names and count, no contact details',
  requirements: 'SPK-COMMS-003, SPK-COMMS-006',
  params: IdParams,
  response: RecipientPreviewSchema,
});
register({
  method: 'post',
  path: '/notifications/{id}/send',
  summary: 'Confirm the send: resolve recipients now and queue delivery',
  requirements: 'SPK-COMMS-003, SPK-COMMS-005, SPK-COMMS-006',
  params: IdParams,
  body: SendNotificationBody,
  response: NotificationSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'get',
  path: '/notifications/{id}/deliveries',
  summary: 'Read recipients and delivery attempts with their actual states (staff)',
  requirements: 'SPK-COMMS-004, SPK-UX-006',
  params: IdParams,
  response: NotificationDeliveriesSchema,
});
register({
  method: 'post',
  path: '/delivery-attempts/{id}/retry',
  summary:
    'Retry one failed push, email or SMS delivery as a new queued attempt; unknown outcomes and revoked recipients are refused',
  requirements: 'SPK-COMMS-004, SPK-COMMS-003, §4.7 invariant 10',
  params: IdParams,
  body: RetryDeliveryBody,
  response: DeliveryAttemptSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/me/inbox',
  summary: 'In-app notices for the authenticated person, newest first',
  requirements: 'SPK-COMMS-001, SPK-UX-003',
  query: InboxQuery,
  response: InboxPageSchema,
});
register({
  method: 'post',
  path: '/me/inbox/{id}/read',
  summary: 'Mark an in-app notice as read',
  requirements: 'SPK-COMMS-004',
  params: IdParams,
  body: MarkReadBody,
  response: InboxItemSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/me/inbox/{id}/acknowledge',
  summary: 'Acknowledge a notice (recorded once per recipient)',
  requirements: 'SPK-COMMS-004',
  params: IdParams,
  body: AcknowledgeBody,
  response: InboxItemSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'get',
  path: '/me/communication-preferences',
  summary: 'Effective channel preferences per category',
  requirements: 'SPK-COMMS-007',
  response: CommunicationPreferencesSchema,
});
register({
  method: 'patch',
  path: '/me/communication-preferences',
  summary: 'Choose channels per category; in-app operational notices cannot be disabled',
  requirements: 'SPK-COMMS-001, SPK-COMMS-007',
  body: UpdatePreferencesBody,
  response: CommunicationPreferencesSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/me/calendar-feeds',
  summary: 'List the private calendar feeds of the authenticated person (no tokens)',
  requirements: 'SPK-COMMS-008',
  response: CalendarFeedListSchema,
});
register({
  method: 'post',
  path: '/me/calendar-feeds',
  summary:
    'Create a private calendar feed; the token is returned once and a replay answers IDEMPOTENCY_SECRET_WITHHELD',
  requirements: 'SPK-COMMS-008',
  body: CreateCalendarFeedBody,
  response: CalendarFeedCreatedSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/me/calendar-feeds/{id}/revoke',
  summary: 'Revoke a calendar feed: future fetches are refused',
  requirements: 'SPK-COMMS-008, SPK-IAM-006',
  params: IdParams,
  body: RevokeCalendarFeedBody,
  response: CalendarFeedSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/me/push-devices',
  summary:
    'Register this app install for push notices; re-registering the same token refreshes it, and a token active for another account moves here',
  requirements: 'SPK-UX-001, SPK-COMMS-003, SPK-COMMS-004',
  body: RegisterPushDeviceBody,
  response: PushDeviceSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/me/push-devices',
  summary: 'Push devices registered by the signed-in account (token hints only)',
  requirements: 'SPK-UX-001',
  response: PushDeviceListSchema,
});
register({
  method: 'post',
  path: '/me/push-devices/{id}/revoke',
  summary: 'Revoke a push device: it receives nothing more and its token is erased',
  requirements: 'SPK-UX-001, SPK-IAM-006',
  params: IdParams,
  body: RevokePushDeviceBody,
  response: PushDeviceSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/webhooks/messaging/{provider}',
  summary:
    'Provider delivery receipt (signed); recorded once in the inbox and processed by a worker',
  requirements: 'SPK-COMMS-004, §4.11, §4.12',
  params: z.object({ provider: z.string() }),
  body: MessagingWebhookBody,
  response: WebhookAcceptedSchema,
  status: 202,
  public: true,
});
openApiRegistry.registerPath({
  method: 'get',
  path: '/calendar-feeds/{token}.ics',
  summary: 'Fetch a private calendar feed (iCalendar); stable event identities',
  description:
    'Implements SPK-COMMS-008. Authorized by the feed token alone; a revoked or unknown token is not found. Entries are limited to people the feed owner currently holds view over (SPK-IAM-006).',
  tags: ['Communications'],
  security: [],
  request: { params: z.object({ token: z.string() }) as never },
  responses: {
    200: {
      description: 'iCalendar document',
      content: { 'text/calendar': { schema: z.string() } },
    },
    404: errorResponse('Unknown or revoked feed'),
  },
});
