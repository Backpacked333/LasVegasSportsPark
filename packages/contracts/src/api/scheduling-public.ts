import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { DateOnly } from './identity';

/**
 * Public and lobby schedule views (SPK-SCHED-010, proposed amendment PA-06; capability
 * `public_schedule`, pending DEC-100). The public shapes are written for this surface only: they
 * have no field for a person, a booker, a contact or an internal id, so nothing private can reach
 * a public answer by a field being added to a staff schema later (ADR-005). A view is addressed by
 * the organization's slug and a random public code.
 */

/** A random public code: the only identifier a public view is reached through. */
export const PublicCode = z
  .string()
  .regex(/^[a-z0-9]{16,40}$/)
  .openapi('PublicCode');
/** An organization's public slug. */
export const PublicOrganizationSlug = z.string().trim().min(1).max(100);

/**
 * What occupies the time, in words a visitor reads. `reserved` is a private booking (a rental or
 * a party): occupied time with no name. `unavailable` is time the operator blocked.
 */
export const PublicScheduleKindSchema = z
  .enum(['game', 'practice', 'class', 'pickup', 'reserved', 'unavailable'])
  .openapi('PublicScheduleKind');
export type PublicScheduleKind = z.infer<typeof PublicScheduleKindSchema>;

export const PublicScoreSchema = z
  .object({ home: z.number().int(), away: z.number().int() })
  .openapi('PublicScore');
export type PublicScore = z.infer<typeof PublicScoreSchema>;

export const PublicScheduleEntrySchema = z
  .object({
    startsAt: Instant,
    endsAt: Instant,
    /** Names of the fields or rooms the entry occupies (as listed in `fields`). */
    fields: z.array(z.string()),
    kind: PublicScheduleKindSchema,
    /**
     * A title the system generated (team names of a public competition, an offering name) or the
     * kind in words. Never a title a person typed, never a renter's name: a private booking reads
     * "Reserved", a game of a competition that is not public reads "League game".
     */
    title: z.string(),
    /** The official score of a game of a public competition; null otherwise. */
    score: PublicScoreSchema.nullable(),
  })
  .openapi('PublicScheduleEntry');
export type PublicScheduleEntry = z.infer<typeof PublicScheduleEntrySchema>;

export const PublicDayScheduleSchema = z
  .object({
    organizationName: z.string(),
    facilityName: z.string(),
    /** IANA zone of the facility; `date` and every time are read in it (SPK-SCHED-008). */
    timezone: z.string(),
    date: DateOnly,
    /** The fields and rooms of the facility, in display order. */
    fields: z.array(z.string()),
    entries: z.array(PublicScheduleEntrySchema),
    /** When this answer was computed; a display shows it as "last updated". */
    computedAt: Instant,
    /** Seconds a shared cache may keep the answer (also sent as `Cache-Control`). */
    cacheSeconds: z.number().int(),
  })
  .openapi('PublicDaySchedule');
export type PublicDaySchedule = z.infer<typeof PublicDayScheduleSchema>;

export const PublicDayScheduleQuery = z.object({
  /** The facility-local day; today in the facility's zone when omitted. */
  date: DateOnly.optional(),
});
export type PublicDayScheduleQuery = z.infer<typeof PublicDayScheduleQuery>;

// ---------------------------------------------------------------------------------------------
// Staff: enabling a facility's public schedule and showing its link
// ---------------------------------------------------------------------------------------------
export const FacilityPublicViewSchema = z
  .object({
    facilityId: z.uuid(),
    enabled: z.boolean(),
    /** The slug and code a public link is built from; the code is null until first enabled. */
    organizationSlug: z.string(),
    publicCode: PublicCode.nullable(),
    enabledAt: Instant.nullable(),
    disabledAt: Instant.nullable(),
    /** 0 until the view has been enabled once. */
    revision: z.number().int(),
  })
  .openapi('FacilityPublicView');
export type FacilityPublicView = z.infer<typeof FacilityPublicViewSchema>;

export const EnableFacilityPublicViewBody = withCommandMeta({
  /** Issue a new code, so links shared before stop working. */
  newCode: z.boolean().optional(),
})
  .extend({ expectedRevision: Revision.optional() })
  .openapi('EnableFacilityPublicViewRequest');
export type EnableFacilityPublicViewInput = z.infer<typeof EnableFacilityPublicViewBody>;

export const DisableFacilityPublicViewBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('DisableFacilityPublicViewRequest');
export type DisableFacilityPublicViewInput = z.infer<typeof DisableFacilityPublicViewBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const TAG = 'Public views';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const IdParams = z.object({ id: z.uuid() });

/** The one answer of every public route that has nothing to show (ADR-005 "fail closed"). */
export const PUBLIC_NOT_AVAILABLE =
  'Not available: an unknown organization or code, a view that is not public, or public views turned off all answer the same';

openApiRegistry.registerPath({
  method: 'get',
  path: '/public/{organization}/schedule/{code}',
  summary:
    "A facility's schedule for a day by field and time, without sign-in (SPK-SCHED-010, Proposed)",
  tags: [TAG],
  security: [],
  request: {
    params: z.object({ organization: PublicOrganizationSlug, code: PublicCode }),
    query: PublicDayScheduleQuery,
  },
  responses: {
    200: ok('The day schedule (cacheable for a short time)', PublicDayScheduleSchema),
    400: err('Validation failed'),
    404: err(PUBLIC_NOT_AVAILABLE),
    429: err('Too many public reads from this address (rate limit `public_views`)'),
  },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/facilities/{id}/public-schedule-view',
  summary:
    "Whether a facility's public schedule is enabled, and its link (SPK-SCHED-010, Proposed)",
  tags: ['Scheduling'],
  request: { params: IdParams },
  responses: {
    200: ok('Result', FacilityPublicViewSchema),
    403: err('Access denied'),
    404: err('Not found or not visible'),
  },
});
for (const [action, body, summary] of [
  [
    'enable',
    EnableFacilityPublicViewBody,
    "Enable a facility's public schedule and issue its code (SPK-SCHED-010, Proposed)",
  ],
  [
    'disable',
    DisableFacilityPublicViewBody,
    "Disable a facility's public schedule (SPK-SCHED-010, Proposed)",
  ],
] as const) {
  openApiRegistry.registerPath({
    method: 'post',
    path: `/facilities/{id}/public-schedule-view/${action}`,
    summary,
    tags: ['Scheduling'],
    request: {
      params: IdParams,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      200: ok('Command outcome', FacilityPublicViewSchema),
      400: err('Validation failed'),
      403: err('Access denied, or public views are not enabled (CAPABILITY_DISABLED)'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, IDEMPOTENCY_*)'),
    },
  });
}
