import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { CapacityUnitKindSchema, ChargeLineSchema, OfferingKindSchema } from './catalog';
import { EligibilitySeveritySchema } from './competition';

/**
 * Enrollment module API contract (specification §3.3 SPK-REG-001..010, §3.6 SPK-PLACE-001..005,
 * §3.13 SPK-YOUTH-001..007, §4.4 Participation + Capacity, §4.6, §4.7 invariants 2, 3, 7, §4.8
 * `POST /v1/enrollments/{id}/transfer` and `POST /v1/waitlist-offers/{id}/accept`).
 * Organization scope always comes from the authenticated principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the database check constraints in migration 0500 and the §4.6 machines)
// ---------------------------------------------------------------------------------------------

/** SPK-REG-001 registration intents. */
export const RegistrationIntentSchema = z
  .enum([
    'individual_league',
    'join_team',
    'create_team_entry',
    'youth',
    'trial',
    'makeup',
    'pickup',
    'rental_request',
  ])
  .openapi('RegistrationIntent');
export type RegistrationIntent = z.infer<typeof RegistrationIntentSchema>;

export const ApplicationStatusSchema = z
  .enum(['draft', 'submitted', 'awaiting_review', 'accepted', 'declined', 'withdrawn'])
  .openapi('ApplicationStatus');
export const EnrollmentStatusSchema = z
  .enum(['pending', 'confirmed', 'canceled', 'transferred', 'completed'])
  .openapi('EnrollmentStatus');
export const PlacementStatusSchema = z
  .enum(['unassigned', 'proposed', 'assigned', 'released'])
  .openapi('PlacementStatus');
export const HoldStatusSchema = z
  .enum(['active', 'committed', 'released', 'expired'])
  .openapi('HoldStatus');
export const SessionBookingStatusSchema = z
  .enum(['pending', 'confirmed', 'canceled', 'expired'])
  .openapi('SessionBookingStatus');
export const BasketStatusSchema = z
  .enum([
    'open',
    'held',
    'checking_out',
    'fulfilled',
    'partially_fulfilled',
    'expired',
    'released',
    'abandoned',
  ])
  .openapi('BasketStatus');
export const FulfillmentModeSchema = z
  .enum(['all_or_nothing', 'partial'])
  .openapi('FulfillmentMode');
export const BasketLineOutcomeSchema = z
  .enum(['pending', 'held', 'confirmed', 'failed', 'released'])
  .openapi('BasketLineOutcome');
export const CapacityPoolScopeTypeSchema = z
  .enum(['offering', 'session', 'division', 'team_entry', 'camp_group', 'rental'])
  .openapi('CapacityPoolScopeType');
export const CapacityConstraintKindSchema = z
  .enum(['commercial', 'staffing', 'space'])
  .openapi('CapacityConstraintKind');
export const WaitlistEntryStatusSchema = z
  .enum(['waiting', 'offered', 'accepted', 'expired', 'withdrawn', 'removed'])
  .openapi('WaitlistEntryStatus');
export const WaitlistOfferStatusSchema = z
  .enum(['offered', 'accepted', 'expired', 'declined'])
  .openapi('WaitlistOfferStatus');
export const WaitlistPriorityBasisSchema = z
  .enum(['joined_at', 'priority_tier', 'returning', 'manual'])
  .openapi('WaitlistPriorityBasis');
export const MakeupEntitlementStatusSchema = z
  .enum(['active', 'exhausted', 'expired', 'revoked'])
  .openapi('MakeupEntitlementStatus');
export const MakeupOriginKindSchema = z
  .enum(['session_canceled', 'absence', 'policy_event', 'manual'])
  .openapi('MakeupOriginKind');
export const SessionBookingKindSchema = z
  .enum(['pickup', 'trial', 'makeup', 'session'])
  .openapi('SessionBookingKind');
export const TrialParticipationStatusSchema = z
  .enum(['scheduled', 'attended', 'no_show', 'canceled', 'converted'])
  .openapi('TrialParticipationStatus');

const Reason = z.string().trim().min(1).max(2000);
const Note = z.string().trim().max(2000);
const Quantity = z.number().int().min(1).max(1000);

// ---------------------------------------------------------------------------------------------
// Shared value objects
// ---------------------------------------------------------------------------------------------

/** SPK-REG-002: an understandable reason with its source and the permitted next action. */
export const RegistrationEligibilityReasonSchema = z
  .object({
    code: z.string(),
    severity: EligibilitySeveritySchema,
    message: z.string(),
    source: z.object({ type: z.string(), id: z.string().nullable() }),
    requiredAction: z.string(),
  })
  .openapi('RegistrationEligibilityReason');
export type RegistrationEligibilityReason = z.infer<typeof RegistrationEligibilityReasonSchema>;

/** SPK-REG-002 permitted alternatives offered when eligibility fails. */
export const EligibilityAlternativeSchema = z
  .object({
    kind: z.enum([
      'join_waitlist',
      'trial',
      'other_offering',
      'request_placement',
      'complete_acknowledgment',
      'contact_staff',
    ]),
    message: z.string(),
    offeringId: z.uuid().nullable().default(null),
  })
  .openapi('EligibilityAlternative');
export type EligibilityAlternative = z.infer<typeof EligibilityAlternativeSchema>;

export const EligibilityResultSchema = z
  .object({
    eligible: z.boolean(),
    policyVersionId: z.uuid().nullable(),
    referenceDate: z.iso.date().nullable(),
    evaluatedAt: Instant,
    reasons: z.array(RegistrationEligibilityReasonSchema),
    alternatives: z.array(EligibilityAlternativeSchema),
    /** True when a staff override replaced a failed evaluation (SPK-REG-002). */
    overridden: z.boolean().default(false),
  })
  .openapi('EligibilityResult');
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;

export const EligibilityOverrideSchema = z
  .object({
    actorPersonId: z.uuid().nullable(),
    actorLabel: z.string(),
    reason: z.string(),
    overriddenAt: Instant,
    originalReasons: z.array(RegistrationEligibilityReasonSchema),
  })
  .openapi('EligibilityOverride');
export type EligibilityOverride = z.infer<typeof EligibilityOverrideSchema>;

/**
 * Price basis copied from the catalog price rule effective when the line was added, refreshed from
 * the rule effective when it is held (SPK-PAY-001/002).
 */
export const PriceSnapshotSchema = z
  .object({
    priceRuleId: z.uuid(),
    basePriceMinor: z.number().int(),
    currency: CurrencyCode,
    chargeLines: z.array(ChargeLineSchema),
  })
  .openapi('PriceSnapshot');
export type PriceSnapshot = z.infer<typeof PriceSnapshotSchema>;

export const PolicyReferencesSchema = z
  .object({
    eligibilityPolicyVersionId: z.uuid().nullable(),
    cancellationPolicyVersionId: z.uuid().nullable(),
    requiredFormPolicyVersionIds: z.array(z.uuid()),
    approvalPolicyVersionId: z.uuid().nullable().default(null),
  })
  .openapi('PolicyReferences');
export type PolicyReferences = z.infer<typeof PolicyReferencesSchema>;

/** Actor snapshot kept on records so the staff actor is distinct from participant and payer (SPK-REG-009). */
export const RegistrationActorSnapshotSchema = z
  .object({
    kind: z.enum(['anonymous', 'customer', 'staff', 'system']),
    accountId: z.uuid().nullable(),
    personId: z.uuid().nullable(),
    staffRoles: z.array(z.string()),
    actorLabel: z.string(),
  })
  .openapi('RegistrationActorSnapshot');
export type RegistrationActorSnapshot = z.infer<typeof RegistrationActorSnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Applications (§4.4 Application)
// ---------------------------------------------------------------------------------------------

export const ApplicationSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    participantPersonId: z.uuid(),
    intent: RegistrationIntentSchema,
    status: ApplicationStatusSchema,
    submittedBy: RegistrationActorSnapshotSchema,
    submittedByPersonId: z.uuid().nullable(),
    payerPersonId: z.uuid().nullable(),
    eligibility: EligibilityResultSchema.nullable(),
    override: EligibilityOverrideSchema.nullable(),
    requiresApproval: z.boolean(),
    teamEntryId: z.uuid().nullable(),
    sessionId: z.uuid().nullable(),
    notes: z.string().nullable(),
    submittedAt: Instant.nullable(),
    decidedAt: Instant.nullable(),
    decidedByPersonId: z.uuid().nullable(),
    decisionReason: z.string().nullable(),
    withdrawnAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Application');
export type Application = z.infer<typeof ApplicationSchema>;

export const CreateApplicationBody = withCommandMeta({
  offeringId: z.uuid(),
  participantPersonId: z.uuid(),
  intent: RegistrationIntentSchema,
  payerPersonId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  notes: Note.optional(),
})
  .refine((v) => v.intent !== 'join_team' || v.teamEntryId !== undefined, {
    message: 'join_team requires teamEntryId',
    path: ['teamEntryId'],
  })
  .openapi('CreateApplicationRequest');
export type CreateApplicationInput = z.infer<typeof CreateApplicationBody>;

export const OverrideEligibilityBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('OverrideEligibilityRequest');
export type OverrideEligibilityInput = z.infer<typeof OverrideEligibilityBody>;

export const DecideApplicationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('DecideApplicationRequest');
export type DecideApplicationInput = z.infer<typeof DecideApplicationBody>;

export const DeclineApplicationBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('DeclineApplicationRequest');
export type DeclineApplicationInput = z.infer<typeof DeclineApplicationBody>;

export const WithdrawApplicationBody = withCommandMeta({}).openapi('WithdrawApplicationRequest');
export type WithdrawApplicationInput = z.infer<typeof WithdrawApplicationBody>;

export const ListApplicationsQuery = PageRequestSchema.extend({
  offeringId: z.uuid().optional(),
  participantPersonId: z.uuid().optional(),
  status: ApplicationStatusSchema.optional(),
});
export type ListApplicationsQuery = z.infer<typeof ListApplicationsQuery>;

// ---------------------------------------------------------------------------------------------
// Capacity pools and holds (§4.4 CapacityPool, Hold; SPK-REG-005/006; SPK-YOUTH-002)
// ---------------------------------------------------------------------------------------------

export const CapacityPoolSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid().nullable(),
    scopeType: CapacityPoolScopeTypeSchema,
    scopeId: z.uuid(),
    unit: CapacityUnitKindSchema,
    constraintKind: CapacityConstraintKindSchema,
    capacity: z.number().int(),
    committed: z.number().int(),
    held: z.number().int(),
    /** capacity - committed - held: what one more hold could take right now. */
    available: z.number().int(),
    participantsPerStaff: z.number().int().nullable(),
    staffCount: z.number().int().nullable(),
    status: z.enum(['active', 'closed']),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('CapacityPool');
export type CapacityPool = z.infer<typeof CapacityPoolSchema>;

export const CreateCapacityPoolBody = withCommandMeta({
  offeringId: z.uuid().optional(),
  scopeType: CapacityPoolScopeTypeSchema,
  scopeId: z.uuid(),
  unit: CapacityUnitKindSchema,
  constraintKind: CapacityConstraintKindSchema.default('commercial'),
  capacity: z.number().int().min(0).max(1_000_000),
  participantsPerStaff: z.number().int().min(1).optional(),
  staffCount: z.number().int().min(0).optional(),
})
  .refine(
    (v) =>
      v.constraintKind !== 'staffing' ||
      (v.participantsPerStaff !== undefined && v.staffCount !== undefined),
    { message: 'a staffing pool needs participantsPerStaff and staffCount', path: ['staffCount'] },
  )
  .openapi('CreateCapacityPoolRequest');
export type CreateCapacityPoolInput = z.infer<typeof CreateCapacityPoolBody>;

/** SPK-YOUTH-002: raising a staffing pool is explicit (staff count) and needs a reason. */
export const AdjustCapacityPoolBody = withCommandMeta({
  capacity: z.number().int().min(0).max(1_000_000).optional(),
  staffCount: z.number().int().min(0).optional(),
})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('AdjustCapacityPoolRequest');
export type AdjustCapacityPoolInput = z.infer<typeof AdjustCapacityPoolBody>;

export const SyncOfferingPoolsBody = withCommandMeta({}).openapi('SyncOfferingPoolsRequest');
export type SyncOfferingPoolsInput = z.infer<typeof SyncOfferingPoolsBody>;

export const ListCapacityPoolsQuery = z.object({
  offeringId: z.uuid().optional(),
  scopeType: CapacityPoolScopeTypeSchema.optional(),
  scopeId: z.uuid().optional(),
});
export type ListCapacityPoolsQuery = z.infer<typeof ListCapacityPoolsQuery>;

export const HoldSchema = z
  .object({
    id: z.uuid(),
    poolId: z.uuid(),
    quantity: z.number().int(),
    ownerKind: z.enum(['basket', 'waitlist_offer', 'session_booking', 'placement', 'staff']),
    ownerId: z.uuid().nullable(),
    basketId: z.uuid().nullable(),
    status: HoldStatusSchema,
    acquiredAt: Instant,
    /** Server-owned expiry; a client countdown is informational (SPK-REG-006). */
    expiresAt: Instant,
    committedAt: Instant.nullable(),
    releasedAt: Instant.nullable(),
    expiredAt: Instant.nullable(),
    releaseReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('Hold');
export type Hold = z.infer<typeof HoldSchema>;

// ---------------------------------------------------------------------------------------------
// Baskets (SPK-REG-004, SPK-REG-009)
// ---------------------------------------------------------------------------------------------

export const BasketLineSchema = z
  .object({
    id: z.uuid(),
    basketId: z.uuid(),
    sequence: z.number().int(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    offeringKind: OfferingKindSchema.nullable(),
    sessionId: z.uuid().nullable(),
    teamEntryId: z.uuid().nullable(),
    intent: RegistrationIntentSchema,
    quantity: z.number().int(),
    applicationId: z.uuid().nullable(),
    applicationStatus: ApplicationStatusSchema.nullable(),
    /** SPK-AT-019: the trial this follow-up line was opened from. */
    trialParticipationId: z.uuid().nullable(),
    entitlementDefinitionId: z.uuid().nullable(),
    equivalenceKey: z.string().nullable(),
    eligibility: EligibilityResultSchema.nullable(),
    price: PriceSnapshotSchema.nullable(),
    policies: PolicyReferencesSchema,
    requiresApproval: z.boolean(),
    enrollmentId: z.uuid().nullable(),
    outcome: BasketLineOutcomeSchema,
    outcomeReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('BasketLine');
export type BasketLine = z.infer<typeof BasketLineSchema>;

export const BasketSchema = z
  .object({
    id: z.uuid(),
    ownerPersonId: z.uuid(),
    payerPersonId: z.uuid().nullable(),
    createdBy: RegistrationActorSnapshotSchema,
    /** Present when a staff actor assisted (SPK-REG-009); never the participant, payer or signer. */
    assistedByPersonId: z.uuid().nullable(),
    fulfillmentMode: FulfillmentModeSchema,
    partialAcceptedAt: Instant.nullable(),
    status: BasketStatusSchema,
    holdExpiresAt: Instant.nullable(),
    currency: CurrencyCode.nullable(),
    /** Sum of the line base prices (minor units); finance quotes taxes, fees and discounts. */
    subtotalMinor: z.number().int(),
    /** True when any line awaits human approval (SPK-REG-007: approval before payment capture). */
    approvalPending: z.boolean(),
    orderRef: z.string().nullable(),
    lastOperationId: z.uuid().nullable(),
    lines: z.array(BasketLineSchema),
    holds: z.array(HoldSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Basket');
export type Basket = z.infer<typeof BasketSchema>;

export const CreateBasketBody = withCommandMeta({
  /** The household adult the basket belongs to; defaults to the acting customer. Staff must name it. */
  ownerPersonId: z.uuid().optional(),
  payerPersonId: z.uuid().optional(),
  fulfillmentMode: FulfillmentModeSchema.default('all_or_nothing'),
  /** SPK-REG-004: partial fulfillment requires the customer's explicit acceptance. */
  acceptPartialFulfillment: z.boolean().default(false),
})
  .refine((v) => v.fulfillmentMode !== 'partial' || v.acceptPartialFulfillment, {
    message: 'partial fulfillment must be explicitly accepted by the customer',
    path: ['acceptPartialFulfillment'],
  })
  .openapi('CreateBasketRequest');
export type CreateBasketInput = z.infer<typeof CreateBasketBody>;

export const AddBasketLineBody = withCommandMeta({
  participantPersonId: z.uuid(),
  offeringId: z.uuid(),
  intent: RegistrationIntentSchema,
  sessionId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  quantity: Quantity.default(1),
}).openapi('AddBasketLineRequest');
export type AddBasketLineInput = z.infer<typeof AddBasketLineBody>;

export const RemoveBasketLineBody = withCommandMeta({}).openapi('RemoveBasketLineRequest');
export type RemoveBasketLineInput = z.infer<typeof RemoveBasketLineBody>;

export const HoldBasketBody = withCommandMeta({}).openapi('HoldBasketRequest');
export type HoldBasketInput = z.infer<typeof HoldBasketBody>;

export const ReleaseBasketBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('ReleaseBasketRequest');
export type ReleaseBasketInput = z.infer<typeof ReleaseBasketBody>;

/** Completes a basket that owes nothing (every line priced at zero or unpriced). */
export const CompleteBasketBody = withCommandMeta({}).openapi('CompleteBasketRequest');
export type CompleteBasketInput = z.infer<typeof CompleteBasketBody>;

// ---------------------------------------------------------------------------------------------
// Enrollments (§4.4 Enrollment, SPK-REG-003/010)
// ---------------------------------------------------------------------------------------------

export const FinancialConsequenceSchema = z
  .object({
    kind: z.enum(['none', 'refund', 'credit', 'charge', 'review_required']),
    amountMinor: z.number().int().nullable(),
    currency: CurrencyCode.nullable(),
    explanation: z.string(),
    policyVersionId: z.uuid().nullable(),
  })
  .openapi('FinancialConsequence');
export type FinancialConsequence = z.infer<typeof FinancialConsequenceSchema>;

export const EnrollmentSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    participantPersonId: z.uuid(),
    intent: RegistrationIntentSchema,
    entitlementDefinitionId: z.uuid().nullable(),
    equivalenceKey: z.string().nullable(),
    status: EnrollmentStatusSchema,
    payerPersonId: z.uuid().nullable(),
    registeredBy: RegistrationActorSnapshotSchema,
    assistedByPersonId: z.uuid().nullable(),
    sourceApplicationId: z.uuid().nullable(),
    basketId: z.uuid().nullable(),
    basketLineId: z.uuid().nullable(),
    placementRequestId: z.uuid().nullable(),
    trialParticipationId: z.uuid().nullable(),
    orderRef: z.string().nullable(),
    lastOperationId: z.uuid().nullable(),
    price: PriceSnapshotSchema.nullable(),
    policies: PolicyReferencesSchema,
    confirmedAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    cancellationReason: z.string().nullable(),
    cancellationPolicyVersionId: z.uuid().nullable(),
    cancellationConsequence: FinancialConsequenceSchema.nullable(),
    transferredAt: Instant.nullable(),
    transferredToEnrollmentId: z.uuid().nullable(),
    transferredFromEnrollmentId: z.uuid().nullable(),
    /**
     * SPK-REG-010: the refund, credit or charge accepted with the transfer, on the transferred-from
     * enrollment (null otherwise, and for a viewer who may not see payer facts). Its execution is
     * pending DEC-009; a finance follow-up records it until then.
     */
    transferConsequence: FinancialConsequenceSchema.nullable(),
    completedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Enrollment');
export type Enrollment = z.infer<typeof EnrollmentSchema>;

export const ListEnrollmentsQuery = PageRequestSchema.extend({
  participantPersonId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  status: EnrollmentStatusSchema.optional(),
});
export type ListEnrollmentsQuery = z.infer<typeof ListEnrollmentsQuery>;

export const CancelEnrollmentBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('CancelEnrollmentRequest');
export type CancelEnrollmentInput = z.infer<typeof CancelEnrollmentBody>;

/** EnrollmentMachine `complete`: the participation ended as planned (staff). */
export const CompleteEnrollmentBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('CompleteEnrollmentRequest');
export type CompleteEnrollmentInput = z.infer<typeof CompleteEnrollmentBody>;

/** §4.8 transfer: `commit: false` previews (SPK-REG-010 "before commitment, show …"); `true` commits. */
export const TransferEnrollmentBody = withCommandMeta({
  targetOfferingId: z.uuid(),
  commit: z.boolean().default(false),
  /** Acknowledges the previewed financial consequence (required when it is not `none`). */
  acceptConsequence: z.boolean().default(false),
})
  .extend({ expectedRevision: Revision })
  .openapi('TransferEnrollmentRequest');
export type TransferEnrollmentInput = z.infer<typeof TransferEnrollmentBody>;

export const ParticipationSummarySchema = z
  .object({
    offeringId: z.uuid(),
    offeringName: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    entitlementDefinitionId: z.uuid().nullable(),
    price: PriceSnapshotSchema.nullable(),
  })
  .openapi('ParticipationSummary');

export const TransferPreviewSchema = z
  .object({
    enrollmentId: z.uuid(),
    existing: ParticipationSummarySchema,
    proposed: ParticipationSummarySchema,
    affectedDates: z.object({
      existingRange: z.object({ startsOn: z.iso.date(), endsOn: z.iso.date() }),
      proposedRange: z.object({ startsOn: z.iso.date(), endsOn: z.iso.date() }),
      overlapping: z.boolean(),
    }),
    capacity: z.object({
      released: z.array(z.object({ poolId: z.uuid(), unit: CapacityUnitKindSchema })),
      required: z.array(
        z.object({
          poolId: z.uuid(),
          unit: CapacityUnitKindSchema,
          constraintKind: CapacityConstraintKindSchema,
          available: z.number().int(),
        }),
      ),
      /** Others waiting for the target offering; a transfer never skips them (DEC-006 waitlistFirst). */
      waitlistAhead: z.number().int().min(0),
      sufficient: z.boolean(),
    }),
    eligibility: EligibilityResultSchema,
    financialConsequence: FinancialConsequenceSchema,
    requiredApproval: z.boolean(),
    committed: z.boolean(),
    newEnrollment: EnrollmentSchema.nullable(),
    previousEnrollment: EnrollmentSchema.nullable(),
  })
  .openapi('TransferPreview');
export type TransferPreview = z.infer<typeof TransferPreviewSchema>;

/** SPK-REG-010: what a cancellation would mean, shown before it is committed. Changes nothing. */
export const CancellationPreviewSchema = z
  .object({
    enrollmentId: z.uuid(),
    status: EnrollmentStatusSchema,
    existing: ParticipationSummarySchema,
    affectedDates: z.object({ startsOn: z.iso.date(), endsOn: z.iso.date() }),
    capacity: z.object({
      released: z.array(
        z.object({ poolId: z.uuid(), unit: CapacityUnitKindSchema, quantity: z.number().int() }),
      ),
    }),
    cancellationPolicyVersionId: z.uuid().nullable(),
    financialConsequence: FinancialConsequenceSchema,
    requiredApproval: z.boolean(),
    permitted: z.boolean(),
  })
  .openapi('CancellationPreview');
export type CancellationPreview = z.infer<typeof CancellationPreviewSchema>;

// ---------------------------------------------------------------------------------------------
// Waitlists (§4.4 WaitlistEntry/WaitlistOffer, SPK-REG-008)
// ---------------------------------------------------------------------------------------------

export const WaitlistOfferSchema = z
  .object({
    id: z.uuid(),
    waitlistEntryId: z.uuid(),
    poolId: z.uuid(),
    holdId: z.uuid(),
    quantity: z.number().int(),
    offeredAt: Instant,
    expiresAt: Instant,
    status: WaitlistOfferStatusSchema,
    acceptedAt: Instant.nullable(),
    acceptedBasketId: z.uuid().nullable(),
    acceptedEnrollmentId: z.uuid().nullable(),
    acceptedSessionBookingId: z.uuid().nullable(),
    declinedAt: Instant.nullable(),
    expiredAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('WaitlistOffer');
export type WaitlistOffer = z.infer<typeof WaitlistOfferSchema>;

export const WaitlistEntrySchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    poolId: z.uuid(),
    sessionId: z.uuid().nullable(),
    participantPersonId: z.uuid(),
    intent: RegistrationIntentSchema,
    priorityBasis: WaitlistPriorityBasisSchema,
    priorityRank: z.number().int(),
    joinedAt: Instant,
    queuedAt: Instant,
    preferences: z.record(z.string(), z.unknown()),
    payerPersonId: z.uuid().nullable(),
    status: WaitlistEntryStatusSchema,
    /** 1-based position among waiting entries of the pool (null when not waiting). */
    position: z.number().int().nullable(),
    offerCount: z.number().int(),
    /** Offer history (SPK-REG-008). */
    offers: z.array(WaitlistOfferSchema),
    acceptedEnrollmentId: z.uuid().nullable(),
    withdrawnAt: Instant.nullable(),
    removedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('WaitlistEntry');
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;

export const JoinWaitlistBody = withCommandMeta({
  offeringId: z.uuid(),
  participantPersonId: z.uuid(),
  intent: RegistrationIntentSchema,
  sessionId: z.uuid().optional(),
  payerPersonId: z.uuid().optional(),
  preferences: z.record(z.string(), z.unknown()).default({}),
  /** Staff only: priority basis and rank (customers always join by joined_at). */
  priorityBasis: WaitlistPriorityBasisSchema.optional(),
  priorityRank: z.number().int().min(0).max(10_000).optional(),
}).openapi('JoinWaitlistRequest');
export type JoinWaitlistInput = z.infer<typeof JoinWaitlistBody>;

export const WithdrawWaitlistBody = withCommandMeta({}).openapi('WithdrawWaitlistRequest');
export type WithdrawWaitlistInput = z.infer<typeof WithdrawWaitlistBody>;

/** Staff removal from a waitlist (SPK-REG-008 status `removed`): the reason is required and audited. */
export const RemoveWaitlistEntryBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RemoveWaitlistEntryRequest');
export type RemoveWaitlistEntryInput = z.infer<typeof RemoveWaitlistEntryBody>;

export const ListWaitlistQuery = z.object({
  offeringId: z.uuid(),
  poolId: z.uuid().optional(),
  status: WaitlistEntryStatusSchema.optional(),
});
export type ListWaitlistQuery = z.infer<typeof ListWaitlistQuery>;

export const AcceptWaitlistOfferBody = withCommandMeta({
  /** Household adult the follow-up basket belongs to; defaults to the acting customer (staff must name it). */
  ownerPersonId: z.uuid().optional(),
  payerPersonId: z.uuid().optional(),
}).openapi('AcceptWaitlistOfferRequest');
export type AcceptWaitlistOfferInput = z.infer<typeof AcceptWaitlistOfferBody>;

export const DeclineWaitlistOfferBody = withCommandMeta({}).openapi('DeclineWaitlistOfferRequest');
export type DeclineWaitlistOfferInput = z.infer<typeof DeclineWaitlistOfferBody>;

// ---------------------------------------------------------------------------------------------
// Placement (§4.4 PlacementRequest, SPK-PLACE-001..005)
// ---------------------------------------------------------------------------------------------

export const AvailabilityWindowSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .openapi('AvailabilityWindow');

export const PlacementReasonSchema = z
  .object({
    code: z.string(),
    severity: EligibilitySeveritySchema,
    message: z.string(),
    source: z.object({ type: z.string(), id: z.string().nullable() }),
  })
  .openapi('PlacementReason');
export type PlacementReason = z.infer<typeof PlacementReasonSchema>;

export const PlacementRequestSchema = z
  .object({
    id: z.uuid(),
    participantPersonId: z.uuid(),
    applicationId: z.uuid().nullable(),
    enrollmentId: z.uuid().nullable(),
    offeringId: z.uuid().nullable(),
    seasonId: z.uuid(),
    status: PlacementStatusSchema,
    availability: z.array(AvailabilityWindowSchema),
    preferredCompetitionId: z.uuid().nullable(),
    preferredDivisionId: z.uuid().nullable(),
    declaredLevel: z.string().nullable(),
    positionPreferences: z.array(z.string()),
    requestedTeammatePersonIds: z.array(z.uuid()),
    notes: z.string().nullable(),
    proposedTeamEntryId: z.uuid().nullable(),
    proposedAt: Instant.nullable(),
    proposalReasons: z.array(PlacementReasonSchema),
    assignedTeamEntryId: z.uuid().nullable(),
    assignedAt: Instant.nullable(),
    decidedByPersonId: z.uuid().nullable(),
    decisionReasons: z.array(PlacementReasonSchema),
    rosterMembershipRef: z.uuid().nullable(),
    lastOperationId: z.uuid().nullable(),
    releasedAt: Instant.nullable(),
    releaseReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PlacementRequest');
export type PlacementRequest = z.infer<typeof PlacementRequestSchema>;

export const CreatePlacementRequestBody = withCommandMeta({
  participantPersonId: z.uuid(),
  seasonId: z.uuid(),
  applicationId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  availability: z.array(AvailabilityWindowSchema).max(21).default([]),
  preferredCompetitionId: z.uuid().optional(),
  preferredDivisionId: z.uuid().optional(),
  declaredLevel: z.string().trim().min(1).max(100).optional(),
  positionPreferences: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  requestedTeammatePersonIds: z.array(z.uuid()).max(10).default([]),
  notes: Note.optional(),
}).openapi('CreatePlacementRequestRequest');
export type CreatePlacementRequestInput = z.infer<typeof CreatePlacementRequestBody>;

/** SPK-PLACE-002: a candidate team entry with explainable reasons; a recommendation reserves nothing. */
export const PlacementCandidateSchema = z
  .object({
    teamEntryId: z.uuid(),
    teamName: z.string(),
    divisionId: z.uuid().nullable(),
    eligible: z.boolean(),
    reasons: z.array(PlacementReasonSchema),
    capacity: z
      .object({ poolId: z.uuid(), available: z.number().int(), capacity: z.number().int() })
      .nullable(),
    requestedTeammatesOnRoster: z.number().int(),
    recommended: z.boolean(),
  })
  .openapi('PlacementCandidate');
export type PlacementCandidate = z.infer<typeof PlacementCandidateSchema>;

export const ProposePlacementBody = withCommandMeta({ teamEntryId: z.uuid() })
  .extend({ expectedRevision: Revision })
  .openapi('ProposePlacementRequest');
export type ProposePlacementInput = z.infer<typeof ProposePlacementBody>;

export const AssignPlacementBody = withCommandMeta({
  /** Defaults to the proposed team entry. */
  teamEntryId: z.uuid().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('AssignPlacementRequest');
export type AssignPlacementInput = z.infer<typeof AssignPlacementBody>;

export const RejectPlacementProposalBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RejectPlacementProposalRequest');
export type RejectPlacementProposalInput = z.infer<typeof RejectPlacementProposalBody>;

export const ReleasePlacementBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('ReleasePlacementRequest');
export type ReleasePlacementInput = z.infer<typeof ReleasePlacementBody>;

export const ListPlacementRequestsQuery = PageRequestSchema.extend({
  seasonId: z.uuid(),
  status: PlacementStatusSchema.optional(),
});
export type ListPlacementRequestsQuery = z.infer<typeof ListPlacementRequestsQuery>;

// ---------------------------------------------------------------------------------------------
// Session bookings (§4.4 SessionBooking, SPK-PLACE-004 pickup, SPK-YOUTH-003/004)
// ---------------------------------------------------------------------------------------------

export const SessionBookingSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    sessionId: z.uuid(),
    participantPersonId: z.uuid(),
    kind: SessionBookingKindSchema,
    status: SessionBookingStatusSchema,
    poolId: z.uuid().nullable(),
    holdId: z.uuid().nullable(),
    makeupEntitlementId: z.uuid().nullable(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    bookedBy: RegistrationActorSnapshotSchema,
    assistedByPersonId: z.uuid().nullable(),
    payerPersonId: z.uuid().nullable(),
    price: PriceSnapshotSchema.nullable(),
    policies: PolicyReferencesSchema,
    eligibility: EligibilityResultSchema.nullable(),
    expiresAt: Instant.nullable(),
    confirmedAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    expiredAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('SessionBooking');
export type SessionBooking = z.infer<typeof SessionBookingSchema>;

/**
 * Accepting an offer moves its reserved place into a held basket (offering waitlists) or a pending
 * session booking (session waitlists) that the customer completes (free) or pays (finance).
 */
export const WaitlistAcceptanceSchema = z
  .object({
    offer: WaitlistOfferSchema,
    entry: WaitlistEntrySchema,
    basket: BasketSchema.nullable(),
    sessionBooking: SessionBookingSchema.nullable(),
  })
  .openapi('WaitlistAcceptance');
export type WaitlistAcceptance = z.infer<typeof WaitlistAcceptanceSchema>;

/**
 * Books a seat in one session of a pickup offering (SPK-PLACE-004). Trials book through
 * `/trial-participations` (SPK-YOUTH-003) and makeups through `/makeup-entitlements/{id}/redeem`
 * (SPK-YOUTH-004), so each keeps its own record.
 */
export const CreateSessionBookingBody = withCommandMeta({
  offeringId: z.uuid(),
  sessionId: z.uuid(),
  participantPersonId: z.uuid(),
  payerPersonId: z.uuid().optional(),
}).openapi('CreateSessionBookingRequest');
export type CreateSessionBookingInput = z.infer<typeof CreateSessionBookingBody>;

export const ConfirmSessionBookingBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ConfirmSessionBookingRequest');
export type ConfirmSessionBookingInput = z.infer<typeof ConfirmSessionBookingBody>;

export const CancelSessionBookingBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('CancelSessionBookingRequest');
export type CancelSessionBookingInput = z.infer<typeof CancelSessionBookingBody>;

export const ListSessionBookingsQuery = z.object({
  sessionId: z.uuid().optional(),
  participantPersonId: z.uuid().optional(),
  status: SessionBookingStatusSchema.optional(),
});

export const ListMakeupEntitlementsQuery = z.object({ participantPersonId: z.uuid() });
export type ListMakeupEntitlementsQuery = z.infer<typeof ListMakeupEntitlementsQuery>;
export type ListSessionBookingsQuery = z.infer<typeof ListSessionBookingsQuery>;

// ---------------------------------------------------------------------------------------------
// Makeup entitlements (SPK-YOUTH-004, SPK-AT-020)
// ---------------------------------------------------------------------------------------------

export const MakeupRedemptionSchema = z
  .object({
    id: z.uuid(),
    sessionBookingId: z.uuid(),
    kind: z.enum(['redeem', 'reversal']),
    reversesRedemptionId: z.uuid().nullable(),
    redeemedAt: Instant,
  })
  .openapi('MakeupRedemption');

export const MakeupEntitlementSchema = z
  .object({
    id: z.uuid(),
    participantPersonId: z.uuid(),
    originatingEnrollmentId: z.uuid().nullable(),
    originatingSessionId: z.uuid().nullable(),
    originKind: MakeupOriginKindSchema,
    originReference: z.string().nullable(),
    eligibleOfferingIds: z.array(z.uuid()),
    eligibleProgramIds: z.array(z.uuid()),
    reason: z.string(),
    expiresAt: Instant,
    redemptionLimit: z.number().int(),
    redeemedCount: z.number().int(),
    status: MakeupEntitlementStatusSchema,
    redemptions: z.array(MakeupRedemptionSchema),
    revokedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('MakeupEntitlement');
export type MakeupEntitlement = z.infer<typeof MakeupEntitlementSchema>;

export const IssueMakeupBody = withCommandMeta({
  participantPersonId: z.uuid(),
  originKind: MakeupOriginKindSchema,
  originatingEnrollmentId: z.uuid().optional(),
  originatingSessionId: z.uuid().optional(),
  originReference: z.string().trim().max(200).optional(),
  eligibleOfferingIds: z.array(z.uuid()).max(50).default([]),
  eligibleProgramIds: z.array(z.uuid()).max(50).default([]),
  expiresAt: Instant,
  redemptionLimit: z.number().int().min(1).max(100).default(1),
})
  .extend({ reason: Reason })
  .refine((v) => v.eligibleOfferingIds.length + v.eligibleProgramIds.length > 0, {
    message: 'name at least one eligible replacement offering or program',
    path: ['eligibleOfferingIds'],
  })
  .openapi('IssueMakeupRequest');
export type IssueMakeupInput = z.infer<typeof IssueMakeupBody>;

export const RedeemMakeupBody = withCommandMeta({
  offeringId: z.uuid(),
  sessionId: z.uuid(),
}).openapi('RedeemMakeupRequest');
export type RedeemMakeupInput = z.infer<typeof RedeemMakeupBody>;

export const RevokeMakeupBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('RevokeMakeupRequest');
export type RevokeMakeupInput = z.infer<typeof RevokeMakeupBody>;

// ---------------------------------------------------------------------------------------------
// Trials (SPK-YOUTH-003, SPK-AT-019)
// ---------------------------------------------------------------------------------------------

export const TrialParticipationSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    sessionId: z.uuid().nullable(),
    sessionBookingId: z.uuid().nullable(),
    participantPersonId: z.uuid(),
    applicationId: z.uuid().nullable(),
    status: TrialParticipationStatusSchema,
    scheduledFor: Instant.nullable(),
    attendedAt: Instant.nullable(),
    /** SPK-AT-019: the no-show outcome, kept after conversion (as `attendedAt` is). */
    noShowAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    followUpConsent: z.boolean(),
    followUp: z.record(z.string(), z.unknown()),
    convertedEnrollmentId: z.uuid().nullable(),
    convertedBasketId: z.uuid().nullable(),
    convertedAt: Instant.nullable(),
    registeredBy: RegistrationActorSnapshotSchema,
    assistedByPersonId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('TrialParticipation');
export type TrialParticipation = z.infer<typeof TrialParticipationSchema>;

export const CreateTrialBody = withCommandMeta({
  offeringId: z.uuid(),
  participantPersonId: z.uuid(),
  /** The trial session; its seat is held in that session's own pool. */
  sessionId: z.uuid().optional(),
  /** SPK-YOUTH-003: may staff reuse this trial's information for a follow-up offer? */
  followUpConsent: z.boolean().default(false),
  payerPersonId: z.uuid().optional(),
}).openapi('CreateTrialRequest');
export type CreateTrialInput = z.infer<typeof CreateTrialBody>;

export const RecordTrialOutcomeBody = withCommandMeta({
  outcome: z.enum(['attended', 'no_show', 'canceled']),
})
  .extend({ expectedRevision: Revision })
  .openapi('RecordTrialOutcomeRequest');
export type RecordTrialOutcomeInput = z.infer<typeof RecordTrialOutcomeBody>;

/** SPK-YOUTH-003: a follow-up offer reuses permitted information; nothing is charged or enrolled here. */
export const ConvertTrialBody = withCommandMeta({
  targetOfferingId: z.uuid(),
  intent: RegistrationIntentSchema.default('youth'),
  payerPersonId: z.uuid().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('ConvertTrialRequest');
export type ConvertTrialInput = z.infer<typeof ConvertTrialBody>;

export const TrialConversionSchema = z
  .object({ trial: TrialParticipationSchema, basket: BasketSchema })
  .openapi('TrialConversion');
export type TrialConversion = z.infer<typeof TrialConversionSchema>;

// ---------------------------------------------------------------------------------------------
// Family calendar (SPK-YOUTH-007)
// ---------------------------------------------------------------------------------------------

export const FamilyCalendarQuery = z.object({ from: Instant, to: Instant });
export type FamilyCalendarQuery = z.infer<typeof FamilyCalendarQuery>;

export const FamilyCalendarItemSchema = z
  .object({
    id: z.string(),
    personId: z.uuid(),
    kind: z.enum(['enrollment_session', 'session_booking']),
    enrollmentId: z.uuid().nullable(),
    sessionBookingId: z.uuid().nullable(),
    offeringId: z.uuid(),
    sessionId: z.uuid().nullable(),
    title: z.string(),
    start: Instant,
    end: Instant,
    status: z.string(),
  })
  .openapi('FamilyCalendarItem');
export type FamilyCalendarItem = z.infer<typeof FamilyCalendarItemSchema>;

export const FamilyCalendarSchema = z
  .object({
    from: Instant,
    to: Instant,
    /** The acting person and every child they hold `view` over. */
    participantPersonIds: z.array(z.uuid()),
    items: z.array(FamilyCalendarItemSchema),
    /** Highlighted, never blocking (SPK-YOUTH-007). */
    overlaps: z.array(
      z.object({
        itemIds: z.tuple([z.string(), z.string()]),
        personIds: z.array(z.uuid()),
        start: Instant,
        end: Instant,
      }),
    ),
  })
  .openapi('FamilyCalendar');
export type FamilyCalendar = z.infer<typeof FamilyCalendarSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Enrollment';
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
      params: path.includes('{id}')
        ? path.includes('{lineId}')
          ? IdParams.extend({ lineId: z.uuid() })
          : IdParams
        : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied or participant authority required'),
      404: err('Not found or not visible (protected records never reveal existence)'),
      409: err(
        'Conflict (CAPACITY_UNAVAILABLE, DUPLICATE_ENTITLEMENT, RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)',
      ),
      422: err('Eligibility failed or acknowledgment missing'),
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
  '/applications',
  'Submit a registration application with explainable eligibility (SPK-REG-001/002)',
  CreateApplicationBody,
  ApplicationSchema,
);
query(
  '/applications',
  'List applications (staff review queue)',
  ListApplicationsQuery,
  pageSchema(ApplicationSchema),
);
query('/applications/{id}', 'Read an application', null, ApplicationSchema);
command(
  'post',
  '/applications/{id}/override-eligibility',
  'Override a failed eligibility evaluation with authority, reason and audit (SPK-REG-002)',
  OverrideEligibilityBody,
  ApplicationSchema,
  200,
);
command(
  'post',
  '/applications/{id}/accept',
  'Accept an application awaiting review (SPK-REG-007)',
  DecideApplicationBody,
  ApplicationSchema,
  200,
);
command(
  'post',
  '/applications/{id}/decline',
  'Decline an application awaiting review',
  DeclineApplicationBody,
  ApplicationSchema,
  200,
);
command(
  'post',
  '/applications/{id}/withdraw',
  'Withdraw an application',
  WithdrawApplicationBody,
  ApplicationSchema,
  200,
);

command(
  'post',
  '/baskets',
  'Open a household basket (SPK-REG-004)',
  CreateBasketBody,
  BasketSchema,
);
query('/baskets/{id}', 'Read a basket with its lines and holds', null, BasketSchema);
command(
  'post',
  '/baskets/{id}/lines',
  'Add a participant/offering line with its eligibility, price and policy basis',
  AddBasketLineBody,
  BasketSchema,
);
command(
  'post',
  '/baskets/{id}/lines/{lineId}/remove',
  'Remove a line from an open basket',
  RemoveBasketLineBody,
  BasketSchema,
  200,
);
command(
  'post',
  '/baskets/{id}/hold',
  'Acquire server-owned holds on every required capacity pool and create pending enrollments (SPK-REG-005/006)',
  HoldBasketBody,
  BasketSchema,
  200,
);
command(
  'post',
  '/baskets/{id}/release',
  'Release a held basket',
  ReleaseBasketBody,
  BasketSchema,
  200,
);
command(
  'post',
  '/baskets/{id}/complete',
  'Complete a basket that owes nothing (paid baskets finish through the finance checkout)',
  CompleteBasketBody,
  BasketSchema,
  200,
);

query(
  '/enrollments',
  'List enrollments of a participant or offering',
  ListEnrollmentsQuery,
  pageSchema(EnrollmentSchema),
);
query('/enrollments/{id}', 'Read an enrollment', null, EnrollmentSchema);
query(
  '/enrollments/{id}/cancellation-preview',
  'Preview a cancellation: participation, dates, capacity released, refund/credit/charge, approval (SPK-REG-010)',
  null,
  CancellationPreviewSchema,
);
command(
  'post',
  '/enrollments/{id}/cancel',
  'Cancel an enrollment under its cancellation policy (SPK-REG-010)',
  CancelEnrollmentBody,
  EnrollmentSchema,
  200,
);
command(
  'post',
  '/enrollments/{id}/complete',
  'Complete a confirmed enrollment (staff)',
  CompleteEnrollmentBody,
  EnrollmentSchema,
  200,
);
command(
  'post',
  '/enrollments/{id}/transfer',
  'Preview (commit=false) or commit a transfer: existing and proposed participation, dates, capacity, financial consequence, approval (§4.8, SPK-REG-010)',
  TransferEnrollmentBody,
  TransferPreviewSchema,
  200,
);

command(
  'post',
  '/waitlist-entries',
  'Join a waitlist (SPK-REG-008)',
  JoinWaitlistBody,
  WaitlistEntrySchema,
);
query(
  '/waitlist-entries',
  'List the waitlist of an offering (staff)',
  ListWaitlistQuery,
  z.array(WaitlistEntrySchema),
);
query(
  '/waitlist-entries/{id}',
  'Read a waitlist entry with its offer history',
  null,
  WaitlistEntrySchema,
);
command(
  'post',
  '/waitlist-entries/{id}/withdraw',
  'Leave a waitlist',
  WithdrawWaitlistBody,
  WaitlistEntrySchema,
  200,
);
command(
  'post',
  '/waitlist-entries/{id}/remove',
  'Remove an entry from a waitlist (staff, with a reason; an open offer is declined)',
  RemoveWaitlistEntryBody,
  WaitlistEntrySchema,
  200,
);
query('/waitlist-offers/{id}', 'Read a waitlist offer', null, WaitlistOfferSchema);
command(
  'post',
  '/waitlist-offers/{id}/accept',
  'Consume an eligible reserved offer once (§4.8, SPK-REG-008)',
  AcceptWaitlistOfferBody,
  WaitlistAcceptanceSchema,
  200,
);
command(
  'post',
  '/waitlist-offers/{id}/decline',
  'Decline an offer and release its place',
  DeclineWaitlistOfferBody,
  WaitlistOfferSchema,
  200,
);

command(
  'post',
  '/placement-requests',
  'Record approved placement information (SPK-PLACE-001)',
  CreatePlacementRequestBody,
  PlacementRequestSchema,
);
query(
  '/placement-requests',
  'List placement requests of a season (staff; never public, SPK-PLACE-005)',
  ListPlacementRequestsQuery,
  pageSchema(PlacementRequestSchema),
);
query('/placement-requests/{id}', 'Read a placement request', null, PlacementRequestSchema);
query(
  '/placement-requests/{id}/candidates',
  'Eligible candidate team entries with explainable reasons (SPK-PLACE-002); a recommendation reserves nothing',
  null,
  z.array(PlacementCandidateSchema),
);
command(
  'post',
  '/placement-requests/{id}/propose',
  'Propose a team entry (staff-reviewed placement)',
  ProposePlacementBody,
  PlacementRequestSchema,
  200,
);
command(
  'post',
  '/placement-requests/{id}/reject-proposal',
  'Reject a proposal and return the request to unassigned',
  RejectPlacementProposalBody,
  PlacementRequestSchema,
  200,
);
command(
  'post',
  '/placement-requests/{id}/assign',
  'Assign: checks capacity and current eligibility at commitment and adds the roster membership (SPK-PLACE-003)',
  AssignPlacementBody,
  PlacementRequestSchema,
  200,
);
command(
  'post',
  '/placement-requests/{id}/release',
  'Release a placement request',
  ReleasePlacementBody,
  PlacementRequestSchema,
  200,
);

command(
  'post',
  '/session-bookings',
  'Book a pickup session seat with its own capacity, entry requirements and waitlist (SPK-PLACE-004)',
  CreateSessionBookingBody,
  SessionBookingSchema,
);
query(
  '/session-bookings',
  'List session bookings',
  ListSessionBookingsQuery,
  z.array(SessionBookingSchema),
);
query('/session-bookings/{id}', 'Read a session booking', null, SessionBookingSchema);
command(
  'post',
  '/session-bookings/{id}/confirm',
  'Confirm a pending booking that owes nothing',
  ConfirmSessionBookingBody,
  SessionBookingSchema,
  200,
);
command(
  'post',
  '/session-bookings/{id}/cancel',
  'Cancel a booking and release its seat',
  CancelSessionBookingBody,
  SessionBookingSchema,
  200,
);

command(
  'post',
  '/makeup-entitlements',
  'Issue a makeup entitlement (SPK-YOUTH-004)',
  IssueMakeupBody,
  MakeupEntitlementSchema,
);
query(
  '/makeup-entitlements',
  'List the makeup entitlements of a participant',
  ListMakeupEntitlementsQuery,
  z.array(MakeupEntitlementSchema),
);
query(
  '/makeup-entitlements/{id}',
  'Read a makeup entitlement with its redemption history',
  null,
  MakeupEntitlementSchema,
);
command(
  'post',
  '/makeup-entitlements/{id}/redeem',
  'Redeem a makeup into a session booking; the database enforces the limit (SPK-AT-020)',
  RedeemMakeupBody,
  SessionBookingSchema,
);
command(
  'post',
  '/makeup-entitlements/{id}/revoke',
  'Revoke a makeup entitlement',
  RevokeMakeupBody,
  MakeupEntitlementSchema,
  200,
);

command(
  'post',
  '/trial-participations',
  'Record a trial participation, distinct from enrollment (SPK-YOUTH-003)',
  CreateTrialBody,
  TrialParticipationSchema,
);
query('/trial-participations/{id}', 'Read a trial participation', null, TrialParticipationSchema);
command(
  'post',
  '/trial-participations/{id}/outcome',
  'Record the trial outcome',
  RecordTrialOutcomeBody,
  TrialParticipationSchema,
  200,
);
command(
  'post',
  '/trial-participations/{id}/convert',
  'Open a follow-up basket for term participation without charging or enrolling (SPK-AT-019)',
  ConvertTrialBody,
  TrialConversionSchema,
);

command(
  'post',
  '/capacity-pools',
  'Create a capacity pool for a scope (staff)',
  CreateCapacityPoolBody,
  CapacityPoolSchema,
);
query(
  '/capacity-pools',
  'List capacity pools',
  ListCapacityPoolsQuery,
  z.array(CapacityPoolSchema),
);
command(
  'post',
  '/capacity-pools/{id}/adjust',
  'Adjust capacity or staffing with a reason (SPK-YOUTH-002)',
  AdjustCapacityPoolBody,
  CapacityPoolSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/capacity-pools/sync',
  'Create or resize the pools of an offering from its catalog capacity units',
  SyncOfferingPoolsBody,
  z.array(CapacityPoolSchema),
  200,
);

query(
  '/me/family-calendar',
  'All authorized children in one calendar with highlighted overlaps (SPK-YOUTH-007)',
  FamilyCalendarQuery,
  FamilyCalendarSchema,
);
