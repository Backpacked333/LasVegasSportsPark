import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';

/**
 * Rental-group rosters (SPK-COND-005, proposed amendment PA-09; capability `rental_rosters`,
 * DEC-103). Proposed. A rental booking may have a roster of the people the renter brings. The
 * renter or staff add and invite people; each invited person joins for themselves or their child;
 * staff see who is on the roster and whose liability waiver (SPK-REG-011) is missing. Being on a
 * roster grants nothing else: it is not a team entry, a registration or an entitlement.
 */

const Reason = z.string().trim().min(1).max(2000);
const IdParams = z.object({ id: z.uuid() });
const MemberParams = z.object({ id: z.uuid(), memberId: z.uuid() });
const TAG = 'Enrollment';

export const BookingRosterMemberStatusSchema = z
  .enum(['invited', 'joined', 'removed'])
  .openapi('BookingRosterMemberStatus');
export type BookingRosterMemberStatus = z.infer<typeof BookingRosterMemberStatusSchema>;

/** As readers see it: a pending invitation past its expiry reads `expired`. */
export const BookingRosterInvitationStatusSchema = z
  .enum(['pending', 'accepted', 'declined', 'revoked', 'expired'])
  .openapi('BookingRosterInvitationStatus');
export type BookingRosterInvitationStatus = z.infer<typeof BookingRosterInvitationStatusSchema>;

/**
 * A member's liability waiver for the rental offering's required waiver, as the catalog judged it
 * (SPK-REG-011). `not_evaluated`: liability waivers are turned off, the offering requires no
 * waiver, or the row has no person yet.
 */
export const BookingRosterWaiverStatusSchema = z
  .enum(['current', 'lapsed', 'missing', 'not_evaluated'])
  .openapi('BookingRosterWaiverStatus');
export type BookingRosterWaiverStatus = z.infer<typeof BookingRosterWaiverStatusSchema>;

export const BookingRosterContactSchema = z
  .object({
    kind: z.enum(['email', 'phone']),
    value: z.string().trim().min(3).max(320),
  })
  .openapi('BookingRosterContact');
export type BookingRosterContact = z.infer<typeof BookingRosterContactSchema>;

export const BookingRosterInvitationSchema = z
  .object({
    id: z.uuid(),
    bookingId: z.uuid(),
    memberId: z.uuid(),
    recipientPersonId: z.uuid().nullable(),
    recipientContact: BookingRosterContactSchema.nullable(),
    message: z.string().nullable(),
    status: BookingRosterInvitationStatusSchema,
    expiresAt: Instant,
    acceptedAt: Instant.nullable(),
    declinedAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
    invitedByPersonId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('BookingRosterInvitation');
export type BookingRosterInvitation = z.infer<typeof BookingRosterInvitationSchema>;

/**
 * The invitation with its one-time token: shown once, to the inviter, to pass on. The token opens
 * and answers an invitation to a contact. It does nothing for an invitation that names a person:
 * that one is answered by the person, signed in, or by somebody who may act for them.
 */
export const BookingRosterInvitationIssuedSchema = BookingRosterInvitationSchema.extend({
  token: z.string(),
}).openapi('BookingRosterInvitationIssued');
export type BookingRosterInvitationIssued = z.infer<typeof BookingRosterInvitationIssuedSchema>;

export const BookingRosterMemberSchema = z
  .object({
    id: z.uuid(),
    bookingId: z.uuid(),
    /**
     * The person on the row. Null for a contact invitation nobody accepted yet, and, while a row
     * has not joined, for every reader except staff and somebody who may act for that person.
     */
    personId: z.uuid().nullable(),
    /**
     * The person's display name, once they have joined. A person's details are theirs until they
     * join: an invited row has no name here for any reader.
     */
    displayName: z.string().nullable(),
    /** The contact an unaccepted invitation was sent to; null once a person is known. */
    invitedContact: BookingRosterContactSchema.nullable(),
    status: BookingRosterMemberStatusSchema,
    /** Judged only for a joined member; `not_evaluated` for an invited or removed row. */
    waiverStatus: BookingRosterWaiverStatusSchema,
    addedByPersonId: z.uuid().nullable(),
    addedAt: Instant,
    joinedAt: Instant.nullable(),
    removedAt: Instant.nullable(),
    removalReason: z.string().nullable(),
    /** The latest invitation behind this row, if it was invited. */
    invitation: z
      .object({
        id: z.uuid(),
        status: BookingRosterInvitationStatusSchema,
        expiresAt: Instant,
      })
      .nullable(),
    revision: Revision,
  })
  .openapi('BookingRosterMember');
export type BookingRosterMember = z.infer<typeof BookingRosterMemberSchema>;

/**
 * Why the members' waiver statuses read as they do: `evaluated` (the offering requires the waiver
 * families in `policyKeys`), `not_required` (it requires none) or `capability_off` (liability
 * waivers are turned off for the organization).
 */
export const BookingRosterWaiverRequirementSchema = z
  .object({
    state: z.enum(['evaluated', 'not_required', 'capability_off']),
    policyKeys: z.array(z.string()),
    /** Proposed default (DEC-103 pending): a missing waiver is shown and never blocks the booking. */
    blocksBooking: z.literal(false),
  })
  .openapi('BookingRosterWaiverRequirement');
export type BookingRosterWaiverRequirement = z.infer<typeof BookingRosterWaiverRequirementSchema>;

export const BookingRosterSchema = z
  .object({
    bookingId: z.uuid(),
    waiver: BookingRosterWaiverRequirementSchema,
    /** Live members first (joined, then invited), then removed ones. */
    members: z.array(BookingRosterMemberSchema),
    counts: z.object({
      joined: z.number().int(),
      invited: z.number().int(),
      /** Joined members whose waiver is missing or lapsed (0 when not evaluated). */
      waiverOutstanding: z.number().int(),
    }),
  })
  .openapi('BookingRoster');
export type BookingRoster = z.infer<typeof BookingRosterSchema>;

export const AddBookingRosterMemberBody = withCommandMeta({
  /** The person to add: yourself, or someone you may register (your child). Staff: anyone. */
  personId: z.uuid(),
}).openapi('AddBookingRosterMemberRequest');
export type AddBookingRosterMemberInput = z.infer<typeof AddBookingRosterMemberBody>;

export const CreateBookingRosterInvitationBody = withCommandMeta({
  /**
   * Staff: any active person. A renter: only themselves or someone they may register; any other
   * reference is refused with `ROSTER_INVITE_BY_CONTACT`, whether or not it names anybody.
   */
  recipientPersonId: z.uuid().optional(),
  recipientContact: BookingRosterContactSchema.optional(),
  message: z.string().trim().min(1).max(1000).optional(),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
})
  .refine((v) => (v.recipientPersonId !== undefined) !== (v.recipientContact !== undefined), {
    message: 'name exactly one of recipientPersonId or recipientContact',
    path: ['recipientPersonId'],
  })
  .openapi('CreateBookingRosterInvitationRequest');
export type CreateBookingRosterInvitationInput = z.infer<typeof CreateBookingRosterInvitationBody>;

export const AcceptBookingRosterInvitationBody = withCommandMeta({
  /**
   * Required for an invitation to a contact. Not needed, and not enough, for an invitation that
   * names a person: only that person or somebody who may act for them accepts it.
   */
  token: z.string().min(16).max(200).optional(),
  /**
   * Who joins. A contact invitation: the signed-in person (the default) or a child they may
   * register. An invitation that names a person: that person only.
   */
  personId: z.uuid().optional(),
}).openapi('AcceptBookingRosterInvitationRequest');
export type AcceptBookingRosterInvitationInput = z.infer<typeof AcceptBookingRosterInvitationBody>;

export const DeclineBookingRosterInvitationBody = withCommandMeta({
  token: z.string().min(16).max(200).optional(),
}).openapi('DeclineBookingRosterInvitationRequest');
export type DeclineBookingRosterInvitationInput = z.infer<
  typeof DeclineBookingRosterInvitationBody
>;

export const RevokeBookingRosterInvitationBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeBookingRosterInvitationRequest');
export type RevokeBookingRosterInvitationInput = z.infer<typeof RevokeBookingRosterInvitationBody>;

export const RemoveBookingRosterMemberBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RemoveBookingRosterMemberRequest');
export type RemoveBookingRosterMemberInput = z.infer<typeof RemoveBookingRosterMemberBody>;

export const BookingRosterInvitationAcceptedSchema = z
  .object({ invitation: BookingRosterInvitationSchema, member: BookingRosterMemberSchema })
  .openapi('BookingRosterInvitationAccepted');
export type BookingRosterInvitationAccepted = z.infer<typeof BookingRosterInvitationAcceptedSchema>;

/** What the invited person sees before answering: what they are invited to, nothing more. */
export const BookingRosterInvitationViewSchema = BookingRosterInvitationSchema.extend({
  booking: z.object({
    id: z.uuid(),
    offeringName: z.string(),
    facilityId: z.uuid(),
    timezone: z.string().nullable(),
    firstStart: Instant,
    lastEnd: Instant,
    occurrenceCount: z.number().int(),
  }),
  invitedByName: z.string().nullable(),
  /** The waiver families the rental requires (empty when none or liability waivers are off). */
  requiredWaiverKeys: z.array(z.string()),
}).openapi('BookingRosterInvitationView');
export type BookingRosterInvitationView = z.infer<typeof BookingRosterInvitationViewSchema>;

/** Opening a contact invitation with its token: sent in the body, never in the address (§4.14). */
export const OpenBookingRosterInvitationBody = z
  .object({ token: z.string().min(16).max(200) })
  .openapi('OpenBookingRosterInvitationRequest');
export type OpenBookingRosterInvitationInput = z.infer<typeof OpenBookingRosterInvitationBody>;

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

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{memberId}') ? MemberParams : IdParams,
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

function query(path: string, summary: string, response: z.ZodType) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: { params: path.includes('{id}') ? IdParams : undefined },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/bookings/{id}/roster',
  "A rental booking's group roster with each member's waiver status (the renter, or staff at the facility) (SPK-COND-005, proposed)",
  BookingRosterSchema,
);
command(
  '/bookings/{id}/roster',
  'Add a person to the roster: yourself or someone you may register, or anyone when staff (SPK-COND-005, proposed)',
  AddBookingRosterMemberBody,
  BookingRosterMemberSchema,
);
command(
  '/bookings/{id}/roster/invitations',
  'Invite a contact, or a person the caller may name (staff: anyone; a renter: themselves or someone they register), to the roster; the one-time token is returned once (SPK-COND-005, proposed)',
  CreateBookingRosterInvitationBody,
  BookingRosterInvitationIssuedSchema,
);
command(
  '/bookings/{id}/roster/members/{memberId}/remove',
  'Remove a roster member: the renter, staff, or the member themselves (SPK-COND-005, proposed)',
  RemoveBookingRosterMemberBody,
  BookingRosterMemberSchema,
  200,
);
query(
  '/me/booking-roster-invitations',
  'The pending roster invitations addressed to the signed-in person (SPK-COND-005, proposed)',
  z.array(BookingRosterInvitationViewSchema),
);
query(
  '/booking-roster-invitations/{id}',
  'Read a roster invitation: the person it names or somebody who acts for them, the renter or staff (SPK-COND-005, proposed)',
  BookingRosterInvitationViewSchema,
);
openApiRegistry.registerPath({
  method: 'post',
  path: '/booking-roster-invitations/{id}/open',
  summary:
    'Read an invitation to a contact with its token, sent in the body (a pure read; SPK-COND-005, proposed)',
  tags: [TAG],
  request: {
    params: IdParams,
    body: { content: { 'application/json': { schema: OpenBookingRosterInvitationBody } } },
  },
  responses: {
    200: ok('The invitation', BookingRosterInvitationViewSchema),
    400: err('Validation failed'),
    404: err('Not found or not visible (also a wrong token)'),
  },
});
command(
  '/booking-roster-invitations/{id}/accept',
  'Accept a roster invitation: the person it names (or somebody who acts for them), or the token holder of a contact invitation for themselves or their child (SPK-COND-005, proposed)',
  AcceptBookingRosterInvitationBody,
  BookingRosterInvitationAcceptedSchema,
  200,
);
command(
  '/booking-roster-invitations/{id}/decline',
  'Decline a roster invitation (SPK-COND-005, proposed)',
  DeclineBookingRosterInvitationBody,
  BookingRosterInvitationSchema,
  200,
);
command(
  '/booking-roster-invitations/{id}/revoke',
  'Revoke a pending roster invitation: the renter or staff (SPK-COND-005, proposed)',
  RevokeBookingRosterInvitationBody,
  BookingRosterInvitationSchema,
  200,
);
