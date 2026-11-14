import {
  defineEvent,
  DeliveryChannelSchema,
  DeliveryFailureCodeSchema,
  MessageSubjectTypeSchema,
  NotificationCategorySchema,
  NotificationKindSchema,
  PushPlatformSchema,
  ScheduledMessageAttentionSchema,
  ScheduledMessageStatusSchema,
  SuppressionReasonSchema,
  z,
} from '@sportspark/contracts';

/**
 * Communications domain events (§4.12; catalogue in docs/architecture/api-and-events.md §9.5).
 * Payloads carry identifiers only, never message bodies, names or contact details (§4.14).
 */
export const NotificationComposed = defineEvent(
  'communications.notification_composed',
  z.object({
    notificationId: z.uuid(),
    kind: NotificationKindSchema,
    category: NotificationCategorySchema,
    protected: z.boolean(),
  }),
);

export const NotificationQueued = defineEvent(
  'communications.notification_queued',
  z.object({
    notificationId: z.uuid(),
    recipientCount: z.number().int().min(0),
    scheduledFor: z.iso.datetime().nullable(),
    supersedesNotificationId: z.uuid().nullable(),
  }),
);

/**
 * Follow-up consumed by this module's own dispatch handler: re-check recipients against current
 * authority and create the delivery attempts (SPK-COMMS-003). `availableAt` carries reminders.
 */
export const DeliveryRequested = defineEvent(
  'communications.delivery_requested',
  z.object({ notificationId: z.uuid() }),
);

export const NotificationDispatched = defineEvent(
  'communications.notification_dispatched',
  z.object({
    notificationId: z.uuid(),
    authorizedRecipients: z.number().int().min(0),
    revokedRecipients: z.number().int().min(0),
    attempts: z.number().int().min(0),
  }),
);

export const NotificationSuppressed = defineEvent(
  'communications.notification_suppressed',
  z.object({
    notificationId: z.uuid(),
    reason: SuppressionReasonSchema,
    supersededByNotificationId: z.uuid().nullable(),
  }),
);

/** Invariant 10 / SPK-AT-017: a recipient lost authority before anything reached an external channel. */
export const RecipientRevoked = defineEvent(
  'communications.recipient_revoked',
  z.object({
    notificationId: z.uuid(),
    recipientId: z.uuid(),
    personId: z.uuid(),
    reason: z.string(),
  }),
);

const attemptPayload = {
  attemptId: z.uuid(),
  notificationId: z.uuid(),
  recipientId: z.uuid(),
  channel: DeliveryChannelSchema,
  provider: z.string(),
};

export const DeliveryProviderAccepted = defineEvent(
  'communications.delivery_provider_accepted',
  z.object(attemptPayload),
);
export const DeliveryDelivered = defineEvent(
  'communications.delivery_delivered',
  z.object(attemptPayload),
);
export const DeliveryFailed = defineEvent(
  'communications.delivery_failed',
  z.object({ ...attemptPayload, failureCode: DeliveryFailureCodeSchema, error: z.string() }),
);
/**
 * A push notification is not guaranteed delivery: unknown stays unknown until a receipt resolves it
 * or staff reconcile it (an essential notice's is a front-desk exception meanwhile, §4.11, §5.11).
 */
export const DeliveryUnknown = defineEvent(
  'communications.delivery_unknown',
  z.object({ ...attemptPayload, error: z.string().nullable() }),
);
export const NotificationRead = defineEvent(
  'communications.notification_read',
  z.object({ ...attemptPayload, personId: z.uuid() }),
);
export const NotificationAcknowledged = defineEvent(
  'communications.notification_acknowledged',
  z.object({ ...attemptPayload, personId: z.uuid(), acknowledgmentId: z.uuid() }),
);

export const CalendarFeedCreated = defineEvent(
  'communications.calendar_feed_created',
  z.object({ feedId: z.uuid(), personId: z.uuid(), subjectCount: z.number().int().min(0) }),
);
/** SPK-COMMS-008: future fetches are refused; erasure from an external calendar cannot be guaranteed. */
export const CalendarFeedRevoked = defineEvent(
  'communications.calendar_feed_revoked',
  z.object({ feedId: z.uuid(), personId: z.uuid() }),
);

/** COM-02 (SPK-COMMS-004): a failed external delivery was retried as a new queued attempt. */
export const DeliveryRetryQueued = defineEvent(
  'communications.delivery_retry_queued',
  z.object({ ...attemptPayload, retryOfAttemptId: z.uuid() }),
);

/** COM-01 (SPK-UX-001): a device was registered for push; the token never travels in an event. */
export const PushDeviceRegistered = defineEvent(
  'communications.push_device_registered',
  z.object({
    deviceId: z.uuid(),
    personId: z.uuid(),
    accountId: z.uuid(),
    platform: PushPlatformSchema,
  }),
);
/** COM-01 (SPK-IAM-006, SPK-AT-025): a device receives nothing more; its token is erased. */
export const PushDeviceRevoked = defineEvent(
  'communications.push_device_revoked',
  z.object({
    deviceId: z.uuid(),
    personId: z.uuid(),
    accountId: z.uuid(),
    reason: z.string(),
  }),
);

/**
 * SPK-COMMS-009 (proposed amendment PA-05): a sequence produced scheduled messages for a season
 * or an offering (from the record's own event, or because staff asked for the schedule).
 */
export const MessageScheduleGenerated = defineEvent(
  'communications.message_schedule_generated',
  z.object({
    subjectType: MessageSubjectTypeSchema,
    subjectId: z.uuid(),
    sequenceId: z.uuid(),
    scheduledMessageIds: z.array(z.uuid()),
  }),
);
/**
 * SPK-COMMS-009: a scheduled message was confirmed, edited, skipped, restored, canceled, moved
 * with its anchor date, or returned to needing confirmation. Never the text itself.
 */
export const ScheduledMessageChanged = defineEvent(
  'communications.scheduled_message_changed',
  z.object({
    scheduledMessageId: z.uuid(),
    subjectType: MessageSubjectTypeSchema,
    subjectId: z.uuid(),
    change: z.enum([
      'confirmed',
      'edited',
      'skipped',
      'restored',
      'canceled',
      'rescheduled',
      'reopened',
    ]),
    status: ScheduledMessageStatusSchema,
    previousStatus: ScheduledMessageStatusSchema,
    attention: ScheduledMessageAttentionSchema.nullable(),
    dueAt: z.iso.datetime().nullable(),
  }),
);
/** SPK-COMMS-009: a confirmed message was sent when it was due, as the notification named. */
export const ScheduledMessageSent = defineEvent(
  'communications.scheduled_message_sent',
  z.object({
    scheduledMessageId: z.uuid(),
    notificationId: z.uuid(),
    subjectType: MessageSubjectTypeSchema,
    subjectId: z.uuid(),
  }),
);

export const CommunicationsEvents = {
  NotificationComposed,
  NotificationQueued,
  DeliveryRequested,
  NotificationDispatched,
  NotificationSuppressed,
  RecipientRevoked,
  DeliveryProviderAccepted,
  DeliveryDelivered,
  DeliveryFailed,
  DeliveryUnknown,
  NotificationRead,
  NotificationAcknowledged,
  CalendarFeedCreated,
  CalendarFeedRevoked,
  DeliveryRetryQueued,
  PushDeviceRegistered,
  PushDeviceRevoked,
  MessageScheduleGenerated,
  ScheduledMessageChanged,
  ScheduledMessageSent,
} as const;
