import { z } from '../zod';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema } from '../pagination';
import { Instant } from '../time';
import { CapacityUnitKindSchema, OfferingKindSchema, PublicOfferingSchema } from './catalog';
import {
  EnrollmentSchema,
  WaitlistEntrySchema,
  WaitlistEntryStatusSchema,
  WaitlistOfferStatusSchema,
} from './enrollment';
import { ObservedStateSchema } from './entry';

/**
 * Enrollment overview reads for the park UI (docs/design/park-ui-redesign.md "Grow" and
 * "Customer app"): aggregate counts for the programs overview and camp readiness rail, the
 * organization-wide waitlist for the registrations home, a person's activities with recent
 * attendance, and the customer app's age-based suggestions and live availability. Every read is
 * read-only (no hold, basket or other write). Aggregates carry counts only, never a date of birth
 * or a participant name (§4.14 child data minimized).
 */

const TAG = 'Enrollment';
const MAX_SUMMARY_OFFERINGS = 100;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A comma-separated list of 1..max uuids, as distinct lower-case ids. */
function uuidList(max: number) {
  return z
    .string()
    .regex(
      new RegExp(`^${UUID}(,${UUID}){0,${max - 1}}$`, 'i'),
      `a comma-separated list of at most ${max} ids`,
    )
    .transform((v) => [...new Set(v.toLowerCase().split(','))]);
}

// ---------------------------------------------------------------------------------------------
// Offering enrollment summaries (programs overview, camp readiness rail)
// ---------------------------------------------------------------------------------------------

export const OfferingEnrollmentSummariesQuery = z.object({
  /** Comma-separated offering ids (at most 100). */
  offeringIds: uuidList(MAX_SUMMARY_OFFERINGS),
});
export type OfferingEnrollmentSummariesQuery = z.infer<typeof OfferingEnrollmentSummariesQuery>;

/**
 * Participants of one age (whole years on the offering's eligibility reference date, SPK-REG-002).
 * `ageYears` null counts participants whose date of birth is not recorded. Ages, not bands: the
 * approved youth age bands are pending DEC-003, so no band is invented here.
 */
export const EnrollmentAgeGroupSchema = z
  .object({
    ageYears: z.number().int().nullable(),
    confirmed: z.number().int(),
    pending: z.number().int(),
  })
  .openapi('EnrollmentAgeGroup');

export const OfferingEnrollmentSummarySchema = z
  .object({
    offeringId: z.uuid(),
    /** The date ages are counted on (the offering's configured eligibility reference date). */
    referenceDate: z.iso.date(),
    enrolled: z.object({ confirmed: z.number().int(), pending: z.number().int() }),
    byAge: z.array(EnrollmentAgeGroupSchema),
    /**
     * Required forms of the offering acknowledged by the participants of its confirmed and pending
     * enrollments (SPK-CAT-001 required forms, SPK-REG-009). `percentComplete` is acknowledged
     * forms over required forms × participants, rounded down; null when nothing is required or
     * nobody is enrolled.
     */
    forms: z.object({
      requiredFormCount: z.number().int(),
      participantCount: z.number().int(),
      participantsComplete: z.number().int(),
      percentComplete: z.number().int().min(0).max(100).nullable(),
    }),
    /** SPK-REG-008: entries waiting and entries holding an open offer. */
    waitlist: z.object({ waiting: z.number().int(), offered: z.number().int() }),
  })
  .openapi('OfferingEnrollmentSummary');
export type OfferingEnrollmentSummary = z.infer<typeof OfferingEnrollmentSummarySchema>;

export const OfferingEnrollmentSummariesSchema = z
  .object({
    items: z.array(OfferingEnrollmentSummarySchema),
    /**
     * Requested ids not summarized: unknown, in another organization, or at a facility the
     * caller's reading role does not cover (indistinguishable, §4.10).
     */
    unavailableOfferingIds: z.array(z.uuid()),
  })
  .openapi('OfferingEnrollmentSummaries');
export type OfferingEnrollmentSummaries = z.infer<typeof OfferingEnrollmentSummariesSchema>;

// ---------------------------------------------------------------------------------------------
// Organization-wide waitlist (registrations home)
// ---------------------------------------------------------------------------------------------

export const ListWaitlistQueueQuery = PageRequestSchema.extend({
  /** Default: the live queue (waiting and offered). */
  status: WaitlistEntryStatusSchema.optional(),
  offeringId: z.uuid().optional(),
  facilityId: z.uuid().optional(),
  participantPersonId: z.uuid().optional(),
});
export type ListWaitlistQueueQuery = z.infer<typeof ListWaitlistQueueQuery>;

export const WaitlistQueueItemSchema = WaitlistEntrySchema.extend({
  /** The offering (also closed or archived); null when the catalog no longer resolves it. */
  offering: z
    .object({
      id: z.uuid(),
      name: z.string(),
      kind: OfferingKindSchema,
      facilityId: z.uuid(),
      startsOn: z.iso.date(),
    })
    .nullable(),
  openOffer: z
    .object({ id: z.uuid(), status: WaitlistOfferStatusSchema, expiresAt: Instant })
    .nullable(),
}).openapi('WaitlistQueueItem');
export type WaitlistQueueItem = z.infer<typeof WaitlistQueueItemSchema>;

export const WaitlistQueuePageSchema = z
  .object({
    items: z.array(WaitlistQueueItemSchema),
    nextCursor: z.string().nullable(),
    /** Over every page of the same filter (live statuses only). */
    counts: z.object({ waiting: z.number().int(), offered: z.number().int() }),
  })
  .openapi('WaitlistQueuePage');
export type WaitlistQueuePage = z.infer<typeof WaitlistQueuePageSchema>;

// ---------------------------------------------------------------------------------------------
// Person activities with recent attendance (person record)
// ---------------------------------------------------------------------------------------------

export const PARTICIPANT_RECENT_SESSIONS = 8;

/** Up to 20 enrollments a page (each reads the attendance of its last 8 sessions). */
export const ParticipantActivitiesQuery = PageRequestSchema.extend({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type ParticipantActivitiesQuery = z.infer<typeof ParticipantActivitiesQuery>;

export const RecentSessionAttendanceSchema = z
  .object({
    sessionId: z.uuid(),
    sequence: z.number().int(),
    title: z.string().nullable(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    sessionStatus: z.enum(['scheduled', 'canceled', 'completed']),
    /** The effective observed state (SPK-ENTRY-005); null when nothing is recorded or under review. */
    attendance: ObservedStateSchema.nullable(),
    /** The current observations contradict each other (pending review). */
    conflict: z.boolean(),
  })
  .openapi('RecentSessionAttendance');
export type RecentSessionAttendance = z.infer<typeof RecentSessionAttendanceSchema>;

export const ParticipantActivitySchema = z
  .object({
    enrollment: EnrollmentSchema,
    /** The offering's last sessions that have started (at most 8), most recent first. */
    recentSessions: z.array(RecentSessionAttendanceSchema),
    /**
     * Counts over `recentSessions` that were held (not canceled): present or late, and with any
     * observation. `null` when the attendance reader is not part of the application.
     */
    attendance: z
      .object({ held: z.number().int(), attended: z.number().int(), recorded: z.number().int() })
      .nullable(),
  })
  .openapi('ParticipantActivity');
export type ParticipantActivity = z.infer<typeof ParticipantActivitySchema>;

export const ParticipantActivitiesSchema = z
  .object({
    personId: z.uuid(),
    items: z.array(ParticipantActivitySchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('ParticipantActivities');
export type ParticipantActivities = z.infer<typeof ParticipantActivitiesSchema>;

// ---------------------------------------------------------------------------------------------
// Customer app: "picked for <child>" and live availability
// ---------------------------------------------------------------------------------------------

export const OfferingSuggestionsQuery = z.object({
  participantPersonId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});
export type OfferingSuggestionsQuery = z.infer<typeof OfferingSuggestionsQuery>;

export const OfferingSuggestionSchema = z
  .object({
    offering: PublicOfferingSchema,
    /** Why it is suggested: the participant's age on the offering's reference date is in its band. */
    reason: z.object({
      kind: z.literal('age_band'),
      ageYears: z.number().int(),
      referenceDate: z.iso.date(),
    }),
  })
  .openapi('OfferingSuggestion');
export type OfferingSuggestion = z.infer<typeof OfferingSuggestionSchema>;

export const OfferingSuggestionsSchema = z
  .object({
    participantPersonId: z.uuid(),
    /**
     * `date_of_birth_unknown`: nothing can be suggested by age (the household can add it); `ok`
     * otherwise. A suggestion is not an eligibility decision: registration options evaluate that.
     */
    basis: z.enum(['ok', 'date_of_birth_unknown']),
    items: z.array(OfferingSuggestionSchema),
  })
  .openapi('OfferingSuggestions');
export type OfferingSuggestions = z.infer<typeof OfferingSuggestionsSchema>;

export const MAX_AVAILABILITY_OFFERINGS = 20;

export const OfferingAvailabilityQuery = z.object({
  /** Comma-separated offering ids (at most 20), for example the weeks of a camp. */
  offeringIds: uuidList(MAX_AVAILABILITY_OFFERINGS),
});
export type OfferingAvailabilityQuery = z.infer<typeof OfferingAvailabilityQuery>;

/**
 * Live places left of an offering (SPK-REG-005: capacity counts active holds and commitments): the
 * tightest of its active offering-level pools. `not_configured` when it has none. Child-safe: no
 * staffing, holds or participants.
 */
export const OfferingAvailabilitySchema = z
  .object({
    offeringId: z.uuid(),
    status: z.enum(['available', 'full', 'not_configured']),
    unit: CapacityUnitKindSchema.nullable(),
    capacity: z.number().int().nullable(),
    remaining: z.number().int().nullable(),
  })
  .openapi('OfferingAvailability');
export type OfferingAvailability = z.infer<typeof OfferingAvailabilitySchema>;

export const OfferingAvailabilityListSchema = z
  .object({
    items: z.array(OfferingAvailabilitySchema),
    /** Unknown, unpublished (for a reader who is not staff there) or other-organization ids. */
    unavailableOfferingIds: z.array(z.uuid()),
  })
  .openapi('OfferingAvailabilityList');
export type OfferingAvailabilityList = z.infer<typeof OfferingAvailabilityListSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape>,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{personId}') ? z.object({ personId: z.uuid() }) : undefined,
      query: request,
    },
    responses: {
      200: ok('Result', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible (protected records never reveal existence)'),
    },
  });
}

query(
  '/offering-enrollment-summaries',
  'Enrollment by age, required-form completion and waitlist counts of several offerings (staff, facility-scoped; counts only)',
  OfferingEnrollmentSummariesQuery,
  OfferingEnrollmentSummariesSchema,
);
query(
  '/waitlist-queue',
  'Waitlist entries across offerings, filterable, newest first (staff, facility-scoped; SPK-REG-008)',
  ListWaitlistQueueQuery,
  WaitlistQueuePageSchema,
);
query(
  '/participants/{personId}/activities',
  "A participant's enrollments with the attendance of the last 8 sessions of each (staff or a holder of view)",
  ParticipantActivitiesQuery,
  ParticipantActivitiesSchema,
);
query(
  '/me/offering-suggestions',
  'Published offerings whose age band fits a participant the caller may register (read-only; age only, no other profiling)',
  OfferingSuggestionsQuery,
  OfferingSuggestionsSchema,
);
query(
  '/offering-availability',
  'Places left of several offerings, for example the weeks of a camp (published offerings; child-safe)',
  OfferingAvailabilityQuery,
  OfferingAvailabilityListSchema,
);
