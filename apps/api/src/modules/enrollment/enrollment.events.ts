import {
  ApplicationStatusSchema,
  defineEvent,
  EnrollmentStatusSchema,
  FinancialConsequenceSchema,
  RegistrationIntentSchema,
  z,
} from '@sportspark/contracts';

/**
 * Enrollment domain events (§4.12). Payloads carry identifiers and configuration only, never
 * participant names, dates of birth or payer details (§4.14). Finance, communications, entry,
 * reporting and this module's own handlers subscribe.
 */
const Ref = { organizationId: z.uuid() };

export const EnrollmentEvents = {
  applicationSubmitted: defineEvent(
    'enrollment.application_submitted',
    z.object({
      ...Ref,
      applicationId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
      intent: RegistrationIntentSchema,
      status: ApplicationStatusSchema,
      eligible: z.boolean(),
      requiresApproval: z.boolean(),
    }),
  ),
  eligibilityOverridden: defineEvent(
    'enrollment.eligibility_overridden',
    z.object({ ...Ref, applicationId: z.uuid(), offeringId: z.uuid(), reason: z.string() }),
  ),
  applicationDecided: defineEvent(
    'enrollment.application_decided',
    z.object({
      ...Ref,
      applicationId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
      status: ApplicationStatusSchema,
    }),
  ),
  applicationWithdrawn: defineEvent(
    'enrollment.application_withdrawn',
    z.object({ ...Ref, applicationId: z.uuid(), offeringId: z.uuid() }),
  ),
  basketHeld: defineEvent(
    'enrollment.basket_held',
    z.object({
      ...Ref,
      basketId: z.uuid(),
      holdIds: z.array(z.uuid()),
      enrollmentIds: z.array(z.uuid()),
      expiresAt: z.string(),
      approvalPending: z.boolean(),
    }),
  ),
  basketReleased: defineEvent(
    'enrollment.basket_released',
    z.object({ ...Ref, basketId: z.uuid(), reason: z.string() }),
  ),
  basketFulfilled: defineEvent(
    'enrollment.basket_fulfilled',
    z.object({
      ...Ref,
      basketId: z.uuid(),
      enrollmentIds: z.array(z.uuid()),
      partial: z.boolean(),
    }),
  ),
  /** Timer: enqueued with availableAt = expiresAt; handled by `enrollment.expire_hold` (SPK-REG-006). */
  holdExpiryDue: defineEvent(
    'enrollment.hold_expiry_due',
    z.object({ ...Ref, holdId: z.uuid(), poolId: z.uuid(), expiresAt: z.string() }),
  ),
  holdExpired: defineEvent(
    'enrollment.hold_expired',
    z.object({ ...Ref, holdId: z.uuid(), poolId: z.uuid(), quantity: z.number().int() }),
  ),
  holdCommitted: defineEvent(
    'enrollment.hold_committed',
    z.object({ ...Ref, holdId: z.uuid(), poolId: z.uuid(), quantity: z.number().int() }),
  ),
  holdReleased: defineEvent(
    'enrollment.hold_released',
    z.object({
      ...Ref,
      holdId: z.uuid(),
      poolId: z.uuid(),
      quantity: z.number().int(),
      reason: z.string(),
    }),
  ),
  /** Capacity came back to a pool; handled by `enrollment.offer_waitlist` (SPK-REG-008). */
  capacityReleased: defineEvent(
    'enrollment.capacity_released',
    z.object({ ...Ref, poolId: z.uuid(), quantity: z.number().int(), cause: z.string() }),
  ),
  capacityPoolChanged: defineEvent(
    'enrollment.capacity_pool_changed',
    z.object({
      ...Ref,
      poolId: z.uuid(),
      offeringId: z.uuid().nullable(),
      constraintKind: z.string(),
      capacityBefore: z.number().int(),
      capacityAfter: z.number().int(),
      reason: z.string().nullable(),
    }),
  ),
  enrollmentCreated: defineEvent(
    'enrollment.enrollment_created',
    z.object({
      ...Ref,
      enrollmentId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
      intent: RegistrationIntentSchema,
      basketId: z.uuid().nullable(),
      status: EnrollmentStatusSchema,
    }),
  ),
  enrollmentConfirmed: defineEvent(
    'enrollment.enrollment_confirmed',
    z.object({
      ...Ref,
      enrollmentId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
      orderRef: z.string().nullable(),
    }),
  ),
  enrollmentCanceled: defineEvent(
    'enrollment.enrollment_canceled',
    z.object({
      ...Ref,
      enrollmentId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
      reason: z.string(),
      previousStatus: EnrollmentStatusSchema,
    }),
  ),
  enrollmentCompleted: defineEvent(
    'enrollment.enrollment_completed',
    z.object({
      ...Ref,
      enrollmentId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
    }),
  ),
  enrollmentTransferred: defineEvent(
    'enrollment.enrollment_transferred',
    z.object({
      ...Ref,
      fromEnrollmentId: z.uuid(),
      toEnrollmentId: z.uuid(),
      fromOfferingId: z.uuid(),
      toOfferingId: z.uuid(),
      participantPersonId: z.uuid(),
      /** SPK-REG-010: the full refund, credit or charge accepted with the transfer (DEC-009). */
      financialConsequence: FinancialConsequenceSchema,
    }),
  ),
  waitlistJoined: defineEvent(
    'enrollment.waitlist_joined',
    z.object({
      ...Ref,
      waitlistEntryId: z.uuid(),
      offeringId: z.uuid(),
      poolId: z.uuid(),
      participantPersonId: z.uuid(),
    }),
  ),
  waitlistLeft: defineEvent(
    'enrollment.waitlist_left',
    z.object({ ...Ref, waitlistEntryId: z.uuid(), poolId: z.uuid(), status: z.string() }),
  ),
  waitlistOfferMade: defineEvent(
    'enrollment.waitlist_offer_made',
    z.object({
      ...Ref,
      offerId: z.uuid(),
      waitlistEntryId: z.uuid(),
      poolId: z.uuid(),
      holdId: z.uuid(),
      participantPersonId: z.uuid(),
      expiresAt: z.string(),
    }),
  ),
  waitlistOfferResolved: defineEvent(
    'enrollment.waitlist_offer_resolved',
    z.object({
      ...Ref,
      offerId: z.uuid(),
      waitlistEntryId: z.uuid(),
      status: z.enum(['accepted', 'expired', 'declined']),
      basketId: z.uuid().nullable(),
    }),
  ),
  placementRequested: defineEvent(
    'enrollment.placement_requested',
    z.object({
      ...Ref,
      placementRequestId: z.uuid(),
      seasonId: z.uuid(),
      participantPersonId: z.uuid(),
    }),
  ),
  placementProposed: defineEvent(
    'enrollment.placement_proposed',
    z.object({ ...Ref, placementRequestId: z.uuid(), teamEntryId: z.uuid() }),
  ),
  placementAssigned: defineEvent(
    'enrollment.placement_assigned',
    z.object({
      ...Ref,
      placementRequestId: z.uuid(),
      teamEntryId: z.uuid(),
      participantPersonId: z.uuid(),
      rosterMembershipRef: z.uuid().nullable(),
    }),
  ),
  placementReleased: defineEvent(
    'enrollment.placement_released',
    z.object({ ...Ref, placementRequestId: z.uuid(), reason: z.string() }),
  ),
  sessionBooked: defineEvent(
    'enrollment.session_booked',
    z.object({
      ...Ref,
      bookingId: z.uuid(),
      offeringId: z.uuid(),
      sessionId: z.uuid(),
      participantPersonId: z.uuid(),
      kind: z.string(),
      status: z.string(),
    }),
  ),
  sessionBookingChanged: defineEvent(
    'enrollment.session_booking_changed',
    z.object({
      ...Ref,
      bookingId: z.uuid(),
      sessionId: z.uuid(),
      participantPersonId: z.uuid(),
      status: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  makeupIssued: defineEvent(
    'enrollment.makeup_issued',
    z.object({
      ...Ref,
      makeupEntitlementId: z.uuid(),
      participantPersonId: z.uuid(),
      redemptionLimit: z.number().int(),
      expiresAt: z.string(),
    }),
  ),
  makeupRedeemed: defineEvent(
    'enrollment.makeup_redeemed',
    z.object({
      ...Ref,
      makeupEntitlementId: z.uuid(),
      bookingId: z.uuid(),
      redeemedCount: z.number().int(),
      redemptionLimit: z.number().int(),
    }),
  ),
  /** Timer: enqueued with availableAt = expiresAt; handled by `enrollment.expire_makeup`. */
  makeupExpiryDue: defineEvent(
    'enrollment.makeup_expiry_due',
    z.object({ ...Ref, makeupEntitlementId: z.uuid(), expiresAt: z.string() }),
  ),
  makeupChanged: defineEvent(
    'enrollment.makeup_changed',
    z.object({
      ...Ref,
      makeupEntitlementId: z.uuid(),
      status: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  trialRecorded: defineEvent(
    'enrollment.trial_recorded',
    z.object({
      ...Ref,
      trialParticipationId: z.uuid(),
      offeringId: z.uuid(),
      participantPersonId: z.uuid(),
    }),
  ),
  trialChanged: defineEvent(
    'enrollment.trial_changed',
    z.object({
      ...Ref,
      trialParticipationId: z.uuid(),
      status: z.string(),
      convertedEnrollmentId: z.uuid().nullable(),
      convertedBasketId: z.uuid().nullable(),
    }),
  ),
};

export const HoldExpiryDue = EnrollmentEvents.holdExpiryDue;
export const CapacityReleased = EnrollmentEvents.capacityReleased;
export const EnrollmentConfirmed = EnrollmentEvents.enrollmentConfirmed;
export const EnrollmentCanceled = EnrollmentEvents.enrollmentCanceled;
export const MakeupExpiryDue = EnrollmentEvents.makeupExpiryDue;
