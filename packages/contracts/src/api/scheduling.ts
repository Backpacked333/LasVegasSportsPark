import { z } from '../zod';
import { CommandMetaSchema, Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { IanaTimezone, Instant, IntervalSchema } from '../time';

/**
 * Scheduling API contract (specification §3.7 SPK-SCHED-001..009, §3.8 SPK-FIX-005, §4.8).
 * Organization scope always comes from the principal; facility ids in bodies are validated against it.
 */

// ---------------------------------------------------------------------------------------------
// Enumerations (mirrored by the database check constraints in migration 0300)
// ---------------------------------------------------------------------------------------------

export const ResourceKind = z.enum(['pitch', 'subdivision', 'room', 'other']);
export type ResourceKind = z.infer<typeof ResourceKind>;
export const ResourceStatus = z.enum(['active', 'restricted', 'closed']);
export type ResourceStatus = z.infer<typeof ResourceStatus>;
export const EventKind = z.enum([
  'game',
  'practice',
  'session',
  'rental',
  'party',
  'pickup',
  'maintenance',
  'block',
]);
export type EventKind = z.infer<typeof EventKind>;
export const EventStatus = z.enum(['draft', 'published', 'canceled']);
export type EventStatus = z.infer<typeof EventStatus>;
export const DstResolution = z.enum(['exact', 'shifted_forward', 'first', 'second']);
export type DstResolution = z.infer<typeof DstResolution>;
export const NonexistentTimePolicy = z.enum(['shift_forward', 'skip']);
export type NonexistentTimePolicy = z.infer<typeof NonexistentTimePolicy>;
export const AmbiguousTimePolicy = z.enum(['first', 'second']);
export type AmbiguousTimePolicy = z.infer<typeof AmbiguousTimePolicy>;
export const ClosureSource = z.enum(['manual', 'maintenance', 'holiday']);
export type ClosureSource = z.infer<typeof ClosureSource>;
export const ClosureStatus = z.enum(['pending', 'active', 'lifted', 'withdrawn']);
export type ClosureStatus = z.infer<typeof ClosureStatus>;
export const ClosureResolutionMode = z.enum(['cancel_affected', 'leave_for_resolution']);
export type ClosureResolutionMode = z.infer<typeof ClosureResolutionMode>;
export const ScheduleDraftStatus = z.enum([
  'editing',
  'validated',
  'publishing',
  'published',
  'failed',
  'discarded',
]);
export type ScheduleDraftStatus = z.infer<typeof ScheduleDraftStatus>;
export const DraftChangeKind = z.enum(['create', 'move', 'cancel', 'resize', 'resource_change']);
export type DraftChangeKind = z.infer<typeof DraftChangeKind>;
export const PartyType = z.enum(['team', 'person', 'equipment']);
export type PartyType = z.infer<typeof PartyType>;
export const SeriesEditScope = z.enum(['one', 'this_and_future', 'entire_series']);
export type SeriesEditScope = z.infer<typeof SeriesEditScope>;

/** Facility-local wall-clock time 'HH:MM' (24:00 allowed as a closing time). */
export const LocalTime = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'local time must be HH:MM');
export type LocalTime = z.infer<typeof LocalTime>;
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'local date must be YYYY-MM-DD');
export type LocalDate = z.infer<typeof LocalDate>;
export const Weekday = z.number().int().min(0).max(6);

const Minutes = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);

// ---------------------------------------------------------------------------------------------
// Inventory (SPK-SCHED-001/002)
// ---------------------------------------------------------------------------------------------

export const ResourceSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    kind: ResourceKind,
    name: z.string(),
    parentResourceId: z.uuid().nullable(),
    dimensions: z.record(z.string(), z.unknown()),
    compatibleFormats: z.array(z.string()),
    defaultSetupMinutes: z.number().int(),
    defaultCleanupMinutes: z.number().int(),
    requiredEquipment: z.array(z.unknown()),
    staffingConstraints: z.record(z.string(), z.unknown()),
    status: ResourceStatus,
    conflictUnitIds: z.array(z.uuid()),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Resource');
export type Resource = z.infer<typeof ResourceSchema>;

export const CreateResourceBody = withCommandMeta({
  facilityId: z.uuid(),
  kind: ResourceKind,
  name: z.string().min(1).max(200),
  parentResourceId: z.uuid().optional(),
  dimensions: z.record(z.string(), z.unknown()).optional(),
  compatibleFormats: z.array(z.string().min(1).max(50)).max(50).optional(),
  defaultSetupMinutes: Minutes.optional(),
  defaultCleanupMinutes: Minutes.optional(),
  requiredEquipment: z.array(z.unknown()).max(100).optional(),
  staffingConstraints: z.record(z.string(), z.unknown()).optional(),
  /** Conflict units this resource occupies. Omitted: a dedicated unit is created for the resource. */
  conflictUnitIds: z.array(z.uuid()).max(100).optional(),
}).openapi('CreateResourceBody');
export type CreateResourceBody = z.infer<typeof CreateResourceBody>;

export const UpdateResourceBody = withCommandMeta({
  name: z.string().min(1).max(200).optional(),
  dimensions: z.record(z.string(), z.unknown()).optional(),
  compatibleFormats: z.array(z.string().min(1).max(50)).max(50).optional(),
  defaultSetupMinutes: Minutes.optional(),
  defaultCleanupMinutes: Minutes.optional(),
  requiredEquipment: z.array(z.unknown()).max(100).optional(),
  staffingConstraints: z.record(z.string(), z.unknown()).optional(),
  status: ResourceStatus.optional(),
  conflictUnitIds: z.array(z.uuid()).min(1).max(100).optional(),
})
  // §4.9: a sensitive stale edit fails rather than overwrite newer work
  .extend({ expectedRevision: Revision })
  .openapi('UpdateResourceBody');
export type UpdateResourceBody = z.infer<typeof UpdateResourceBody>;

export const ListResourcesQuery = z.object({ facilityId: z.uuid() });

export const ResourceConfigurationSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    active: z.boolean(),
    memberResourceIds: z.array(z.uuid()),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ResourceConfiguration');
export type ResourceConfiguration = z.infer<typeof ResourceConfigurationSchema>;

export const CreateResourceConfigurationBody = withCommandMeta({
  facilityId: z.uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  active: z.boolean().optional(),
  /** Resources that may operate simultaneously under this arrangement. */
  memberResourceIds: z.array(z.uuid()).min(1).max(100),
}).openapi('CreateResourceConfigurationBody');
export type CreateResourceConfigurationBody = z.infer<typeof CreateResourceConfigurationBody>;

export const UpdateResourceConfigurationBody = withCommandMeta({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
  memberResourceIds: z.array(z.uuid()).min(1).max(100).optional(),
})
  // §4.9: a sensitive stale edit fails rather than overwrite newer work
  .extend({ expectedRevision: Revision })
  .openapi('UpdateResourceConfigurationBody');
export type UpdateResourceConfigurationBody = z.infer<typeof UpdateResourceConfigurationBody>;

export const ConflictUnitSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    name: z.string(),
    resourceIds: z.array(z.uuid()),
    createdAt: Instant,
  })
  .openapi('ConflictUnit');
export type ConflictUnit = z.infer<typeof ConflictUnitSchema>;

export const CreateConflictUnitBody = withCommandMeta({
  facilityId: z.uuid(),
  name: z.string().min(1).max(200),
}).openapi('CreateConflictUnitBody');
export type CreateConflictUnitBody = z.infer<typeof CreateConflictUnitBody>;

export const OperatingHoursSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    weekday: Weekday,
    opensAt: LocalTime,
    closesAt: LocalTime,
  })
  .openapi('OperatingHours');
export type OperatingHours = z.infer<typeof OperatingHoursSchema>;

export const CreateOperatingHoursBody = withCommandMeta({
  facilityId: z.uuid(),
  /** Omitted: the window applies to the whole facility (resources without their own hours inherit it). */
  resourceId: z.uuid().optional(),
  weekday: Weekday,
  opensAt: LocalTime,
  closesAt: LocalTime,
}).openapi('CreateOperatingHoursBody');
export type CreateOperatingHoursBody = z.infer<typeof CreateOperatingHoursBody>;

export const ListOperatingHoursQuery = z.object({
  facilityId: z.uuid(),
  resourceId: z.uuid().optional(),
});

// ---------------------------------------------------------------------------------------------
// Events, commitments, reservations (SPK-SCHED-003/004, §4.7 invariant 4)
// ---------------------------------------------------------------------------------------------

export const PartyCommitmentSchema = z
  .object({
    partyType: PartyType,
    partyId: z.uuid(),
    /** home_team, away_team, official, coach, participant, equipment … (free text, documented by the owning module) */
    role: z.string().min(1).max(50).default('participant'),
  })
  .openapi('PartyCommitment');
export type PartyCommitment = z.infer<typeof PartyCommitmentSchema>;

/** The practical details customers and staff see; carried old/new in schedule notices (SPK-COMMS-005). */
export const EventDetailsSchema = z
  .object({
    title: z.string(),
    kind: EventKind,
    scheduledStart: Instant,
    scheduledEnd: Instant,
    timezone: IanaTimezone,
    facilityId: z.uuid(),
    resources: z.array(z.object({ id: z.uuid(), name: z.string() })),
    status: EventStatus,
  })
  .openapi('EventDetails');
export type EventDetails = z.infer<typeof EventDetailsSchema>;

export const EventSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    kind: EventKind,
    title: z.string(),
    format: z.string().nullable(),
    seriesId: z.uuid().nullable(),
    occurrenceIndex: z.number().int().nullable(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    timezone: IanaTimezone,
    setupMinutes: z.number().int(),
    cleanupMinutes: z.number().int(),
    dstResolution: DstResolution,
    status: EventStatus,
    publishedRevision: z.number().int().nullable(),
    revision: Revision,
    sourceType: z.string().nullable(),
    sourceId: z.uuid().nullable(),
    resourceIds: z.array(z.uuid()),
    commitments: z.array(PartyCommitmentSchema),
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Event');
export type Event = z.infer<typeof EventSchema>;

export const ListEventsQuery = PageRequestSchema.extend({
  facilityId: z.uuid(),
  start: Instant,
  end: Instant,
  resourceId: z.uuid().optional(),
  status: EventStatus.optional(),
  sourceType: z.string().max(100).optional(),
  sourceId: z.uuid().optional(),
});
export type ListEventsQuery = z.infer<typeof ListEventsQuery>;

export const ReservationSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    resourceId: z.uuid(),
    occupied: IntervalSchema,
    status: z.enum(['active', 'released']),
  })
  .openapi('Reservation');
export type Reservation = z.infer<typeof ReservationSchema>;

export const ListReservationsQuery = z.object({
  facilityId: z.uuid().optional(),
  resourceId: z.uuid().optional(),
  start: Instant,
  end: Instant,
});

export const AvailabilityQuery = z.object({
  start: Instant,
  end: Instant,
  durationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  setupMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
  cleanupMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
  /** Candidate start times step (default 15). */
  stepMinutes: z.coerce.number().int().min(5).max(240).optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export const AvailabilityResponse = z
  .object({ resourceId: z.uuid(), slots: z.array(IntervalSchema) })
  .openapi('Availability');

/** A conflict detail names the colliding event ids (RESOURCE_CONFLICT details). */
export const ConflictDetailSchema = z
  .object({
    code: z.enum([
      'physical_overlap',
      'party_overlap',
      'insufficient_rest',
      'closure',
      'outside_operating_hours',
      'resource_unavailable',
      'incompatible_format',
      'configuration_not_permitted',
      'intra_draft_overlap',
    ]),
    message: z.string(),
    resourceId: z.uuid().optional(),
    conflictUnitId: z.uuid().optional(),
    conflictingEventIds: z.array(z.uuid()).default([]),
    closureId: z.uuid().optional(),
    party: PartyCommitmentSchema.pick({ partyType: true, partyId: true }).optional(),
    changeSequences: z.array(z.number().int()).optional(),
  })
  .openapi('ConflictDetail');
export type ConflictDetail = z.infer<typeof ConflictDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Series and recurrence (SPK-SCHED-007/008)
// ---------------------------------------------------------------------------------------------

export const RecurrenceRuleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(52).default(1),
    /** Weekly only: weekdays (0 = Sunday). Defaults to the start date's weekday. */
    byWeekday: z.array(Weekday).min(1).max(7).optional(),
    startDate: LocalDate,
    until: LocalDate.optional(),
    count: z.number().int().min(1).max(366).optional(),
  })
  .refine((r) => r.until !== undefined || r.count !== undefined, {
    message: 'a recurrence needs an until date or a count',
  })
  .openapi('RecurrenceRule');
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

export const EventSeriesSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    kind: EventKind,
    title: z.string(),
    timezone: IanaTimezone,
    recurrence: RecurrenceRuleSchema,
    localStartTime: LocalTime,
    durationMinutes: z.number().int(),
    setupMinutes: z.number().int(),
    cleanupMinutes: z.number().int(),
    nonexistentPolicy: NonexistentTimePolicy,
    ambiguousPolicy: AmbiguousTimePolicy,
    exceptions: z.array(LocalDate),
    resourceIds: z.array(z.uuid()),
    commitments: z.array(PartyCommitmentSchema),
    sourceType: z.string().nullable(),
    sourceId: z.uuid().nullable(),
    status: z.enum(['active', 'ended']),
    revision: Revision,
    eventIds: z.array(z.uuid()),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('EventSeries');
export type EventSeries = z.infer<typeof EventSeriesSchema>;

export const CreateEventSeriesBody = withCommandMeta({
  facilityId: z.uuid(),
  kind: EventKind,
  title: z.string().min(1).max(200),
  recurrence: RecurrenceRuleSchema,
  localStartTime: LocalTime,
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  setupMinutes: Minutes.optional(),
  cleanupMinutes: Minutes.optional(),
  nonexistentPolicy: NonexistentTimePolicy.optional(),
  ambiguousPolicy: AmbiguousTimePolicy.optional(),
  exceptions: z.array(LocalDate).max(366).optional(),
  resourceIds: z.array(z.uuid()).min(1).max(20),
  commitments: z.array(PartyCommitmentSchema).max(100).optional(),
  sourceType: z.string().min(1).max(100).optional(),
  sourceId: z.uuid().optional(),
}).openapi('CreateEventSeriesBody');
export type CreateEventSeriesBody = z.infer<typeof CreateEventSeriesBody>;

export const SeriesEditChanges = z
  .object({
    title: z.string().min(1).max(200).optional(),
    localStartTime: LocalTime.optional(),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .optional(),
    setupMinutes: Minutes.optional(),
    cleanupMinutes: Minutes.optional(),
    resourceIds: z.array(z.uuid()).min(1).max(20).optional(),
    /** Cancel the selected occurrences instead of changing them. */
    cancel: z.boolean().optional(),
  })
  .openapi('SeriesEditChanges');

export const EditEventSeriesBody = withCommandMeta({
  scope: SeriesEditScope,
  /** Required for scope 'one' and 'this_and_future'. */
  occurrenceIndex: z.number().int().min(0).optional(),
  /** When true, return exactly which events would change without committing anything. */
  preview: z.boolean().default(false),
  changes: SeriesEditChanges,
})
  // §4.9: a sensitive stale edit fails rather than overwrite newer work (previews too: the series
  // view returns its revision)
  .extend({ expectedRevision: Revision })
  .refine((b) => b.scope === 'entire_series' || b.occurrenceIndex !== undefined, {
    message: 'occurrenceIndex is required for this scope',
    path: ['occurrenceIndex'],
  })
  .openapi('EditEventSeriesBody');
export type EditEventSeriesBody = z.infer<typeof EditEventSeriesBody>;

export const SeriesEditPreviewSchema = z
  .object({
    seriesId: z.uuid(),
    scope: SeriesEditScope,
    committed: z.boolean(),
    /** Exactly which events change, with before/after practical details (after is null for a cancel). */
    affected: z.array(
      z.object({
        eventId: z.uuid(),
        occurrenceIndex: z.number().int(),
        before: EventDetailsSchema,
        after: EventDetailsSchema.nullable(),
        dstResolution: DstResolution,
      }),
    ),
    /** Events outside the scope (including past, played or attended occurrences) keep their identity and details. */
    unchangedEventIds: z.array(z.uuid()),
  })
  .openapi('SeriesEditPreview');
export type SeriesEditPreview = z.infer<typeof SeriesEditPreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Closures (SPK-SCHED-009)
// ---------------------------------------------------------------------------------------------

export const ClosureImpactSchema = z
  .object({
    interval: IntervalSchema,
    affectedEvents: z.array(
      z.object({
        eventId: z.uuid(),
        title: z.string(),
        kind: EventKind,
        status: EventStatus,
        scheduledStart: Instant,
        scheduledEnd: Instant,
        sourceType: z.string().nullable(),
        sourceId: z.uuid().nullable(),
        resourceIds: z.array(z.uuid()),
        reservationIds: z.array(z.uuid()),
        commitments: z.array(PartyCommitmentSchema),
      }),
    ),
    /** Owning records (fixtures, sessions, rentals …) whose events are affected, for downstream resolution. */
    sourceRecords: z.array(
      z.object({ sourceType: z.string(), sourceId: z.uuid(), eventIds: z.array(z.uuid()) }),
    ),
    summary: z.object({
      games: z.number().int(),
      programs: z.number().int(),
      rentals: z.number().int(),
      other: z.number().int(),
      teams: z.number().int(),
      people: z.number().int(),
      equipment: z.number().int(),
    }),
  })
  .openapi('ClosureImpact');
export type ClosureImpact = z.infer<typeof ClosureImpactSchema>;

export const ClosureSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    interval: IntervalSchema,
    reason: z.string(),
    source: ClosureSource,
    status: ClosureStatus,
    impact: ClosureImpactSchema.nullable(),
    resolution: z
      .object({
        mode: ClosureResolutionMode,
        canceledEventIds: z.array(z.uuid()),
        unresolvedEventIds: z.array(z.uuid()),
      })
      .nullable(),
    appliedAt: Instant.nullable(),
    liftedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Closure');
export type Closure = z.infer<typeof ClosureSchema>;

/** `reason` is the closure's own reason (required) and is reused as the command reason. */
export const CreateClosureBody = z
  .object({
    ...CommandMetaSchema.shape,
    facilityId: z.uuid(),
    resourceId: z.uuid().optional(),
    interval: IntervalSchema,
    reason: z.string().min(1).max(2000),
    source: ClosureSource.default('manual'),
  })
  .openapi('CreateClosureBody');
export type CreateClosureBody = z.infer<typeof CreateClosureBody>;

export const ApplyClosureBody = withCommandMeta({
  mode: ClosureResolutionMode,
}).openapi('ApplyClosureBody');
export type ApplyClosureBody = z.infer<typeof ApplyClosureBody>;

export const LiftClosureBody = withCommandMeta({}).openapi('LiftClosureBody');
export type LiftClosureBody = z.infer<typeof LiftClosureBody>;

export const ListClosuresQuery = z.object({
  facilityId: z.uuid(),
  status: ClosureStatus.optional(),
});

// ---------------------------------------------------------------------------------------------
// Drafts and publication (SPK-SCHED-005/006)
// ---------------------------------------------------------------------------------------------

export const ProposedEventFieldsSchema = z
  .object({
    kind: EventKind.optional(),
    title: z.string().min(1).max(200).optional(),
    format: z.string().min(1).max(50).nullable().optional(),
    scheduledStart: Instant.optional(),
    scheduledEnd: Instant.optional(),
    setupMinutes: Minutes.optional(),
    cleanupMinutes: Minutes.optional(),
    sourceType: z.string().min(1).max(100).optional(),
    sourceId: z.uuid().optional(),
    commitments: z.array(PartyCommitmentSchema).max(100).optional(),
    reason: z.string().max(2000).optional(),
  })
  .openapi('ProposedEventFields');
export type ProposedEventFields = z.infer<typeof ProposedEventFieldsSchema>;

export const DraftChangeInputSchema = z
  .object({
    kind: DraftChangeKind,
    /** Required for every kind except create; for create it may name an existing draft event to publish. */
    targetEventId: z.uuid().optional(),
    proposed: ProposedEventFieldsSchema.optional(),
    resourceIds: z.array(z.uuid()).max(20).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind !== 'create' && !c.targetEventId) {
      ctx.addIssue({ code: 'custom', path: ['targetEventId'], message: 'targetEventId required' });
    }
    const p = c.proposed ?? {};
    if (c.kind === 'create' && !c.targetEventId) {
      for (const key of ['kind', 'title', 'scheduledStart', 'scheduledEnd'] as const) {
        if (p[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: ['proposed', key], message: `${key} required` });
        }
      }
      if (!c.resourceIds?.length) {
        ctx.addIssue({ code: 'custom', path: ['resourceIds'], message: 'resourceIds required' });
      }
    }
    if (c.kind === 'move' && (!p.scheduledStart || !p.scheduledEnd)) {
      ctx.addIssue({ code: 'custom', path: ['proposed'], message: 'move needs start and end' });
    }
    if (c.kind === 'resize' && !p.scheduledEnd && !p.scheduledStart) {
      ctx.addIssue({ code: 'custom', path: ['proposed'], message: 'resize needs a new boundary' });
    }
    if (c.kind === 'resource_change' && !c.resourceIds?.length) {
      ctx.addIssue({ code: 'custom', path: ['resourceIds'], message: 'resourceIds required' });
    }
    if (p.scheduledStart && p.scheduledEnd && p.scheduledStart >= p.scheduledEnd) {
      ctx.addIssue({ code: 'custom', path: ['proposed'], message: 'start must be before end' });
    }
  })
  .openapi('DraftChangeInput');
export type DraftChangeInput = z.infer<typeof DraftChangeInputSchema>;

export const DraftChangeSchema = z
  .object({
    sequence: z.number().int(),
    kind: DraftChangeKind,
    targetEventId: z.uuid().nullable(),
    baseEventRevision: z.number().int().nullable(),
    proposed: ProposedEventFieldsSchema,
    resourceIds: z.array(z.uuid()),
  })
  .openapi('DraftChange');
export type DraftChange = z.infer<typeof DraftChangeSchema>;

export const ValidationIssueSchema = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z.string(),
    message: z.string(),
    changeSequence: z.number().int().optional(),
    eventId: z.uuid().optional(),
    detail: ConflictDetailSchema.optional(),
  })
  .openapi('ValidationIssue');
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationResultSchema = z
  .object({
    ok: z.boolean(),
    validatedAt: Instant,
    issues: z.array(ValidationIssueSchema),
  })
  .openapi('ValidationResult');
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ScheduleDraftSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    name: z.string(),
    status: ScheduleDraftStatus,
    author: z.object({
      kind: z.string(),
      accountId: z.uuid().nullable(),
      actorLabel: z.string(),
    }),
    baseRevision: z.object({
      capturedAt: Instant,
      eventRevisions: z.record(z.uuid(), z.number().int()),
    }),
    changes: z.array(DraftChangeSchema),
    validationResults: ValidationResultSchema.nullable(),
    lastSavedAt: Instant,
    validatedAt: Instant.nullable(),
    publishedAt: Instant.nullable(),
    publicationGroupId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ScheduleDraft');
export type ScheduleDraft = z.infer<typeof ScheduleDraftSchema>;

export const CreateScheduleDraftBody = withCommandMeta({
  facilityId: z.uuid(),
  name: z.string().min(1).max(200),
  changes: z.array(DraftChangeInputSchema).max(500).optional(),
}).openapi('CreateScheduleDraftBody');
export type CreateScheduleDraftBody = z.infer<typeof CreateScheduleDraftBody>;

/** Autosave replaces the whole change list; expectedRevision is required so concurrent editors never overwrite each other. */
export const AutosaveScheduleDraftBody = withCommandMeta({
  name: z.string().min(1).max(200).optional(),
  changes: z.array(DraftChangeInputSchema).max(500),
})
  // §4.9: a sensitive stale edit fails rather than overwrite newer work
  .extend({ expectedRevision: Revision })
  .openapi('AutosaveScheduleDraftBody');
export type AutosaveScheduleDraftBody = z.infer<typeof AutosaveScheduleDraftBody>;

export const ValidateScheduleDraftBody = withCommandMeta({}).openapi('ValidateScheduleDraftBody');
export const PublishScheduleDraftBody = withCommandMeta({}).openapi('PublishScheduleDraftBody');
export const DiscardScheduleDraftBody = withCommandMeta({}).openapi('DiscardScheduleDraftBody');

export const PublicationSchema = z
  .object({
    id: z.uuid(),
    draftId: z.uuid(),
    facilityId: z.uuid(),
    operationId: z.uuid().nullable(),
    committedAt: Instant,
    eventIds: z.array(z.uuid()),
    noticeEventIds: z.array(z.uuid()),
    summary: z.object({
      changes: z.array(
        z.object({
          sequence: z.number().int(),
          kind: DraftChangeKind,
          eventId: z.uuid(),
        }),
      ),
      remainingObligations: z.array(
        z.object({
          code: z.string(),
          message: z.string(),
          owner: z.string(),
          deadline: Instant.nullable(),
        }),
      ),
    }),
  })
  .openapi('Publication');
export type Publication = z.infer<typeof PublicationSchema>;

export const ListScheduleDraftsQuery = z.object({
  facilityId: z.uuid(),
  status: ScheduleDraftStatus.optional(),
});

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const IdParams = z.object({ id: z.uuid() });
const TAG = 'Scheduling';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({
  'Idempotency-Key': z.string().min(8).max(128),
});

function command(
  method: 'post' | 'patch' | 'delete',
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
      403: err('Access denied'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
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
  '/resources',
  'Create a resource (SPK-SCHED-001)',
  CreateResourceBody,
  ResourceSchema,
);
query('/resources', 'List facility resources', ListResourcesQuery, z.array(ResourceSchema));
query('/resources/{id}', 'Read a resource', null, ResourceSchema);
command('patch', '/resources/{id}', 'Update a resource', UpdateResourceBody, ResourceSchema, 200);
query(
  '/resources/{id}/availability',
  'Find available slots for a resource (SPK-SCHED-003)',
  AvailabilityQuery,
  AvailabilityResponse,
);
command(
  'post',
  '/resource-configurations',
  'Create a physical arrangement (SPK-SCHED-002)',
  CreateResourceConfigurationBody,
  ResourceConfigurationSchema,
);
query(
  '/resource-configurations',
  'List facility configurations',
  ListResourcesQuery,
  z.array(ResourceConfigurationSchema),
);
command(
  'patch',
  '/resource-configurations/{id}',
  'Update a configuration',
  UpdateResourceConfigurationBody,
  ResourceConfigurationSchema,
  200,
);
command(
  'post',
  '/conflict-units',
  'Create a conflict unit (SPK-SCHED-002)',
  CreateConflictUnitBody,
  ConflictUnitSchema,
);
query(
  '/conflict-units',
  'List facility conflict units',
  ListResourcesQuery,
  z.array(ConflictUnitSchema),
);
command(
  'post',
  '/operating-hours',
  'Add an operating window (SPK-SCHED-001)',
  CreateOperatingHoursBody,
  OperatingHoursSchema,
);
query(
  '/operating-hours',
  'List operating windows',
  ListOperatingHoursQuery,
  z.array(OperatingHoursSchema),
);
command(
  'delete',
  '/operating-hours/{id}',
  'Remove an operating window',
  null,
  z.object({ id: z.uuid() }),
  200,
);

command(
  'post',
  '/closures',
  'Create a closure with its impact preview (SPK-SCHED-009)',
  CreateClosureBody,
  ClosureSchema,
);
query('/closures', 'List closures', ListClosuresQuery, z.array(ClosureSchema));
query('/closures/{id}', 'Read a closure and its impact', null, ClosureSchema);
command(
  'post',
  '/closures/{id}/apply',
  'Apply a closure (SPK-SCHED-009, SPK-FAC-003)',
  ApplyClosureBody,
  ClosureSchema,
  200,
);
command(
  'post',
  '/closures/{id}/lift',
  'Lift a closure: authorized return to service (SPK-FAC-004)',
  LiftClosureBody,
  ClosureSchema,
  200,
);

query('/events', 'List events in a facility window', ListEventsQuery, pageSchema(EventSchema));
query('/events/{id}', 'Read an event', null, EventSchema);
query(
  '/reservations',
  'List reservations by resource or facility and interval',
  ListReservationsQuery,
  z.array(ReservationSchema),
);

command(
  'post',
  '/event-series',
  'Create a recurring series and materialize its occurrences (SPK-SCHED-007/008)',
  CreateEventSeriesBody,
  EventSeriesSchema,
);
query('/event-series/{id}', 'Read a series', null, EventSeriesSchema);
command(
  'post',
  '/event-series/{id}/edits',
  'Edit one occurrence, this and future, or the entire series (SPK-SCHED-007)',
  EditEventSeriesBody,
  SeriesEditPreviewSchema,
  200,
);

command(
  'post',
  '/schedule-drafts',
  'Open a schedule draft (SPK-SCHED-005)',
  CreateScheduleDraftBody,
  ScheduleDraftSchema,
);
query('/schedule-drafts', 'List drafts', ListScheduleDraftsQuery, z.array(ScheduleDraftSchema));
query('/schedule-drafts/{id}', 'Read a draft', null, ScheduleDraftSchema);
command(
  'patch',
  '/schedule-drafts/{id}',
  'Autosave draft changes',
  AutosaveScheduleDraftBody,
  ScheduleDraftSchema,
  200,
);
command(
  'post',
  '/schedule-drafts/{id}/validate',
  'Validate a draft against current records (SPK-SCHED-004)',
  ValidateScheduleDraftBody,
  ScheduleDraftSchema,
  200,
);
command(
  'post',
  '/schedule-drafts/{id}/publish',
  'Validate and commit a schedule revision (SPK-SCHED-006)',
  PublishScheduleDraftBody,
  PublicationSchema,
  200,
);
command(
  'post',
  '/schedule-drafts/{id}/discard',
  'Discard a draft',
  DiscardScheduleDraftBody,
  ScheduleDraftSchema,
  200,
);
