import { z } from '../zod';
import { Revision } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import {
  CommunicationsRequestText,
  NotificationCategorySchema,
  NotificationStatusSchema,
  RecipientBasisSchema,
  SuppressionReasonSchema,
} from './communications';

/**
 * Message templates and sequences (SPK-COMMS-009, proposed amendment PA-05; capability
 * `message_sequences`, DEC-099). Proposed. Staff keep reusable templates (a title and a body with
 * named placeholders) and sequences (ordered steps, each a template and a time relative to an
 * anchor date of a season or an offering). A sequence produces a season's or an offering's message
 * schedule: one scheduled message per step. Nothing is sent until a staff member confirms it, and
 * a confirmed message is sent when it is due through the notification path, so recipients, consent
 * and preferences are resolved at send time (SPK-COMMS-003, SPK-COMMS-006, SPK-COMMS-007).
 */

const { singleLine, multiLine, withRequestMeta } = CommunicationsRequestText;
const TAG = 'Communications';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------
/** What a sequence, and so a schedule, is about. */
export const MessageSubjectTypeSchema = z
  .enum(['season', 'offering'])
  .openapi('MessageSubjectType');
export type MessageSubjectType = z.infer<typeof MessageSubjectTypeSchema>;

/**
 * The date of the season or offering a step's time is counted from. `first_game` exists for a
 * season only: the earliest scheduled game.
 */
export const MessageAnchorSchema = z
  .enum(['registration_opens', 'registration_closes', 'starts', 'ends', 'first_game'])
  .openapi('MessageAnchor');
export type MessageAnchor = z.infer<typeof MessageAnchorSchema>;

/** The anchors a sequence about each kind of record may use. */
export const MESSAGE_ANCHORS_BY_SUBJECT: Record<MessageSubjectType, readonly MessageAnchor[]> = {
  season: ['registration_opens', 'registration_closes', 'starts', 'ends', 'first_game'],
  offering: ['registration_opens', 'registration_closes', 'starts', 'ends'],
};

/**
 * The named placeholders a template may hold, written `{{name}}`, and the kinds of record that can
 * fill each. A placeholder the record cannot fill is never sent as raw text: the preview names it
 * and the message cannot be confirmed until it is filled or the text is edited.
 */
export const MESSAGE_PLACEHOLDERS = {
  season_name: { label: 'Season name', subjects: ['season'] },
  competition_name: { label: 'Competition name', subjects: ['season'] },
  offering_name: { label: 'Offering name', subjects: ['offering'] },
  start_date: { label: 'Start date', subjects: ['season', 'offering'] },
  end_date: { label: 'End date', subjects: ['season', 'offering'] },
  registration_opens_date: {
    label: 'Date registration opens',
    subjects: ['season', 'offering'],
  },
  registration_closes_date: {
    label: 'Date registration closes',
    subjects: ['season', 'offering'],
  },
  first_game_date: { label: 'First game date', subjects: ['season'] },
  first_game_time: { label: 'First game time', subjects: ['season'] },
  field: { label: 'Field', subjects: ['season', 'offering'] },
  facility_name: { label: 'Facility name', subjects: ['season', 'offering'] },
} as const satisfies Record<string, { label: string; subjects: readonly MessageSubjectType[] }>;
export type MessagePlaceholderName = keyof typeof MESSAGE_PLACEHOLDERS;
export const MESSAGE_PLACEHOLDER_NAMES = Object.keys(
  MESSAGE_PLACEHOLDERS,
) as MessagePlaceholderName[];

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** The placeholder names written in the text, in order of first appearance. */
export function messagePlaceholdersIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * What is wrong with the placeholders of a text, or null: a name outside the vocabulary, or a
 * `{{` or `}}` that is not part of a placeholder (a typing slip that would otherwise be sent as
 * written).
 */
export function messagePlaceholderProblem(text: string): string | null {
  const unknown = messagePlaceholdersIn(text).filter((name) => !(name in MESSAGE_PLACEHOLDERS));
  if (unknown.length > 0) {
    return `Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}.`;
  }
  const rest = text.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    return 'Double braces are kept for placeholders such as {{season_name}}: this text has one that is not a placeholder.';
  }
  return null;
}

/**
 * Fills the placeholders that have a value and names the ones that do not. A placeholder without a
 * value stays in the text exactly as written, so a preview shows where it is; `missing` is then
 * not empty and the text must not be sent.
 */
export function renderMessageText(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = text.replace(PLACEHOLDER, (written: string, name: string) => {
    const value = values[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (!missing.includes(name)) missing.push(name);
    return written;
  });
  return { text: rendered, missing };
}

/** True when the text still holds placeholder marks, so it must never be sent as it is. */
export function hasPlaceholderMarks(text: string): boolean {
  return text.includes('{{') || text.includes('}}');
}

const placeholdersKnown = (value: string, ctx: z.RefinementCtx): void => {
  const problem = messagePlaceholderProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
};

const Name = singleLine(z.string().trim().min(1).max(200));
const TemplateTitle = singleLine(z.string().trim().min(1).max(200)).superRefine(placeholdersKnown);
const TemplateBody = multiLine(z.string().trim().min(1).max(4000)).superRefine(placeholdersKnown);
const Reason = multiLine(z.string().trim().min(1).max(2000));
/** A facility-local wall-clock time, `HH:MM` (SPK-SCHED-008). */
export const LocalSendTimeSchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Must be a time of day such as 09:00.');
const OffsetDays = z.number().int().min(-365).max(365);

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------
export const MessageTemplateStatusSchema = z
  .enum(['active', 'archived'])
  .openapi('MessageTemplateStatus');
export type MessageTemplateStatus = z.infer<typeof MessageTemplateStatusSchema>;

export const MessageTemplateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** SPK-COMMS-007: a template is essential or promotional, and so is every message made from it. */
    category: NotificationCategorySchema,
    title: z.string(),
    body: z.string(),
    /** The placeholder names the title and body hold. */
    placeholders: z.array(z.string()),
    status: MessageTemplateStatusSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('MessageTemplate');
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;

export const MessageTemplateListSchema = z
  .object({ items: z.array(MessageTemplateSchema) })
  .openapi('MessageTemplateList');
export type MessageTemplateList = z.infer<typeof MessageTemplateListSchema>;

export const CreateMessageTemplateBody = withRequestMeta({
  name: Name,
  category: NotificationCategorySchema,
  title: TemplateTitle,
  body: TemplateBody,
}).openapi('CreateMessageTemplateRequest');
export type CreateMessageTemplateInput = z.infer<typeof CreateMessageTemplateBody>;

/**
 * The category is not among the fields: a template stays essential or promotional for good
 * (SPK-COMMS-007), so a message confirmed as one is never sent as the other. A different category
 * is a new template.
 */
export const UpdateMessageTemplateBody = withRequestMeta({
  name: Name.optional(),
  title: TemplateTitle.optional(),
  body: TemplateBody.optional(),
  status: MessageTemplateStatusSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateMessageTemplateRequest');
export type UpdateMessageTemplateInput = z.infer<typeof UpdateMessageTemplateBody>;

export const ListMessageTemplatesQuery = z.object({
  status: MessageTemplateStatusSchema.optional(),
});
export type ListMessageTemplatesQuery = z.infer<typeof ListMessageTemplatesQuery>;

export const MessagePlaceholderSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    subjects: z.array(MessageSubjectTypeSchema),
  })
  .openapi('MessagePlaceholder');
export const MessagePlaceholderListSchema = z
  .object({ items: z.array(MessagePlaceholderSchema) })
  .openapi('MessagePlaceholderList');
export type MessagePlaceholderList = z.infer<typeof MessagePlaceholderListSchema>;

// ---------------------------------------------------------------------------------------------
// Sequences and their steps
// ---------------------------------------------------------------------------------------------
export const MessageSequenceStepSchema = z
  .object({
    id: z.uuid(),
    sequenceId: z.uuid(),
    position: z.number().int().min(1),
    templateId: z.uuid(),
    templateName: z.string(),
    anchor: MessageAnchorSchema,
    /** Days from the anchor date: negative before it, zero on the day, positive after it. */
    offsetDays: z.number().int(),
    /** The time of day chosen for this step, or null to use the policy's time. */
    sendTimeLocal: z.string().nullable(),
    /** The facility-local time of day the step's messages are due at. */
    effectiveSendTimeLocal: z.string(),
    /** Set when the step was removed: it produces no more messages. */
    retiredAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('MessageSequenceStep');
export type MessageSequenceStep = z.infer<typeof MessageSequenceStepSchema>;

export const MessageSequenceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** The facility whose local time the steps are read in and whose staff manage the sequence. */
    facilityId: z.uuid(),
    subjectType: MessageSubjectTypeSchema,
    /**
     * The competition (for seasons) or program (for offerings) the sequence belongs to; null for
     * every season, or every offering of the facility.
     */
    scopeId: z.uuid().nullable(),
    /** Only an active sequence produces schedules. */
    active: z.boolean(),
    steps: z.array(MessageSequenceStepSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('MessageSequence');
export type MessageSequence = z.infer<typeof MessageSequenceSchema>;

export const MessageSequenceListSchema = z
  .object({ items: z.array(MessageSequenceSchema) })
  .openapi('MessageSequenceList');
export type MessageSequenceList = z.infer<typeof MessageSequenceListSchema>;

export const CreateMessageSequenceBody = withRequestMeta({
  name: Name,
  facilityId: z.uuid(),
  subjectType: MessageSubjectTypeSchema,
  scopeId: z.uuid().optional(),
}).openapi('CreateMessageSequenceRequest');
export type CreateMessageSequenceInput = z.infer<typeof CreateMessageSequenceBody>;

export const UpdateMessageSequenceBody = withRequestMeta({
  name: Name.optional(),
  scopeId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateMessageSequenceRequest');
export type UpdateMessageSequenceInput = z.infer<typeof UpdateMessageSequenceBody>;

export const ListMessageSequencesQuery = z.object({
  facilityId: z.uuid().optional(),
  subjectType: MessageSubjectTypeSchema.optional(),
});
export type ListMessageSequencesQuery = z.infer<typeof ListMessageSequencesQuery>;

export const AddMessageSequenceStepBody = withRequestMeta({
  templateId: z.uuid(),
  anchor: MessageAnchorSchema,
  offsetDays: OffsetDays,
  sendTimeLocal: LocalSendTimeSchema.optional(),
  /** Where the step stands in the sequence; default: after the last one. */
  position: z.number().int().min(1).max(500).optional(),
}).openapi('AddMessageSequenceStepRequest');
export type AddMessageSequenceStepInput = z.infer<typeof AddMessageSequenceStepBody>;

export const UpdateMessageSequenceStepBody = withRequestMeta({
  templateId: z.uuid().optional(),
  anchor: MessageAnchorSchema.optional(),
  offsetDays: OffsetDays.optional(),
  sendTimeLocal: LocalSendTimeSchema.nullable().optional(),
  position: z.number().int().min(1).max(500).optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateMessageSequenceStepRequest');
export type UpdateMessageSequenceStepInput = z.infer<typeof UpdateMessageSequenceStepBody>;

export const RemoveMessageSequenceStepBody = withRequestMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('RemoveMessageSequenceStepRequest');
export type RemoveMessageSequenceStepInput = z.infer<typeof RemoveMessageSequenceStepBody>;

// ---------------------------------------------------------------------------------------------
// Scheduled messages
// ---------------------------------------------------------------------------------------------
/** Exactly the ScheduledMessageMachine states (state-machines.ts) and the database check. */
export const ScheduledMessageStatusSchema = z
  .enum(['needs_confirmation', 'confirmed', 'skipped', 'sent', 'canceled'])
  .openapi('ScheduledMessageStatus');
export type ScheduledMessageStatus = z.infer<typeof ScheduledMessageStatusSchema>;

/**
 * Why a message that staff had confirmed needs confirming again: its anchor date moved, the text
 * that would be sent is no longer the text that was confirmed, nobody was there to receive it when
 * it was due, or its audience is larger than one notice may address.
 */
export const ScheduledMessageAttentionSchema = z
  .enum(['anchor_moved', 'text_changed', 'no_audience', 'audience_too_large'])
  .openapi('ScheduledMessageAttention');
export type ScheduledMessageAttention = z.infer<typeof ScheduledMessageAttentionSchema>;

export const MessageSubjectSchema = z
  .object({ type: MessageSubjectTypeSchema, id: z.uuid() })
  .openapi('MessageSubject');
export type MessageSubject = z.infer<typeof MessageSubjectSchema>;

/** What the message produced when it was sent (SPK-COMMS-004: the actual state, never a guess). */
export const ScheduledMessageDeliverySchema = z
  .object({
    notificationId: z.uuid(),
    notificationStatus: NotificationStatusSchema,
    suppressionReason: SuppressionReasonSchema.nullable(),
    /** The people the notice was resolved to when it was sent. */
    recipientCount: z.number().int().min(0),
  })
  .openapi('ScheduledMessageDelivery');

export const ScheduledMessageSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    subject: MessageSubjectSchema,
    sequenceId: z.uuid(),
    sequenceName: z.string(),
    stepId: z.uuid(),
    templateId: z.uuid(),
    templateName: z.string(),
    category: NotificationCategorySchema,
    anchor: MessageAnchorSchema,
    offsetDays: z.number().int(),
    sendTimeLocal: z.string(),
    /** The anchor date the due time was counted from; null while the record has none. */
    anchorAt: Instant.nullable(),
    /** When the message is due; null while its anchor date is not known. */
    dueAt: Instant.nullable(),
    status: ScheduledMessageStatusSchema,
    attention: ScheduledMessageAttentionSchema.nullable(),
    /** True when staff keep an edited copy of the title and body for this message. */
    edited: z.boolean(),
    /**
     * The title and body as they stand: what was sent (sent), what was confirmed (confirmed), or
     * the template or edited copy with the record's details filled in now.
     */
    title: z.string(),
    body: z.string(),
    /** The title and body before details are filled in: the edited copy, else the template's. */
    sourceTitle: z.string(),
    sourceBody: z.string(),
    /** Placeholders the record cannot fill now; confirming is refused while there is one. */
    missingPlaceholders: z.array(z.string()),
    confirmedAt: Instant.nullable(),
    skippedAt: Instant.nullable(),
    skipReason: z.string().nullable(),
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    sentAt: Instant.nullable(),
    delivery: ScheduledMessageDeliverySchema.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ScheduledMessage');
export type ScheduledMessage = z.infer<typeof ScheduledMessageSchema>;

export const MessageScheduleSchema = z
  .object({
    subject: MessageSubjectSchema,
    /** The season's or offering's name. */
    subjectName: z.string(),
    facilityId: z.uuid().nullable(),
    /** The facility zone the due times are shown in (SPK-SCHED-008); null without a schedule. */
    timezone: z.string().nullable(),
    /** The active sequences that apply to this record. */
    sequences: z.array(z.object({ id: z.uuid(), name: z.string() })),
    messages: z.array(ScheduledMessageSchema),
  })
  .openapi('MessageSchedule');
export type MessageSchedule = z.infer<typeof MessageScheduleSchema>;

export const MessageRecipientPreviewEntrySchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    basis: RecipientBasisSchema,
    /** False when the person has every channel switched off for this category (SPK-COMMS-007). */
    reachable: z.boolean(),
  })
  .openapi('MessageRecipientPreviewEntry');

/** SPK-COMMS-006: the text with real details and who would receive it now; never a contact list. */
export const ScheduledMessagePreviewSchema = z
  .object({
    scheduledMessageId: z.uuid(),
    status: ScheduledMessageStatusSchema,
    category: NotificationCategorySchema,
    title: z.string(),
    body: z.string(),
    missingPlaceholders: z.array(z.object({ name: z.string(), label: z.string() })),
    dueAt: Instant.nullable(),
    /** Why confirming would be refused now; empty when it would be accepted. */
    blockers: z.array(
      z.enum(['missing_placeholder', 'no_due_time', 'text_too_long', 'not_awaiting_confirmation']),
    ),
    /** Recipients are resolved from current permissions now and again when the message is sent. */
    recipients: z.object({
      resolvedAt: Instant,
      count: z.number().int().min(0),
      reachableCount: z.number().int().min(0),
      /** True when the audience is larger than one notice may address. */
      tooLarge: z.boolean(),
      entries: z.array(MessageRecipientPreviewEntrySchema),
    }),
  })
  .openapi('ScheduledMessagePreview');
export type ScheduledMessagePreview = z.infer<typeof ScheduledMessagePreviewSchema>;

/**
 * Keeps an edited copy of the title and body for this message only (the template is not changed),
 * or drops the copy when both are null. A confirmed message returns to needing confirmation.
 */
export const EditScheduledMessageBody = withRequestMeta({
  title: TemplateTitle.nullable(),
  body: TemplateBody.nullable(),
})
  .extend({ expectedRevision: Revision })
  .refine((value) => (value.title === null) === (value.body === null), {
    message: 'Give both a title and a body, or null for both to go back to the template.',
    path: ['body'],
  })
  .openapi('EditScheduledMessageRequest');
export type EditScheduledMessageInput = z.infer<typeof EditScheduledMessageBody>;

export const ConfirmScheduledMessageBody = withRequestMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ConfirmScheduledMessageRequest');
export type ConfirmScheduledMessageInput = z.infer<typeof ConfirmScheduledMessageBody>;

export const SkipScheduledMessageBody = withRequestMeta({ reason: Reason.optional() })
  .extend({ expectedRevision: Revision })
  .openapi('SkipScheduledMessageRequest');
export type SkipScheduledMessageInput = z.infer<typeof SkipScheduledMessageBody>;

export const RestoreScheduledMessageBody = withRequestMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('RestoreScheduledMessageRequest');
export type RestoreScheduledMessageInput = z.infer<typeof RestoreScheduledMessageBody>;

export const GenerateMessageScheduleBody = withRequestMeta({}).openapi(
  'GenerateMessageScheduleRequest',
);
export type GenerateMessageScheduleInput = z.infer<typeof GenerateMessageScheduleBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const StepParams = z.object({ id: z.uuid(), stepId: z.uuid() });
export const MessageScheduleParams = z.object({
  subjectType: MessageSubjectTypeSchema,
  subjectId: z.uuid(),
});
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const PROPOSED = 'SPK-COMMS-009, proposed';

function paramsOf(path: string) {
  if (path.includes('{subjectType}')) return MessageScheduleParams;
  if (path.includes('{stepId}')) return StepParams;
  if (path.includes('{id}')) return IdParams;
  return undefined;
}

function command(
  method: 'post' | 'patch',
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 200,
  /** False for the commands that create nothing and so stay available while the switch is off. */
  gated = true,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary: `${summary} (${PROPOSED})`,
    description: `Implements SPK-COMMS-009 (proposed amendment PA-05, DEC-099 pending). Requires an Idempotency-Key header (§4.9). ${
      gated
        ? 'Refused with ACCESS_DENIED `CAPABILITY_DISABLED` while the organization has not turned message sequences on.'
        : 'It creates nothing, so it stays available while message sequences are turned off.'
    }`,
    tags: [TAG],
    request: {
      params: paramsOf(path),
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied, or the capability is turned off'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  response: z.ZodType,
  request?: z.ZodObject<z.ZodRawShape>,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary: `${summary} (${PROPOSED})`,
    description:
      'Implements SPK-COMMS-009 (proposed amendment PA-05, DEC-099 pending). A read: available whether or not message sequences are turned on.',
    tags: [TAG],
    request: { params: paramsOf(path), query: request },
    responses: {
      200: ok('Result', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/message-placeholders',
  'The named placeholders a template may hold and the records that fill them',
  MessagePlaceholderListSchema,
);
query(
  '/message-templates',
  'Reusable message templates',
  MessageTemplateListSchema,
  ListMessageTemplatesQuery,
);
command(
  'post',
  '/message-templates',
  'Create a message template',
  CreateMessageTemplateBody,
  MessageTemplateSchema,
  201,
);
query('/message-templates/{id}', 'One message template', MessageTemplateSchema);
command(
  'patch',
  '/message-templates/{id}',
  'Change or archive a message template; messages already sent keep their text',
  UpdateMessageTemplateBody,
  MessageTemplateSchema,
);
query(
  '/message-sequences',
  'Message sequences with their steps',
  MessageSequenceListSchema,
  ListMessageSequencesQuery,
);
command(
  'post',
  '/message-sequences',
  'Create a message sequence for seasons or offerings; it produces nothing until it is active',
  CreateMessageSequenceBody,
  MessageSequenceSchema,
  201,
);
query('/message-sequences/{id}', 'One message sequence with its steps', MessageSequenceSchema);
command(
  'patch',
  '/message-sequences/{id}',
  'Rename a message sequence, change what it belongs to, or switch it on or off',
  UpdateMessageSequenceBody,
  MessageSequenceSchema,
);
command(
  'post',
  '/message-sequences/{id}/steps',
  'Add a step: a template and a time relative to an anchor date',
  AddMessageSequenceStepBody,
  MessageSequenceSchema,
  201,
);
command(
  'patch',
  '/message-sequences/{id}/steps/{stepId}',
  'Change a step; its unsent messages follow and need confirming again',
  UpdateMessageSequenceStepBody,
  MessageSequenceSchema,
);
command(
  'post',
  '/message-sequences/{id}/steps/{stepId}/remove',
  'Remove a step; its unsent messages are canceled and what was sent is kept',
  RemoveMessageSequenceStepBody,
  MessageSequenceSchema,
  200,
  false,
);
query(
  '/message-schedules/{subjectType}/{subjectId}',
  "A season's or an offering's message schedule: what is waiting, confirmed, skipped and sent",
  MessageScheduleSchema,
);
command(
  'post',
  '/message-schedules/{subjectType}/{subjectId}/generate',
  'Produce the schedule of a season or an offering from the sequences that apply; existing messages are kept',
  GenerateMessageScheduleBody,
  MessageScheduleSchema,
);
query('/scheduled-messages/{id}', 'One scheduled message', ScheduledMessageSchema);
query(
  '/scheduled-messages/{id}/preview',
  'The text with real details filled in and who would receive it now (SPK-COMMS-006)',
  ScheduledMessagePreviewSchema,
);
command(
  'post',
  '/scheduled-messages/{id}/edit',
  'Keep an edited copy of the title and body for this message; the template is not changed',
  EditScheduledMessageBody,
  ScheduledMessageSchema,
);
command(
  'post',
  '/scheduled-messages/{id}/confirm',
  'Confirm a scheduled message: it is sent when it is due, to the recipients resolved then',
  ConfirmScheduledMessageBody,
  ScheduledMessageSchema,
);
command(
  'post',
  '/scheduled-messages/{id}/skip',
  'Skip a scheduled message: it is not sent',
  SkipScheduledMessageBody,
  ScheduledMessageSchema,
  200,
  false,
);
command(
  'post',
  '/scheduled-messages/{id}/restore',
  'Bring a skipped message back to needing confirmation',
  RestoreScheduledMessageBody,
  ScheduledMessageSchema,
);
