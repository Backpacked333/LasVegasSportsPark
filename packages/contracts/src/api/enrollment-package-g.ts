import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { AcceptedConsequenceSchema, BasketSchema, EnrollmentStatusSchema } from './enrollment';

/**
 * Enrollment Package G API contract (§3.16, §6.5 Package G; SPK-COND-001 to SPK-COND-003,
 * SPK-YOUTH-005, SPK-YOUTH-006). Each capability is behind its organization switch (DEC-016 and
 * the capability's decision); a disabled capability refuses new commitments with ACCESS_DENIED
 * (details.code CAPABILITY_DISABLED) while reads, cancellations, reversals and expiry keep working.
 */

const Reason = z.string().trim().min(1).max(2000);
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Enrollment';

// ---------------------------------------------------------------------------------------------
// Session packages (ENR-11; capability session_packages, DEC-074)
// ---------------------------------------------------------------------------------------------

export const PackageEntitlementStatusSchema = z
  .enum(['active', 'exhausted', 'expired', 'revoked'])
  .openapi('PackageEntitlementStatus');
export type PackageEntitlementStatus = z.infer<typeof PackageEntitlementStatusSchema>;

export const PackageRedemptionSchema = z
  .object({
    id: z.uuid(),
    sessionBookingId: z.uuid(),
    kind: z.enum(['redeem', 'reversal']),
    reversesRedemptionId: z.uuid().nullable(),
    reason: z.string().nullable(),
    redeemedAt: Instant,
  })
  .openapi('PackageRedemption');
export type PackageRedemption = z.infer<typeof PackageRedemptionSchema>;

export const PackageEntitlementSchema = z
  .object({
    id: z.uuid(),
    participantPersonId: z.uuid(),
    /** The confirmed package purchase that issued the credits. */
    enrollmentId: z.uuid(),
    offeringId: z.uuid(),
    offeringName: z.string().nullable(),
    entitlementDefinitionId: z.uuid(),
    appliesTo: z.object({ offeringIds: z.array(z.uuid()), programIds: z.array(z.uuid()) }),
    credits: z.number().int(),
    redeemedCount: z.number().int(),
    remainingCredits: z.number().int(),
    status: PackageEntitlementStatusSchema,
    /** Null when the package definition chose no expiry (POL-039). */
    expiresAt: Instant.nullable(),
    issuedAt: Instant,
    expiredAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
    revokedReason: z.string().nullable(),
    redemptions: z.array(PackageRedemptionSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PackageEntitlement');
export type PackageEntitlement = z.infer<typeof PackageEntitlementSchema>;

export const ListMyPackageEntitlementsQuery = PageRequestSchema.extend({
  status: PackageEntitlementStatusSchema.optional(),
});
export type ListMyPackageEntitlementsQuery = z.infer<typeof ListMyPackageEntitlementsQuery>;

export const ListPackageEntitlementsQuery = PageRequestSchema.extend({
  participantPersonId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  status: PackageEntitlementStatusSchema.optional(),
});
export type ListPackageEntitlementsQuery = z.infer<typeof ListPackageEntitlementsQuery>;

export const ReversePackageRedemptionBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('ReversePackageRedemptionRequest');
export type ReversePackageRedemptionInput = z.infer<typeof ReversePackageRedemptionBody>;

// ---------------------------------------------------------------------------------------------
// Memberships (ENR-12; capability memberships, DEC-072)
// ---------------------------------------------------------------------------------------------

export const MembershipSuspensionSchema = z
  .object({
    id: z.uuid(),
    enrollmentId: z.uuid(),
    participantPersonId: z.uuid(),
    from: Instant,
    /** Null: suspended until ended. */
    until: Instant.nullable(),
    reason: z.string(),
    status: z.enum(['active', 'ended']),
    endedAt: Instant.nullable(),
    endedReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('MembershipSuspension');
export type MembershipSuspension = z.infer<typeof MembershipSuspensionSchema>;

/** SPK-COND-001: what attendance the membership includes, exactly as its definition states. */
export const MembershipAttendanceSummarySchema = z
  .object({
    mode: z.enum(['none', 'included_sessions', 'unlimited']),
    limit: z
      .object({
        count: z.number().int(),
        period: z.enum(['week', 'month', 'membership_term']),
        weekStartsOn: z.number().int().nullable(),
      })
      .nullable(),
    appliesTo: z
      .object({ offeringIds: z.array(z.uuid()), programIds: z.array(z.uuid()) })
      .nullable(),
  })
  .openapi('MembershipAttendanceSummary');

export const MembershipUsageSchema = z
  .object({
    periodKey: z.string(),
    usedCount: z.number().int(),
    limitCount: z.number().int(),
  })
  .openapi('MembershipUsage');

export const MembershipSchema = z
  .object({
    enrollmentId: z.uuid(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    offeringName: z.string().nullable(),
    status: EnrollmentStatusSchema,
    /** Set when the membership is confirmed (null until then, or when its term is unknown). */
    termStartsAt: Instant.nullable(),
    termEndsAt: Instant.nullable(),
    /** Null when the offering's definition cannot be read (nothing is assumed). */
    attendance: MembershipAttendanceSummarySchema.nullable(),
    renewedFromEnrollmentId: z.uuid().nullable(),
    suspensions: z.array(MembershipSuspensionSchema),
    usage: z.array(MembershipUsageSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Membership');
export type Membership = z.infer<typeof MembershipSchema>;

export const ListMyMembershipsQuery = PageRequestSchema.extend({
  status: EnrollmentStatusSchema.optional(),
});
export type ListMyMembershipsQuery = z.infer<typeof ListMyMembershipsQuery>;

export const CreateMembershipSuspensionBody = withCommandMeta({
  from: Instant,
  until: Instant.optional(),
})
  .extend({ reason: Reason })
  .openapi('CreateMembershipSuspensionRequest');
export type CreateMembershipSuspensionInput = z.infer<typeof CreateMembershipSuspensionBody>;

export const EndMembershipSuspensionBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('EndMembershipSuspensionRequest');
export type EndMembershipSuspensionInput = z.infer<typeof EndMembershipSuspensionBody>;

export const RenewMembershipBody = withCommandMeta({
  /** The membership offering the renewal buys (often the next term's). */
  targetOfferingId: z.uuid(),
  /** An open basket of the caller's household to add the line to; a new one is opened otherwise. */
  basketId: z.uuid().optional(),
}).openapi('RenewMembershipRequest');
export type RenewMembershipInput = z.infer<typeof RenewMembershipBody>;

// ---------------------------------------------------------------------------------------------
// Rentals and parties (ENR-13; capabilities rentals and parties, DEC-076, DEC-077)
// ---------------------------------------------------------------------------------------------

export const BookingKindValueSchema = z.enum(['rental', 'party']).openapi('BookingKind');
export const BookingStatusValueSchema = z
  .enum([
    'requested',
    'held',
    'awaiting_staff',
    'confirmed',
    'declined',
    'expired',
    'canceled',
    'completed',
  ])
  .openapi('BookingStatus');
export const BookingOutstandingValueSchema = z
  .enum(['approval', 'payment', 'staffing'])
  .openapi('BookingOutstanding');

export const BookingOccurrenceSchema = z
  .object({
    start: Instant,
    end: Instant,
    /** The scheduling event reserving it; null while a request reserves nothing. */
    eventId: z.uuid().nullable(),
    resources: z.array(z.object({ id: z.uuid(), name: z.string().nullable() })),
  })
  .openapi('BookingOccurrence');

export const BookingSchema = z
  .object({
    id: z.uuid(),
    kind: BookingKindValueSchema,
    offeringId: z.uuid(),
    offeringName: z.string().nullable(),
    facilityId: z.uuid(),
    /** IANA zone the occurrences are shown in (SPK-SCHED-008). */
    timezone: z.string().nullable(),
    bookerPersonId: z.uuid(),
    status: BookingStatusValueSchema,
    /** What still stands between the booking and confirmed. */
    outstanding: z.array(BookingOutstandingValueSchema),
    firstStart: Instant,
    lastEnd: Instant,
    occurrences: z.array(BookingOccurrenceSchema),
    guestCount: z.number().int().nullable(),
    equipmentAssetIds: z.array(z.uuid()),
    terms: z.object({
      policyVersionId: z.uuid(),
      confirmationMode: z.enum(['instant', 'request']),
      accessConditions: z.string().nullable(),
      hostResponsibilities: z.string().nullable(),
    }),
    basketId: z.uuid().nullable(),
    enrollmentId: z.uuid().nullable(),
    decisionReason: z.string().nullable(),
    endReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Booking');
export type Booking = z.infer<typeof BookingSchema>;

/** A rental repeats weekly (at most 52 occurrences); a party is one occurrence. */
export const BookingRecurrenceSchema = z
  .object({
    interval: z.number().int().min(1).max(4).default(1),
    /** Weekdays in the facility zone (0 = Sunday). Defaults to the start's weekday. */
    byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    count: z.number().int().min(1).max(52),
  })
  .openapi('BookingRecurrence');

export const CreateBookingBody = withCommandMeta({
  offeringId: z.uuid(),
  /** Booker; defaults to the caller (staff booking for a customer name them). */
  bookerPersonId: z.uuid().optional(),
  start: Instant,
  /** Required for a rental; a party lasts its package duration (an end, if given, must match). */
  end: Instant.optional(),
  recurrence: BookingRecurrenceSchema.optional(),
  resourceIds: z.array(z.uuid()).min(1).max(50),
  guestCount: z.number().int().min(1).max(10_000).optional(),
  /** An open, empty basket of the booker to use instead of a new one. */
  basketId: z.uuid().optional(),
}).openapi('CreateBookingRequest');
export type CreateBookingInput = z.infer<typeof CreateBookingBody>;

export const ApproveBookingBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ApproveBookingRequest');
export type ApproveBookingInput = z.infer<typeof ApproveBookingBody>;

export const DeclineBookingBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('DeclineBookingRequest');
export type DeclineBookingInput = z.infer<typeof DeclineBookingBody>;

export const CancelBookingBody = withCommandMeta({
  /** Required once the booking is paid: the consequence previewed by GET /enrollments/{id}/cancellation-preview. */
  acceptedConsequence: AcceptedConsequenceSchema.optional(),
})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('CancelBookingRequest');
export type CancelBookingInput = z.infer<typeof CancelBookingBody>;

export const ListBookingsQuery = PageRequestSchema.extend({
  facilityId: z.uuid().optional(),
  status: BookingStatusValueSchema.optional(),
  from: Instant.optional(),
  to: Instant.optional(),
});
export type ListBookingsQuery = z.infer<typeof ListBookingsQuery>;

export const ListMyBookingsQuery = PageRequestSchema.extend({
  status: BookingStatusValueSchema.optional(),
});
export type ListMyBookingsQuery = z.infer<typeof ListMyBookingsQuery>;

export const BookingAvailabilityQuery = z
  .object({
    from: Instant,
    to: Instant,
    durationMinutes: z.coerce.number().int().min(15).max(1440).optional(),
  })
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: 'from must be before to' })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 31 * 86_400_000, {
    message: 'the window is at most 31 days',
  });
export type BookingAvailabilityQuery = z.infer<typeof BookingAvailabilityQuery>;

export const BookingAvailabilitySchema = z
  .object({
    offeringId: z.uuid(),
    timezone: z.string(),
    durationMinutes: z.number().int(),
    /** How many of the listed resources one booking reserves. */
    resourceCount: z.number().int(),
    resources: z.array(
      z.object({
        resourceId: z.uuid(),
        name: z.string().nullable(),
        freeIntervals: z.array(z.object({ start: Instant, end: Instant })),
      }),
    ),
  })
  .openapi('BookingAvailability');
export type BookingAvailability = z.infer<typeof BookingAvailabilitySchema>;

// ---------------------------------------------------------------------------------------------
// Youth progression (ENR-14; capability youth_progression, DEC-016; DEC-003, DEC-054, DEC-055)
// ---------------------------------------------------------------------------------------------

const SkillKey = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'must be a lower-case key');

export const AssessmentTemplateSchema = z
  .object({
    id: z.uuid(),
    programId: z.uuid(),
    name: z.string(),
    version: z.number().int(),
    skillAreas: z.array(z.object({ key: z.string(), label: z.string() })),
    scale: z.object({ kind: z.literal('ordinal'), levels: z.array(z.string()) }),
    status: z.enum(['draft', 'approved', 'retired']),
    approvedAt: Instant.nullable(),
    retiredAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('AssessmentTemplate');
export type AssessmentTemplate = z.infer<typeof AssessmentTemplateSchema>;

export const CreateAssessmentTemplateBody = withCommandMeta({
  programId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  version: z.number().int().min(1).max(1000).default(1),
  skillAreas: z
    .array(z.strictObject({ key: SkillKey, label: z.string().trim().min(1).max(200) }))
    .min(1)
    .max(50)
    .refine((areas) => new Set(areas.map((a) => a.key)).size === areas.length, {
      message: 'skill area keys are unique',
    }),
  /** An ordinal scale: the levels in order, lowest first (2 to 20). */
  scale: z.strictObject({
    kind: z.literal('ordinal'),
    levels: z.array(z.string().trim().min(1).max(100)).min(2).max(20),
  }),
}).openapi('CreateAssessmentTemplateRequest');
export type CreateAssessmentTemplateInput = z.infer<typeof CreateAssessmentTemplateBody>;

export const ApproveAssessmentTemplateBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ApproveAssessmentTemplateRequest');
export const RetireAssessmentTemplateBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RetireAssessmentTemplateRequest');

export const AssessmentVisibilitySchema = z
  .enum(['staff_only', 'family'])
  .openapi('AssessmentVisibility');
export const AssessmentStatusSchema = z
  .enum(['draft', 'submitted', 'returned', 'published', 'recorded', 'withdrawn'])
  .openapi('AssessmentStatus');

/** Staff view (program managers, coaches of the offering): includes staff and review notes. */
export const AssessmentSchema = z
  .object({
    id: z.uuid(),
    templateId: z.uuid(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    skillAreaKey: z.string(),
    observedOn: z.iso.date(),
    scaleValue: z.number().int(),
    comments: z.string().nullable(),
    staffNote: z.string().nullable(),
    visibility: AssessmentVisibilitySchema,
    status: AssessmentStatusSchema,
    authorPersonId: z.uuid(),
    reviewerPersonId: z.uuid().nullable(),
    reviewNote: z.string().nullable(),
    reviewedAt: Instant.nullable(),
    correctsAssessmentId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Assessment');
export type Assessment = z.infer<typeof AssessmentSchema>;

export const CreateAssessmentBody = withCommandMeta({
  templateId: z.uuid(),
  participantPersonId: z.uuid(),
  offeringId: z.uuid(),
  skillAreaKey: SkillKey,
  observedOn: z.iso.date(),
  scaleValue: z.number().int().min(1).max(20),
  comments: z.string().trim().min(1).max(4000).optional(),
  staffNote: z.string().trim().min(1).max(4000).optional(),
  visibility: AssessmentVisibilitySchema,
  /** A correction of a published or recorded assessment (a new row). */
  correctsAssessmentId: z.uuid().optional(),
}).openapi('CreateAssessmentRequest');
export type CreateAssessmentInput = z.infer<typeof CreateAssessmentBody>;

export const UpdateAssessmentBody = withCommandMeta({
  skillAreaKey: SkillKey.optional(),
  observedOn: z.iso.date().optional(),
  scaleValue: z.number().int().min(1).max(20).optional(),
  comments: z.string().trim().min(1).max(4000).nullable().optional(),
  staffNote: z.string().trim().min(1).max(4000).nullable().optional(),
  visibility: AssessmentVisibilitySchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateAssessmentRequest');
export type UpdateAssessmentInput = z.infer<typeof UpdateAssessmentBody>;

export const SubmitAssessmentBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('SubmitAssessmentRequest');
export const WithdrawAssessmentBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('WithdrawAssessmentRequest');
export const ReviewAssessmentBody = withCommandMeta({
  decision: z.enum(['approve', 'return']),
  /** Required to return. */
  note: z.string().trim().min(1).max(4000).optional(),
})
  .extend({ expectedRevision: Revision })
  .refine((v) => v.decision !== 'return' || !!v.note, {
    message: 'a returned assessment says why',
    path: ['note'],
  })
  .openapi('ReviewAssessmentRequest');
export type ReviewAssessmentInput = z.infer<typeof ReviewAssessmentBody>;

export const ProgressionRecommendationSchema = z
  .object({
    id: z.uuid(),
    participantPersonId: z.uuid(),
    fromOfferingId: z.uuid(),
    recommendedOfferingId: z.uuid().nullable(),
    recommendedProgramId: z.uuid().nullable(),
    /** Read-only evaluation of the recommended offering (unknown is kept unknown); null for a program. */
    eligibility: z.record(z.string(), z.unknown()).nullable(),
    suitability: z.string(),
    status: z.enum(['draft', 'shared', 'withdrawn']),
    sharedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('ProgressionRecommendation');
export type ProgressionRecommendation = z.infer<typeof ProgressionRecommendationSchema>;

export const CreateProgressionRecommendationBody = withCommandMeta({
  participantPersonId: z.uuid(),
  fromOfferingId: z.uuid(),
  recommendedOfferingId: z.uuid().optional(),
  recommendedProgramId: z.uuid().optional(),
  suitability: z.string().trim().min(1).max(4000),
})
  .refine((v) => !!v.recommendedOfferingId !== !!v.recommendedProgramId, {
    message: 'recommend exactly one offering or program',
    path: ['recommendedOfferingId'],
  })
  .openapi('CreateProgressionRecommendationRequest');
export type CreateProgressionRecommendationInput = z.infer<
  typeof CreateProgressionRecommendationBody
>;
export const ShareRecommendationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ShareRecommendationRequest');
export const WithdrawRecommendationBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('WithdrawRecommendationRequest');

/** Family view (SPK-YOUTH-005): published feedback only, never staff or review notes. */
export const YouthFeedbackSchema = z
  .object({
    assessments: z.array(
      z.object({
        id: z.uuid(),
        participantPersonId: z.uuid(),
        offeringId: z.uuid(),
        offeringName: z.string().nullable(),
        skillArea: z.object({ key: z.string(), label: z.string().nullable() }),
        observedOn: z.iso.date(),
        scaleValue: z.number().int(),
        scaleLabel: z.string().nullable(),
        scaleLevels: z.number().int().nullable(),
        comments: z.string().nullable(),
        publishedAt: Instant,
      }),
    ),
    recommendations: z.array(
      z.object({
        id: z.uuid(),
        participantPersonId: z.uuid(),
        fromOfferingId: z.uuid(),
        recommendedOfferingId: z.uuid().nullable(),
        recommendedProgramId: z.uuid().nullable(),
        suitability: z.string(),
        sharedAt: Instant,
      }),
    ),
  })
  .openapi('YouthFeedback');
export type YouthFeedback = z.infer<typeof YouthFeedbackSchema>;

export const ParticipantAssessmentsQuery = PageRequestSchema.extend({
  offeringId: z.uuid().optional(),
});
export type ParticipantAssessmentsQuery = z.infer<typeof ParticipantAssessmentsQuery>;

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
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function paramsOf(path: string): z.ZodObject<z.ZodRawShape> | undefined {
  if (path.includes('{personId}')) return z.object({ personId: z.uuid() });
  return path.includes('{id}') ? IdParams : undefined;
}

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
      params: paramsOf(path),
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied, participant authority required or capability disabled'),
      404: err('Not found or not visible (protected records never reveal existence)'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
      422: err('Eligibility failed'),
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
    request: { params: paramsOf(path), query: request ?? undefined },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/me/package-entitlements',
  "The caller's and their dependants' session packages (ENR-11)",
  ListMyPackageEntitlementsQuery,
  pageSchema(PackageEntitlementSchema),
);
query(
  '/package-entitlements',
  'Session packages (staff, facility-scoped; ENR-11)',
  ListPackageEntitlementsQuery,
  pageSchema(PackageEntitlementSchema),
);
command(
  'post',
  '/package-redemptions/{id}/reverse',
  'Reverse a package redemption: the credit is returned (staff correction, ungated; ENR-11)',
  ReversePackageRedemptionBody,
  PackageEntitlementSchema,
  200,
);
query(
  '/me/memberships',
  "The caller's and their dependants' memberships with term, suspensions and usage (ENR-12)",
  ListMyMembershipsQuery,
  pageSchema(MembershipSchema),
);
command(
  'post',
  '/enrollments/{id}/membership-suspensions',
  'Suspend a membership for a period (ENR-12)',
  CreateMembershipSuspensionBody,
  MembershipSuspensionSchema,
);
command(
  'post',
  '/membership-suspensions/{id}/end',
  'End a membership suspension (ENR-12)',
  EndMembershipSuspensionBody,
  MembershipSuspensionSchema,
  200,
);
query(
  '/offerings/{id}/booking-availability',
  'Free times of the resources a published rental or party offering reserves (ENR-13)',
  BookingAvailabilityQuery,
  BookingAvailabilitySchema,
);
command(
  'post',
  '/bookings',
  'Book (instant) or request (approval) a rental or party with its space, equipment and staff (ENR-13)',
  CreateBookingBody,
  BookingSchema,
);
command(
  'post',
  '/bookings/{id}/approve',
  'Approve a requested booking: reserves it now and starts the hold (ENR-13)',
  ApproveBookingBody,
  BookingSchema,
  200,
);
command(
  'post',
  '/bookings/{id}/decline',
  'Decline a requested booking (ENR-13)',
  DeclineBookingBody,
  BookingSchema,
  200,
);
command(
  'post',
  '/bookings/{id}/cancel',
  'Cancel a booking and release what it holds (ENR-13)',
  CancelBookingBody,
  BookingSchema,
  200,
);
query(
  '/me/bookings',
  "The caller's rentals and parties (ENR-13)",
  ListMyBookingsQuery,
  pageSchema(BookingSchema),
);
query('/bookings/{id}', 'Read a rental or party (booker or staff)', null, BookingSchema);
query(
  '/bookings',
  'Rentals and parties (staff, facility-scoped)',
  ListBookingsQuery,
  pageSchema(BookingSchema),
);
command(
  'post',
  '/assessment-templates',
  'Draft a youth assessment template (ENR-14)',
  CreateAssessmentTemplateBody,
  AssessmentTemplateSchema,
);
command(
  'post',
  '/assessment-templates/{id}/approve',
  'Approve an assessment template (ENR-14)',
  ApproveAssessmentTemplateBody,
  AssessmentTemplateSchema,
  200,
);
command(
  'post',
  '/assessment-templates/{id}/retire',
  'Retire an assessment template (ENR-14, never gated)',
  RetireAssessmentTemplateBody,
  AssessmentTemplateSchema,
  200,
);
command(
  'post',
  '/assessments',
  'Draft a youth assessment (ENR-14)',
  CreateAssessmentBody,
  AssessmentSchema,
);
command(
  'patch',
  '/assessments/{id}',
  'Edit a draft or returned assessment (ENR-14)',
  UpdateAssessmentBody,
  AssessmentSchema,
  200,
);
command(
  'post',
  '/assessments/{id}/submit',
  'Submit an assessment for review (ENR-14)',
  SubmitAssessmentBody,
  AssessmentSchema,
  200,
);
command(
  'post',
  '/assessments/{id}/withdraw',
  'Withdraw a draft or returned assessment (ENR-14, never gated)',
  WithdrawAssessmentBody,
  AssessmentSchema,
  200,
);
command(
  'post',
  '/assessments/{id}/review',
  'Approve (publish or record) or return an assessment; the reviewer is not the author (ENR-14)',
  ReviewAssessmentBody,
  AssessmentSchema,
  200,
);
command(
  'post',
  '/progression-recommendations',
  'Draft a progression recommendation (ENR-14)',
  CreateProgressionRecommendationBody,
  ProgressionRecommendationSchema,
);
command(
  'post',
  '/progression-recommendations/{id}/share',
  'Share a progression recommendation with the family (ENR-14)',
  ShareRecommendationBody,
  ProgressionRecommendationSchema,
  200,
);
command(
  'post',
  '/progression-recommendations/{id}/withdraw',
  'Withdraw a progression recommendation (ENR-14, never gated)',
  WithdrawRecommendationBody,
  ProgressionRecommendationSchema,
  200,
);
query(
  '/me/youth-feedback',
  'Published feedback and shared recommendations of the participants one may view (ENR-14)',
  null,
  YouthFeedbackSchema,
);
query(
  '/participants/{personId}/assessments',
  "A participant's assessments (program managers in facility scope; coaches of their offerings)",
  ParticipantAssessmentsQuery,
  pageSchema(AssessmentSchema),
);
command(
  'post',
  '/enrollments/{id}/renew',
  'Add a renewal of the membership to a basket; nothing is charged until checkout (ENR-12)',
  RenewMembershipBody,
  BasketSchema,
);
