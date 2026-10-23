import {
  CapacityUnitSchema,
  defineEvent,
  OfferingKindSchema,
  PolicyKindSchema,
  PublicationStateSchema,
  z,
} from '@sportspark/contracts';

/**
 * Catalog domain events (§4.12). Payloads carry identifiers and configuration only — never
 * participant names or dates of birth (§4.14). Enrollment, finance and communications subscribe.
 */
const OfferingRef = {
  offeringId: z.uuid(),
  programId: z.uuid(),
  facilityId: z.uuid(),
  kind: OfferingKindSchema,
};

export const CatalogEvents = {
  programCreated: defineEvent(
    'catalog.program_created',
    z.object({ programId: z.uuid(), activityType: z.string(), status: z.string() }),
  ),
  programUpdated: defineEvent(
    'catalog.program_updated',
    z.object({ programId: z.uuid(), revision: z.number().int(), status: z.string() }),
  ),
  offeringCreated: defineEvent('catalog.offering_created', z.object({ ...OfferingRef })),
  offeringUpdated: defineEvent(
    'catalog.offering_updated',
    z.object({
      ...OfferingRef,
      revision: z.number().int(),
      publicationState: PublicationStateSchema,
      /** SPK-YOUTH-002: capacity changes carry the staffing requirement before and after. */
      capacityChange: z
        .object({
          before: z.array(CapacityUnitSchema),
          after: z.array(CapacityUnitSchema),
          requiredStaffBefore: z.number().int(),
          requiredStaffAfter: z.number().int(),
          reason: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  offeringPublished: defineEvent(
    'catalog.offering_published',
    z.object({
      ...OfferingRef,
      revision: z.number().int(),
      registrationOpensAt: z.string(),
      registrationClosesAt: z.string(),
    }),
  ),
  /** Registration opening is distinct from publication (SPK-CAT-004). */
  registrationOpened: defineEvent(
    'catalog.registration_opened',
    z.object({ ...OfferingRef, revision: z.number().int(), resumed: z.boolean() }),
  ),
  /** Pausing preserves existing participation; enrollment stops accepting new intents only. */
  registrationPaused: defineEvent(
    'catalog.registration_paused',
    z.object({ ...OfferingRef, revision: z.number().int(), reason: z.string().nullable() }),
  ),
  offeringClosed: defineEvent(
    'catalog.offering_closed',
    z.object({ ...OfferingRef, revision: z.number().int(), reason: z.string().nullable() }),
  ),
  offeringArchived: defineEvent(
    'catalog.offering_archived',
    z.object({ ...OfferingRef, revision: z.number().int() }),
  ),
  offeringCopied: defineEvent(
    'catalog.offering_copied',
    z.object({
      ...OfferingRef,
      sourceOfferingId: z.uuid(),
      copiedSessionIds: z.array(z.uuid()),
    }),
  ),
  sessionCreated: defineEvent(
    'catalog.session_created',
    z.object({
      sessionId: z.uuid(),
      offeringId: z.uuid(),
      sequence: z.number().int(),
      scheduledStart: z.string(),
      scheduledEnd: z.string(),
      schedulingEventId: z.uuid().nullable(),
    }),
  ),
  sessionCanceled: defineEvent(
    'catalog.session_canceled',
    z.object({
      sessionId: z.uuid(),
      offeringId: z.uuid(),
      sequence: z.number().int(),
      schedulingEventId: z.uuid().nullable(),
      reason: z.string(),
    }),
  ),
  policyVersionCreated: defineEvent(
    'catalog.policy_version_created',
    z.object({
      policyVersionId: z.uuid(),
      kind: PolicyKindSchema,
      key: z.string(),
      version: z.number().int(),
    }),
  ),
  policyVersionApproved: defineEvent(
    'catalog.policy_version_approved',
    z.object({
      policyVersionId: z.uuid(),
      approvalId: z.uuid(),
      kind: PolicyKindSchema,
      key: z.string(),
      version: z.number().int(),
      effectiveFrom: z.string(),
      effectiveTo: z.string().nullable(),
    }),
  ),
  policyVersionRetired: defineEvent(
    'catalog.policy_version_retired',
    z.object({
      policyVersionId: z.uuid(),
      kind: PolicyKindSchema,
      key: z.string(),
      version: z.number().int(),
      reason: z.string(),
    }),
  ),
  acknowledgmentRecorded: defineEvent(
    'catalog.acknowledgment_recorded',
    z.object({
      acknowledgmentId: z.uuid(),
      subjectPersonId: z.uuid(),
      policyVersionId: z.uuid(),
      signedByPersonId: z.uuid(),
      basis: z.enum(['self', 'guardian']),
      assistedByStaff: z.boolean(),
    }),
  ),
  acknowledgmentWithdrawn: defineEvent(
    'catalog.acknowledgment_withdrawn',
    z.object({
      acknowledgmentId: z.uuid(),
      subjectPersonId: z.uuid(),
      policyVersionId: z.uuid(),
      reason: z.string(),
    }),
  ),
  priceRuleCreated: defineEvent(
    'catalog.price_rule_created',
    z.object({
      priceRuleId: z.uuid(),
      offeringId: z.uuid(),
      version: z.number().int(),
      effectiveFrom: z.string(),
      effectiveTo: z.string().nullable(),
      basePriceMinor: z.number().int(),
      currency: z.string(),
      supersededPriceRuleId: z.uuid().nullable(),
    }),
  ),
  discountCreated: defineEvent(
    'catalog.discount_created',
    z.object({ discountDefinitionId: z.uuid(), code: z.string().nullable(), status: z.string() }),
  ),
  discountUpdated: defineEvent(
    'catalog.discount_updated',
    z.object({ discountDefinitionId: z.uuid(), revision: z.number().int(), status: z.string() }),
  ),
  discountRetired: defineEvent(
    'catalog.discount_retired',
    z.object({ discountDefinitionId: z.uuid(), reason: z.string() }),
  ),
  discountRedeemed: defineEvent(
    'catalog.discount_redeemed',
    z.object({
      discountDefinitionId: z.uuid(),
      referenceType: z.string(),
      referenceId: z.uuid(),
      redeemedCount: z.number().int(),
      redemptionLimit: z.number().int().nullable(),
    }),
  ),
  discountReleased: defineEvent(
    'catalog.discount_released',
    z.object({
      discountDefinitionId: z.uuid(),
      referenceType: z.string(),
      referenceId: z.uuid(),
      redeemedCount: z.number().int(),
    }),
  ),
} as const;
