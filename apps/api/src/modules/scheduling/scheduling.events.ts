import { defineEvent, EventDetailsSchema, z } from '@sportspark/contracts';

/**
 * Scheduling domain events (§4.12). Schedule notices carry the old and new practical details so
 * communications can show "was / now" (SPK-COMMS-005) and suppress obsolete reminders.
 */
export const EventChangeKind = z.enum([
  'created',
  'published',
  'moved',
  'resized',
  'resource_changed',
  'updated',
  'canceled',
]);
export type EventChangeKind = z.infer<typeof EventChangeKind>;

export const EventChanged = defineEvent(
  'scheduling.event_changed',
  z.object({
    eventId: z.uuid(),
    facilityId: z.uuid(),
    change: EventChangeKind,
    before: EventDetailsSchema.nullable(),
    after: EventDetailsSchema.nullable(),
    sourceType: z.string().nullable(),
    sourceId: z.uuid().nullable(),
    seriesId: z.uuid().nullable(),
    /** Parties committed to the event (teams, people, equipment) for audience resolution. */
    commitments: z.array(
      z.object({ partyType: z.enum(['team', 'person', 'equipment']), partyId: z.uuid() }),
    ),
    publicationId: z.uuid().nullable(),
    closureId: z.uuid().nullable(),
    reason: z.string().nullable(),
    /**
     * The event's revision after this change. The outbox does not order events per aggregate (a
     * retried delivery can arrive after a newer one), so projections compare it and never apply
     * an older change (§4.12, §4.6). Optional only for events enqueued before it was carried.
     */
    revision: z.number().int().positive().optional(),
  }),
);

export const SchedulePublished = defineEvent(
  'scheduling.schedule_published',
  z.object({
    publicationId: z.uuid(),
    draftId: z.uuid(),
    facilityId: z.uuid(),
    eventIds: z.array(z.uuid()),
    changes: z.array(z.object({ sequence: z.number().int(), kind: z.string(), eventId: z.uuid() })),
    remainingObligations: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
        owner: z.string(),
        deadline: z.string().nullable(),
      }),
    ),
  }),
);

export const ClosureApplied = defineEvent(
  'scheduling.closure_applied',
  z.object({
    closureId: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    interval: z.object({ start: z.string(), end: z.string() }),
    reason: z.string(),
    source: z.enum(['manual', 'maintenance', 'holiday']),
    mode: z.enum(['cancel_affected', 'leave_for_resolution']),
    canceledEventIds: z.array(z.uuid()),
    unresolvedEventIds: z.array(z.uuid()),
    sourceRecords: z.array(
      z.object({ sourceType: z.string(), sourceId: z.uuid(), eventIds: z.array(z.uuid()) }),
    ),
  }),
);

export const ClosureLifted = defineEvent(
  'scheduling.closure_lifted',
  z.object({
    closureId: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    interval: z.object({ start: z.string(), end: z.string() }),
  }),
);

export const SchedulingEvents = { EventChanged, SchedulePublished, ClosureApplied, ClosureLifted };
