import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { StaffRole } from '../principal';
import { Instant } from '../time';
import { StaffAccessReviewOutcomeSchema } from './identity';

/**
 * Identity: operational care notes, staff access reviews and staff invitations (migration 0181).
 *
 * - Care notes (§1.7 "not a medical assessment system", SPK-DISC-005, §4.14, SPK-ENTRY-004): a
 *   short operational note (an allergy and what to do, a care instruction) on a person. Never a
 *   diagnosis, assessment or medical advice. Protected: read by the person, a holder of `view`
 *   over them, and the staff roles named in `visibleToRoles`; every read is audited.
 * - Staff access reviews (§4.14 least privilege, audited privileged actions): an administrator
 *   records that another staff member's roles were reviewed and when the next review is due. The
 *   review interval is not an operator policy yet: the reviewer sets the next date each time.
 * - Staff invitations (§2.1, SPK-IAM-004 applied to staff roles): an administrator invites an email
 *   address to take staff roles at a facility scope. The one-time token is returned on creation
 *   only; the person who holds that email as a verified contact point accepts, which creates one
 *   staff membership. No messaging channel is selected (DEC-012, DEC-062): the invitation is
 *   recorded as an `identity.staff_invitation_created` event for delivery.
 */

const Reason = z.string().trim().min(1).max(2000);
const Token = z.string().min(16).max(512);

// ---------------------------------------------------------------------------------------------
// Care notes
// ---------------------------------------------------------------------------------------------
export const CareNoteKindSchema = z.enum(['allergy', 'care_instruction']).openapi('CareNoteKind');
export type CareNoteKind = z.infer<typeof CareNoteKindSchema>;
export const CareNoteStatusSchema = z.enum(['active', 'retired']).openapi('CareNoteStatus');

export const CareNoteSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    kind: CareNoteKindSchema,
    body: z.string(),
    status: CareNoteStatusSchema,
    recordedAt: Instant,
    retiredAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('CareNote');
export type CareNote = z.infer<typeof CareNoteSchema>;

export const PersonCareNotesSchema = z
  .object({
    personId: z.uuid(),
    /** Active notes, oldest first (a merged person's notes are included, SPK-IAM-007). */
    notes: z.array(CareNoteSchema),
    /** The staff roles that may read these notes besides the person and holders of `view`. */
    visibleToRoles: z.array(StaffRole),
    /** Every read of care notes is recorded in the audit log (§4.14). */
    readAudited: z.literal(true),
  })
  .openapi('PersonCareNotes');
export type PersonCareNotes = z.infer<typeof PersonCareNotesSchema>;

export const RecordCareNoteBody = withCommandMeta({
  kind: CareNoteKindSchema,
  body: z.string().trim().min(1).max(500),
}).openapi('RecordCareNoteRequest');
export type RecordCareNoteInput = z.infer<typeof RecordCareNoteBody>;

export const RetireCareNoteBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RetireCareNoteRequest');
export type RetireCareNoteInput = z.infer<typeof RetireCareNoteBody>;

/** The care notes shown with an arrival scan (null when the caller may not read them). */
export const ScanCareNoteSchema = z
  .object({ id: z.uuid(), kind: CareNoteKindSchema, body: z.string() })
  .openapi('ScanCareNote');
export type ScanCareNote = z.infer<typeof ScanCareNoteSchema>;

// ---------------------------------------------------------------------------------------------
// Staff access reviews
// ---------------------------------------------------------------------------------------------
export const StaffAccessReviewSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    outcome: StaffAccessReviewOutcomeSchema,
    notes: z.string().nullable(),
    rolesReviewed: z.array(StaffRole),
    reviewedByPersonId: z.uuid(),
    reviewedAt: Instant,
    nextReviewDueAt: Instant,
  })
  .openapi('StaffAccessReview');
export type StaffAccessReview = z.infer<typeof StaffAccessReviewSchema>;

export const RecordStaffAccessReviewBody = withCommandMeta({
  personId: z.uuid(),
  outcome: StaffAccessReviewOutcomeSchema,
  notes: z.string().trim().min(1).max(2000).optional(),
  /** Set by the reviewer: the review interval is not an approved operator policy. */
  nextReviewDueAt: Instant,
}).openapi('RecordStaffAccessReviewRequest');
export type RecordStaffAccessReviewInput = z.infer<typeof RecordStaffAccessReviewBody>;

export const ListStaffAccessReviewsQuery = PageRequestSchema.extend({
  personId: z.uuid().optional(),
});
export type ListStaffAccessReviewsQueryInput = z.infer<typeof ListStaffAccessReviewsQuery>;
export const StaffAccessReviewPageSchema =
  pageSchema(StaffAccessReviewSchema).openapi('StaffAccessReviewPage');

/** Organization-wide review status of the staff in effect now. */
export const StaffAccessSummarySchema = z
  .object({
    asOf: Instant,
    /** People holding at least one staff role in effect now. */
    staffInEffect: z.number().int(),
    neverReviewed: z.number().int(),
    /** People whose latest review's next date has passed. */
    overdue: z.number().int(),
    /** The earliest next-review date among reviewed staff in effect, or null. */
    nextReviewDueAt: Instant.nullable(),
  })
  .openapi('StaffAccessSummary');
export type StaffAccessSummary = z.infer<typeof StaffAccessSummarySchema>;

// ---------------------------------------------------------------------------------------------
// Staff invitations
// ---------------------------------------------------------------------------------------------
export const StaffInvitationStatusSchema = z
  .enum(['pending', 'accepted', 'revoked', 'expired'])
  .openapi('StaffInvitationStatus');
export type StaffInvitationStatus = z.infer<typeof StaffInvitationStatusSchema>;

export const StaffInvitationSchema = z
  .object({
    id: z.uuid(),
    recipientEmail: z.string(),
    roles: z.array(StaffRole),
    facilityIds: z.array(z.uuid()),
    /** Read with expiry applied: a pending invitation past `expiresAt` reads as expired. */
    status: StaffInvitationStatusSchema,
    invitedByPersonId: z.uuid(),
    invitedByDisplayName: z.string().nullable(),
    expiresAt: Instant,
    acceptedAt: Instant.nullable(),
    acceptedByPersonId: z.uuid().nullable(),
    staffMembershipId: z.uuid().nullable(),
    revokedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('StaffInvitation');
export type StaffInvitation = z.infer<typeof StaffInvitationSchema>;

export const CreateStaffInvitationBody = withCommandMeta({
  email: z.email().max(320),
  roles: z.array(StaffRole).min(1).max(11),
  facilityIds: z.array(z.uuid()).max(50).default([]),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
}).openapi('CreateStaffInvitationRequest');
export type CreateStaffInvitationInput = z.infer<typeof CreateStaffInvitationBody>;

/** The one-time token is returned only on creation, for the administrator to deliver. */
export const StaffInvitationIssuedSchema = StaffInvitationSchema.extend({
  token: z.string(),
}).openapi('StaffInvitationIssued');
export type StaffInvitationIssued = z.infer<typeof StaffInvitationIssuedSchema>;

export const AcceptStaffInvitationBody = z
  .object({ token: Token })
  .openapi('AcceptStaffInvitationRequest');
export type AcceptStaffInvitationInput = z.infer<typeof AcceptStaffInvitationBody>;

export const RevokeStaffInvitationBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeStaffInvitationRequest');
export type RevokeStaffInvitationInput = z.infer<typeof RevokeStaffInvitationBody>;

export const ListStaffInvitationsQuery = PageRequestSchema.extend({
  status: StaffInvitationStatusSchema.optional(),
});
export type ListStaffInvitationsQueryInput = z.infer<typeof ListStaffInvitationsQuery>;
export const StaffInvitationPageSchema =
  pageSchema(StaffInvitationSchema).openapi('StaffInvitationPage');

export const StaffInvitationAcceptedSchema = z
  .object({
    invitation: StaffInvitationSchema,
    staffMembershipId: z.uuid(),
  })
  .openapi('StaffInvitationAccepted');
export type StaffInvitationAccepted = z.infer<typeof StaffInvitationAcceptedSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

function register(input: {
  method: 'get' | 'post';
  path: string;
  summary: string;
  requirements: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201;
  idempotent?: boolean;
}): void {
  const status = input.status ?? (input.method === 'post' ? 201 : 200);
  openApiRegistry.registerPath({
    method: input.method,
    path: input.path,
    summary: input.summary,
    description: `Implements ${input.requirements}.${
      input.idempotent ? ' Requires an Idempotency-Key header (§4.9).' : ''
    }`,
    tags: ['Identity'],
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
      403: errorResponse('Access denied'),
      404: errorResponse('Not found or not visible'),
      409: errorResponse('Conflict (stale revision, invalid transition, idempotency)'),
    },
  });
}

register({
  method: 'get',
  path: '/people/{id}/care-notes',
  summary:
    "A person's active operational care notes (protected; every read is audited; never a diagnosis)",
  requirements: '§1.7, §4.14, SPK-DISC-005, SPK-ENTRY-004',
  params: IdParams,
  response: PersonCareNotesSchema,
});
register({
  method: 'post',
  path: '/people/{id}/care-notes',
  summary: 'Record an operational care note (an allergy or a care instruction) on a person',
  requirements: '§1.7, §4.14, SPK-DISC-005',
  params: IdParams,
  body: RecordCareNoteBody,
  response: CareNoteSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/care-notes/{id}/retire',
  summary: 'Retire a care note with a reason (a correction is a new note)',
  requirements: '§4.7, §4.9, §4.14',
  params: IdParams,
  body: RetireCareNoteBody,
  response: CareNoteSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/staff-access-reviews',
  summary: "Record a review of another staff member's roles and the next review date",
  requirements: '§2.1, §4.14',
  body: RecordStaffAccessReviewBody,
  response: StaffAccessReviewSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/staff-access-reviews',
  summary: 'Staff access reviews, newest first (administrators)',
  requirements: '§2.1, §4.14',
  query: ListStaffAccessReviewsQuery,
  response: StaffAccessReviewPageSchema,
});
register({
  method: 'get',
  path: '/staff-access-summary',
  summary:
    'How many staff in effect are reviewed, overdue or never reviewed, and the next due date',
  requirements: '§2.1, §4.14',
  response: StaffAccessSummarySchema,
});
register({
  method: 'post',
  path: '/staff-invitations',
  summary: 'Invite an email address to take staff roles (the token is returned once)',
  requirements: '§2.1, §4.14, SPK-IAM-004',
  body: CreateStaffInvitationBody,
  response: StaffInvitationIssuedSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/staff-invitations',
  summary: 'Staff invitations, newest first (administrators)',
  requirements: '§2.1, SPK-IAM-004',
  query: ListStaffInvitationsQuery,
  response: StaffInvitationPageSchema,
});
register({
  method: 'post',
  path: '/staff-invitations/{id}/accept',
  summary:
    'Accept a staff invitation sent to a verified email of the caller (creates one staff membership)',
  requirements: '§2.1, SPK-IAM-004',
  params: IdParams,
  body: AcceptStaffInvitationBody,
  response: StaffInvitationAcceptedSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/staff-invitations/{id}/revoke',
  summary: 'Revoke a pending staff invitation with a reason',
  requirements: '§2.1, SPK-IAM-004',
  params: IdParams,
  body: RevokeStaffInvitationBody,
  response: StaffInvitationSchema,
  status: 200,
  idempotent: true,
});
