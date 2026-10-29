import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';

/**
 * Catalog module API contract (specification §3.2 SPK-CAT-001..004, §3.15 SPK-PAY-001..003,
 * §4.4 Catalog + Policies, SPK-REG-002, SPK-REG-009, SPK-YOUTH-001/002, §4.8).
 * Organization scope always comes from the authenticated principal; public discovery names the
 * organization by slug because an anonymous principal has none.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the database check constraints in migration 0200)
// ---------------------------------------------------------------------------------------------
export const ProgramStatusSchema = z.enum(['draft', 'active', 'archived']).openapi('ProgramStatus');
export type ProgramStatus = z.infer<typeof ProgramStatusSchema>;

/** CAT-03 (§5.3, §5.4): who created the program; only the migration import writes `import`. */
export const ProgramSourceSchema = z.enum(['staff', 'import']).openapi('ProgramSource');
export type ProgramSource = z.infer<typeof ProgramSourceSchema>;

/**
 * SPK-CAT-002 offering kinds. Rentals, parties, packages, memberships and pickup sessions are
 * conditional capabilities (§3.16, §6.5 Package G): creating, copying or publishing one needs the
 * organization's capability switch (DEC-016; CAT-02). Each party package is its own `party`
 * offering grouped under a program.
 */
export const OfferingKindSchema = z
  .enum([
    'season',
    'term',
    'camp',
    'session',
    'trial',
    'makeup',
    'pickup',
    'private_coaching',
    'rental',
    'package',
    'membership',
    'party',
  ])
  .openapi('OfferingKind');
export type OfferingKind = z.infer<typeof OfferingKindSchema>;

export const PublicationStateSchema = z
  .enum(['draft', 'published', 'registration_open', 'registration_paused', 'closed', 'archived'])
  .openapi('PublicationState');
export type PublicationState = z.infer<typeof PublicationStateSchema>;

/** States visible to the public catalog (SPK-CAT-004: publication is distinct from registration). */
export const PUBLIC_PUBLICATION_STATES: readonly PublicationState[] = [
  'published',
  'registration_open',
  'registration_paused',
];

export const OfferingSessionStatusSchema = z
  .enum(['scheduled', 'canceled', 'completed'])
  .openapi('OfferingSessionStatus');
export type OfferingSessionStatus = z.infer<typeof OfferingSessionStatusSchema>;

export const CapacityUnitKindSchema = z
  .enum([
    'team_entries',
    'roster_places',
    'seats',
    'session_seats',
    'camp_group_places',
    'rental_resources',
  ])
  .openapi('CapacityUnitKind');
export type CapacityUnitKind = z.infer<typeof CapacityUnitKindSchema>;

export const EntitlementKindSchema = z
  .enum([
    'team_entry',
    'roster_place',
    'seat',
    'session_seat',
    'camp_group_place',
    'rental_resource',
    'package_credits',
    'membership_benefit',
    'party_package',
  ])
  .openapi('EntitlementKind');
export type EntitlementKind = z.infer<typeof EntitlementKindSchema>;

export const EquivalenceScopeSchema = z
  .enum(['offering', 'program', 'program_period', 'session', 'none'])
  .openapi('EquivalenceScope');
export type EquivalenceScope = z.infer<typeof EquivalenceScopeSchema>;

export const PolicyKindSchema = z
  .enum([
    'eligibility',
    'cancellation',
    'refund',
    'discount',
    'waitlist',
    'hold',
    'approval',
    'form',
    'overpayment',
    'installment',
    'booking_terms',
    'tax_fee',
  ])
  .openapi('PolicyKind');
export type PolicyKind = z.infer<typeof PolicyKindSchema>;

export const PolicyApprovalStatusSchema = z
  .enum(['draft', 'approved', 'retired'])
  .openapi('PolicyApprovalStatus');
export type PolicyApprovalStatus = z.infer<typeof PolicyApprovalStatusSchema>;

export const AcknowledgmentBasisSchema = z
  .enum(['self', 'guardian'])
  .openapi('AcknowledgmentBasis');
export const AcknowledgmentStatusSchema = z
  .enum(['active', 'withdrawn'])
  .openapi('AcknowledgmentStatus');

export const DiscountKindSchema = z.enum(['promo_code', 'automatic']).openapi('DiscountKind');
export const DiscountAmountKindSchema = z
  .enum(['percentage', 'fixed'])
  .openapi('DiscountAmountKind');
export const StackingRuleSchema = z.enum(['exclusive', 'stackable']).openapi('StackingRule');
export const RoundingModeSchema = z
  .enum(['half_up', 'half_even', 'down', 'up'])
  .openapi('RoundingMode');
export type RoundingMode = z.infer<typeof RoundingModeSchema>;
export const AllocationMethodSchema = z
  .enum(['proportional', 'largest_first', 'first_line', 'even'])
  .openapi('AllocationMethod');
export type AllocationMethod = z.infer<typeof AllocationMethodSchema>;
export const DiscountStatusSchema = z
  .enum(['draft', 'active', 'retired'])
  .openapi('DiscountStatus');
export type DiscountStatus = z.infer<typeof DiscountStatusSchema>;

export const CatalogDateOnly = z.iso.date();
const Name = z.string().trim().min(1).max(200);
const Description = z.string().trim().max(4000);
const Reason = z.string().trim().min(1).max(2000);
const PolicyKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, 'lowercase letters, digits, "-" and "_" only');

// ---------------------------------------------------------------------------------------------
// Shared value objects
// ---------------------------------------------------------------------------------------------

/** SPK-YOUTH-001 age band; eligibility is evaluated from dates of birth against the reference date (§4.5). */
export const AgeBandSchema = z
  .object({
    minAgeYears: z.number().int().min(0).max(120).optional(),
    maxAgeYears: z.number().int().min(0).max(120).optional(),
  })
  .refine(
    (v) =>
      v.minAgeYears === undefined || v.maxAgeYears === undefined || v.minAgeYears <= v.maxAgeYears,
    { message: 'minAgeYears must not exceed maxAgeYears', path: ['maxAgeYears'] },
  )
  .openapi('AgeBand');
export type AgeBand = z.infer<typeof AgeBandSchema>;

/** SPK-REG-005 capacity units; SPK-YOUTH-002 staffing ratio and group size travel with the limit. */
export const CapacityUnitSchema = z
  .object({
    unit: CapacityUnitKindSchema,
    limit: z.number().int().min(0).max(1_000_000),
    groupSize: z.number().int().min(1).max(10_000).optional(),
    staffingRatio: z
      .object({ participantsPerStaff: z.number().int().min(1).max(10_000) })
      .optional(),
  })
  .openapi('CapacityUnit');
export type CapacityUnit = z.infer<typeof CapacityUnitSchema>;

export const CapacityUnitsSchema = z
  .array(CapacityUnitSchema)
  .max(6)
  .refine((units) => new Set(units.map((u) => u.unit)).size === units.length, {
    message: 'each capacity unit may appear once',
  });

/** Public (child-safe) capacity: the unit and its limit, never staffing or group internals. */
export const PublicCapacitySchema = z
  .object({ unit: CapacityUnitKindSchema, limit: z.number().int() })
  .openapi('PublicCapacity');

export const OfferingLocationSchema = z
  .object({
    label: z.string().trim().max(200).optional(),
    /** Scheduling resources (no cross-module key; validated by the scheduling module when sessions are scheduled). */
    resourceIds: z.array(z.uuid()).max(50).optional(),
  })
  .openapi('OfferingLocation');
export type OfferingLocation = z.infer<typeof OfferingLocationSchema>;

/** Approved taxes and fees on a price rule (SPK-PAY-002). Exactly one of basisPoints / amountMinor. */
export const ChargeLineSchema = z
  .object({
    code: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(200),
    kind: z.enum(['tax', 'fee']),
    basisPoints: z.number().int().min(0).max(100_000).optional(),
    amountMinor: z.number().int().min(0).safe().optional(),
    /** Included in the displayed base price (true) or added on top (false). */
    inclusive: z.boolean().default(false),
  })
  .refine((v) => (v.basisPoints === undefined) !== (v.amountMinor === undefined), {
    message: 'provide exactly one of basisPoints or amountMinor',
    path: ['basisPoints'],
  })
  .openapi('ChargeLine');
export type ChargeLine = z.infer<typeof ChargeLineSchema>;

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------
export const ProgramSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    activityType: z.string(),
    format: z.string().nullable(),
    ageBand: AgeBandSchema,
    status: ProgramStatusSchema,
    /** CAT-03: `import` when the migration import created it (program reads are staff-only). */
    source: ProgramSourceSchema,
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Program');
export type Program = z.infer<typeof ProgramSchema>;

export const CreateProgramBody = withCommandMeta({
  name: Name,
  description: Description.optional(),
  activityType: z.string().trim().min(1).max(100),
  format: z.string().trim().min(1).max(100).optional(),
  ageBand: AgeBandSchema.default({}),
  status: z.enum(['draft', 'active']).default('draft'),
}).openapi('CreateProgramRequest');
export type CreateProgramInput = z.infer<typeof CreateProgramBody>;

export const UpdateProgramBody = withCommandMeta({
  name: Name.optional(),
  description: Description.nullable().optional(),
  activityType: z.string().trim().min(1).max(100).optional(),
  format: z.string().trim().min(1).max(100).nullable().optional(),
  ageBand: AgeBandSchema.optional(),
  status: ProgramStatusSchema.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateProgramRequest');
export type UpdateProgramInput = z.infer<typeof UpdateProgramBody>;

export const ListProgramsQuery = PageRequestSchema.extend({
  status: ProgramStatusSchema.optional(),
  activityType: z.string().trim().min(1).max(100).optional(),
});
export type ListProgramsQuery = z.infer<typeof ListProgramsQuery>;

// ---------------------------------------------------------------------------------------------
// Typed entitlement scopes (CAT-02; §3.16, SPK-COND-001 to SPK-COND-003)
//
// Every key is required and nothing has a default: a definition states each effect explicitly
// (POL-038, POL-039, POL-040 hold the values; the catalog invents none). The catalog validates the
// scope of these kinds on create and update, and migration 0205 makes the database refuse a row
// that omits a required key. Other kinds keep a free-form scope.
// ---------------------------------------------------------------------------------------------

/** Workforce role and qualification identifiers are lower-case slugs (mirrors workforce). */
const StaffingSlug = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a lower-case slug (letters, digits, underscore)');

const offeringOrProgramIds = () =>
  z
    .strictObject({
      offeringIds: z.array(z.uuid()).max(100).optional(),
      programIds: z.array(z.uuid()).max(100).optional(),
    })
    .refine((v) => (v.offeringIds?.length ?? 0) > 0 || (v.programIds?.length ?? 0) > 0, {
      message: 'name at least one offering or program',
    });

/** Which offerings or programs a membership benefit or package credit applies to (one non-empty). */
export const EntitlementAppliesToSchema = offeringOrProgramIds().openapi('EntitlementAppliesTo');
export type EntitlementAppliesTo = z.infer<typeof EntitlementAppliesToSchema>;

/** SPK-COND-001: how many sessions a membership includes, per period (no default period). */
export const IncludedSessionsLimitSchema = z
  .strictObject({
    count: z.number().int().min(1).max(10_000),
    period: z.enum(['week', 'month', 'membership_term']),
    /** ISO weekday the week starts on (1 = Monday … 7 = Sunday); required for `week` only. */
    weekStartsOn: z.number().int().min(1).max(7).optional(),
  })
  .refine((v) => (v.period === 'week') === (v.weekStartsOn !== undefined), {
    message: 'weekStartsOn is required for a weekly limit and only for it',
    path: ['weekStartsOn'],
  })
  .openapi('IncludedSessionsLimit');

/**
 * SPK-COND-001 "membership must not automatically imply unlimited attendance unless its specific
 * entitlement says so": the attendance effect is always stated, and `unlimited` only when chosen.
 */
export const MembershipAttendanceSchema = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({
      mode: z.literal('included_sessions'),
      appliesTo: EntitlementAppliesToSchema,
      limit: IncludedSessionsLimitSchema,
    }),
    z.strictObject({ mode: z.literal('unlimited'), appliesTo: EntitlementAppliesToSchema }),
  ])
  .openapi('MembershipAttendance');

export const MembershipTermSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('offering_dates') }),
    z.strictObject({
      kind: z.literal('from_confirmation'),
      lengthDays: z.number().int().min(1).max(3660),
    }),
  ])
  .openapi('MembershipTerm');

export const MembershipBenefitScopeSchema = z
  .strictObject({
    attendance: MembershipAttendanceSchema,
    term: MembershipTermSchema,
    /** Days before the term ends that the renewal notice goes out; null sends none (POL-038). */
    renewal: z.strictObject({ noticeLeadDays: z.number().int().min(1).max(365).nullable() }),
  })
  .openapi('MembershipBenefitScope');
export type MembershipBenefitScope = z.infer<typeof MembershipBenefitScopeSchema>;

/** SPK-COND-002: a package states its expiry choice; `none` is a choice, never a default. */
export const PackageCreditsExpirySchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('days_after_issue'),
      days: z.number().int().min(1).max(3650),
    }),
    z.strictObject({ kind: z.literal('fixed_date'), date: CatalogDateOnly }),
  ])
  .openapi('PackageCreditsExpiry');

export const PackageCreditsScopeSchema = z
  .strictObject({
    credits: z.number().int().min(1).max(1000),
    appliesTo: EntitlementAppliesToSchema,
    expiry: PackageCreditsExpirySchema,
  })
  .openapi('PackageCreditsScope');
export type PackageCreditsScope = z.infer<typeof PackageCreditsScopeSchema>;

/** SPK-COND-003: `count` of the listed scheduling resources are reserved together. */
export const ScopeResourceRequirementSchema = z
  .strictObject({
    resourceIds: z.array(z.uuid()).min(1).max(50),
    count: z.number().int().min(1).max(50),
  })
  .refine((v) => new Set(v.resourceIds).size === v.resourceIds.length, {
    message: 'each resource may appear once',
    path: ['resourceIds'],
  })
  .refine((v) => v.count <= v.resourceIds.length, {
    message: 'count cannot exceed the number of listed resources',
    path: ['count'],
  })
  .openapi('ScopeResourceRequirement');

/** SPK-COND-003: mandatory staff a booking reserves with its resources (workforce roles). */
export const ScopeStaffingRequirementSchema = z
  .strictObject({
    kind: z.enum(['supervisor', 'organizer']),
    role: StaffingSlug,
    count: z.number().int().min(1).max(100),
    qualifications: z.array(StaffingSlug).max(20),
  })
  .openapi('ScopeStaffingRequirement');

/** SPK-COND-003: a party package; the staffing list may be empty but is always stated. */
export const PartyPackageScopeSchema = z
  .strictObject({
    durationMinutes: z.number().int().min(1).max(1440),
    guestLimit: z.number().int().min(1).max(10_000),
    resources: ScopeResourceRequirementSchema,
    staffing: z.array(ScopeStaffingRequirementSchema).max(20),
    /** Facilities assets reserved with the party (may be empty). */
    equipmentAssetIds: z.array(z.uuid()).max(100),
  })
  .openapi('PartyPackageScope');
export type PartyPackageScope = z.infer<typeof PartyPackageScopeSchema>;

/** SPK-COND-003: a rental names the resources it reserves and its staffing (may be empty). */
export const RentalResourceScopeSchema = z
  .strictObject({
    resources: ScopeResourceRequirementSchema,
    staffing: z.array(ScopeStaffingRequirementSchema).max(20),
  })
  .openapi('RentalResourceScope');
export type RentalResourceScope = z.infer<typeof RentalResourceScopeSchema>;

/** The entitlement kinds whose scope is typed, and the schema each must satisfy (CAT-02). */
export const ENTITLEMENT_SCOPE_SCHEMAS = {
  membership_benefit: MembershipBenefitScopeSchema,
  package_credits: PackageCreditsScopeSchema,
  party_package: PartyPackageScopeSchema,
  rental_resource: RentalResourceScopeSchema,
} as const satisfies Partial<Record<EntitlementKind, z.ZodType>>;
export type TypedEntitlementKind = keyof typeof ENTITLEMENT_SCOPE_SCHEMAS;

// ---------------------------------------------------------------------------------------------
// Entitlement definitions
// ---------------------------------------------------------------------------------------------
export const EntitlementDefinitionSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    kind: EntitlementKindSchema,
    scope: z.record(z.string(), z.unknown()),
    equivalenceScope: EquivalenceScopeSchema,
    equivalenceRule: z.record(z.string(), z.unknown()),
    status: z.enum(['active', 'archived']),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('EntitlementDefinition');
export type EntitlementDefinition = z.infer<typeof EntitlementDefinitionSchema>;

export const CreateEntitlementDefinitionBody = withCommandMeta({
  name: Name,
  description: Description.optional(),
  kind: EntitlementKindSchema,
  scope: z.record(z.string(), z.unknown()).default({}),
  equivalenceScope: EquivalenceScopeSchema,
  equivalenceRule: z.record(z.string(), z.unknown()).default({}),
}).openapi('CreateEntitlementDefinitionRequest');
export type CreateEntitlementDefinitionInput = z.infer<typeof CreateEntitlementDefinitionBody>;

export const UpdateEntitlementDefinitionBody = withCommandMeta({
  name: Name.optional(),
  description: Description.nullable().optional(),
  scope: z.record(z.string(), z.unknown()).optional(),
  equivalenceScope: EquivalenceScopeSchema.optional(),
  equivalenceRule: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['active', 'archived']).optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateEntitlementDefinitionRequest');
export type UpdateEntitlementDefinitionInput = z.infer<typeof UpdateEntitlementDefinitionBody>;

// ---------------------------------------------------------------------------------------------
// Policy versions, approvals and acknowledgments
// ---------------------------------------------------------------------------------------------
export const PolicyVersionSchema = z
  .object({
    id: z.uuid(),
    kind: PolicyKindSchema,
    key: z.string(),
    version: z.number().int(),
    title: z.string(),
    content: z.record(z.string(), z.unknown()),
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    approvalStatus: PolicyApprovalStatusSchema,
    approvedAt: Instant.nullable(),
    retiredAt: Instant.nullable(),
    retiredReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PolicyVersion');
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const CreatePolicyVersionBody = withCommandMeta({
  kind: PolicyKindSchema,
  key: PolicyKey,
  title: Name,
  content: z.record(z.string(), z.unknown()),
  effectiveFrom: Instant,
  effectiveTo: Instant.optional(),
})
  .refine(
    (v) => v.effectiveTo === undefined || new Date(v.effectiveTo) > new Date(v.effectiveFrom),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  )
  .openapi('CreatePolicyVersionRequest');
export type CreatePolicyVersionInput = z.infer<typeof CreatePolicyVersionBody>;

export const ApprovePolicyVersionBody = withCommandMeta({}).openapi('ApprovePolicyVersionRequest');
export type ApprovePolicyVersionInput = z.infer<typeof ApprovePolicyVersionBody>;

export const RetirePolicyVersionBody = withCommandMeta({ effectiveTo: Instant.optional() })
  .extend({ reason: Reason })
  .openapi('RetirePolicyVersionRequest');
export type RetirePolicyVersionInput = z.infer<typeof RetirePolicyVersionBody>;

export const ListPolicyVersionsQuery = PageRequestSchema.extend({
  kind: PolicyKindSchema.optional(),
  key: PolicyKey.optional(),
  approvalStatus: PolicyApprovalStatusSchema.optional(),
});
export type ListPolicyVersionsQuery = z.infer<typeof ListPolicyVersionsQuery>;

/**
 * CAT-02: content of a `booking_terms` version (rental and party offerings; POL-040, POL-005).
 * Approved by the finance operator because it decides money. The deposit is the first installment
 * of the named approved installment policy; null charges in full at checkout. Absent setup or
 * cleanup minutes fall back to the reserved resources' own buffers.
 */
export const BookingTermsContentSchema = z
  .strictObject({
    confirmationMode: z.enum(['instant', 'request']),
    installmentPolicyKey: PolicyKey.nullable(),
    setupMinutes: z.number().int().min(0).max(1440).optional(),
    cleanupMinutes: z.number().int().min(0).max(1440).optional(),
    accessConditions: z.string().trim().min(1).max(4000).nullable(),
    hostResponsibilities: z.string().trim().min(1).max(4000).nullable(),
  })
  .openapi('BookingTermsContent');
export type BookingTermsContent = z.infer<typeof BookingTermsContentSchema>;

/**
 * CAT-02: content of a `tax_fee` version (DEC-057 approved taxes, DEC-007 rounding): a rate in
 * basis points, or a fixed amount with its currency, exactly one of them. No rate is assumed.
 */
export const TaxFeeContentSchema = z
  .strictObject({
    code: z.string().trim().min(1).max(50),
    label: z.string().trim().min(1).max(200),
    kind: z.enum(['tax', 'fee']),
    rateBasisPoints: z.number().int().min(0).max(100_000).optional(),
    amountMinor: z.number().int().min(0).safe().optional(),
    currency: CurrencyCode.optional(),
    rounding: z.enum(['half_up', 'half_even', 'down']),
  })
  .refine(
    (v) =>
      v.rateBasisPoints !== undefined
        ? v.amountMinor === undefined && v.currency === undefined
        : v.amountMinor !== undefined && v.currency !== undefined,
    {
      message: 'provide exactly one of rateBasisPoints or amountMinor with its currency',
      path: ['rateBasisPoints'],
    },
  )
  .openapi('TaxFeeContent');
export type TaxFeeContent = z.infer<typeof TaxFeeContentSchema>;

/** Eligibility content may require an active membership in these offerings or programs (ENR-12). */
export const MembershipRequirementSchema = offeringOrProgramIds().openapi('MembershipRequirement');

/** Cancellation content may return a redeemed package credit until this many minutes before start (ENR-11). */
export const PackageCreditReturnSchema = z
  .strictObject({ untilMinutesBeforeStart: z.number().int().min(0).max(525_600) })
  .openapi('PackageCreditReturn');

/**
 * Content rules per policy kind (CAT-02), checked when a version is drafted. Booking terms and
 * taxes or fees are closed shapes; eligibility and cancellation content stays open and only its
 * Package G keys are checked when present. Other kinds keep free-form content.
 */
export const POLICY_CONTENT_SCHEMAS = {
  booking_terms: BookingTermsContentSchema,
  tax_fee: TaxFeeContentSchema,
  eligibility: z.looseObject({ membershipRequired: MembershipRequirementSchema.optional() }),
  cancellation: z.looseObject({ packageCreditReturn: PackageCreditReturnSchema.optional() }),
} as const satisfies Partial<Record<PolicyKind, z.ZodType>>;

export const ApprovalSchema = z
  .object({
    id: z.uuid(),
    subjectType: z.enum(['policy_version', 'offering_publication']),
    subjectId: z.uuid(),
    decision: z.enum(['approved', 'rejected']),
    actorPersonId: z.uuid().nullable(),
    reason: z.string().nullable(),
    occurredAt: Instant,
  })
  .openapi('Approval');
export type Approval = z.infer<typeof ApprovalSchema>;

export const AcknowledgmentSchema = z
  .object({
    id: z.uuid(),
    subjectPersonId: z.uuid(),
    policyVersionId: z.uuid(),
    signedByPersonId: z.uuid(),
    basis: AcknowledgmentBasisSchema,
    /** Present when a staff actor assisted (SPK-REG-009); never the signer. */
    recordedByPersonId: z.uuid().nullable(),
    recordedByKind: z.enum(['customer', 'staff', 'system']),
    signedAt: Instant,
    evidence: z.record(z.string(), z.unknown()),
    status: AcknowledgmentStatusSchema,
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Acknowledgment');
export type Acknowledgment = z.infer<typeof AcknowledgmentSchema>;

export const RecordAcknowledgmentBody = withCommandMeta({
  subjectPersonId: z.uuid(),
  policyVersionId: z.uuid(),
  /** Required when a staff actor records the acknowledgment; defaults to the acting customer. */
  signedByPersonId: z.uuid().optional(),
  /**
   * Staff only (SPK-REG-009): when a paper form signed earlier is entered later. Never in the
   * future, never before the policy version, and only with `evidence`; a customer's signature is
   * timestamped by the server.
   */
  signedAt: Instant.optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
}).openapi('RecordAcknowledgmentRequest');
export type RecordAcknowledgmentInput = z.infer<typeof RecordAcknowledgmentBody>;

export const WithdrawAcknowledgmentBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('WithdrawAcknowledgmentRequest');
export type WithdrawAcknowledgmentInput = z.infer<typeof WithdrawAcknowledgmentBody>;

export const ListAcknowledgmentsQuery = z.object({
  subjectPersonId: z.uuid(),
  policyVersionId: z.uuid().optional(),
  includeWithdrawn: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type ListAcknowledgmentsQuery = z.infer<typeof ListAcknowledgmentsQuery>;

// ---------------------------------------------------------------------------------------------
// Price rules
// ---------------------------------------------------------------------------------------------
export const PriceRuleSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    version: z.number().int(),
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    basePriceMinor: z.number().int(),
    currency: CurrencyCode,
    chargeLines: z.array(ChargeLineSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('PriceRule');
export type PriceRule = z.infer<typeof PriceRuleSchema>;

export const CreatePriceRuleBody = withCommandMeta({
  effectiveFrom: Instant,
  effectiveTo: Instant.optional(),
  basePriceMinor: z.number().int().min(0).safe(),
  currency: CurrencyCode,
  chargeLines: z.array(ChargeLineSchema).max(20).default([]),
})
  .refine(
    (v) => v.effectiveTo === undefined || new Date(v.effectiveTo) > new Date(v.effectiveFrom),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  )
  .openapi('CreatePriceRuleRequest');
export type CreatePriceRuleInput = z.infer<typeof CreatePriceRuleBody>;

/** Public price summary shown in discovery: the effective base price and its charge lines. */
export const PublicPriceSchema = z
  .object({
    priceRuleId: z.uuid(),
    basePriceMinor: z.number().int(),
    currency: CurrencyCode,
    chargeLines: z.array(ChargeLineSchema),
  })
  .openapi('PublicPrice');

// ---------------------------------------------------------------------------------------------
// Offerings
// ---------------------------------------------------------------------------------------------

/** The facility an offering takes place at, with the zone its local times are shown in (SPK-SCHED-008). */
export const OfferingFacilitySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** IANA time zone (SPK-SCHED-008). */
    timezone: z.string(),
  })
  .openapi('OfferingFacility');
export type OfferingFacility = z.infer<typeof OfferingFacilitySchema>;

/** Child-safe discovery view (§4.14): no people, no staffing internals, no provenance. */
export const PublicOfferingSchema = z
  .object({
    id: z.uuid(),
    programId: z.uuid(),
    facilityId: z.uuid(),
    /** SPK-SCHED-008: the facility and its IANA time zone (K-04 facility directory). */
    facility: OfferingFacilitySchema,
    name: z.string(),
    description: z.string().nullable(),
    kind: OfferingKindSchema,
    activityType: z.string(),
    format: z.string().nullable(),
    locationLabel: z.string().nullable(),
    startsOn: CatalogDateOnly,
    endsOn: CatalogDateOnly,
    registrationOpensAt: Instant.nullable(),
    registrationClosesAt: Instant.nullable(),
    publicationState: PublicationStateSchema,
    ageBand: AgeBandSchema,
    capacity: z.array(PublicCapacitySchema),
    price: PublicPriceSchema.nullable(),
    eligibilityPolicyVersionId: z.uuid().nullable(),
    cancellationPolicyVersionId: z.uuid().nullable(),
    requiredFormPolicyVersionIds: z.array(z.uuid()),
    entitlementDefinitionId: z.uuid().nullable(),
    /**
     * CAT-02: the approved booking terms version of a rental or party offering effective now
     * (readable by any principal of the organization); null for other kinds or when none is.
     */
    bookingTermsPolicyVersionId: z.uuid().nullable(),
  })
  .openapi('PublicOffering');
export type PublicOffering = z.infer<typeof PublicOfferingSchema>;

/** Staff-only details; `null` on the public detail route for non-staff readers. */
export const OfferingStaffDetailsSchema = z
  .object({
    location: OfferingLocationSchema,
    eligibilityReferenceDate: CatalogDateOnly,
    capacityUnits: z.array(CapacityUnitSchema),
    responsibleManagerPersonId: z.uuid().nullable(),
    copiedFromOfferingId: z.uuid().nullable(),
    /** CAT-02: the booking_terms policy family of a rental or party offering. */
    bookingTermsKey: z.string().nullable(),
    publishedAt: Instant.nullable(),
    registrationOpenedAt: Instant.nullable(),
    closedAt: Instant.nullable(),
    archivedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('OfferingStaffDetails');
export type OfferingStaffDetails = z.infer<typeof OfferingStaffDetailsSchema>;

export const OfferingSchema = PublicOfferingSchema.extend({
  staff: OfferingStaffDetailsSchema.nullable(),
}).openapi('Offering');
export type Offering = z.infer<typeof OfferingSchema>;

/**
 * CAT-01: one row of `GET /offerings`: the child-safe public view, with `staff` details present
 * only in the staff view (`view=staff` for holders of catalog.manage_offerings).
 */
export const OfferingListItemSchema = PublicOfferingSchema.extend({
  staff: OfferingStaffDetailsSchema.optional(),
}).openapi('OfferingListItem');
export type OfferingListItem = z.infer<typeof OfferingListItemSchema>;

const OfferingFields = {
  name: Name,
  description: Description.optional(),
  kind: OfferingKindSchema,
  facilityId: z.uuid(),
  activityType: z.string().trim().min(1).max(100).optional(),
  format: z.string().trim().min(1).max(100).optional(),
  location: OfferingLocationSchema.default({}),
  startsOn: CatalogDateOnly,
  endsOn: CatalogDateOnly,
  registrationOpensAt: Instant.optional(),
  registrationClosesAt: Instant.optional(),
  eligibilityReferenceDate: CatalogDateOnly.optional(),
  eligibilityPolicyVersionId: z.uuid().optional(),
  entitlementDefinitionId: z.uuid().optional(),
  capacityUnits: CapacityUnitsSchema.default([]),
  requiredFormPolicyVersionIds: z.array(z.uuid()).max(20).default([]),
  cancellationPolicyVersionId: z.uuid().optional(),
  responsibleManagerPersonId: z.uuid().optional(),
  /** CAT-02: rental and party offerings only; the approved version is resolved when read. */
  bookingTermsKey: PolicyKey.optional(),
};

const datesOrdered = (v: {
  startsOn?: string;
  endsOn?: string;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
}) =>
  (v.startsOn === undefined || v.endsOn === undefined || v.startsOn <= v.endsOn) &&
  (!v.registrationOpensAt ||
    !v.registrationClosesAt ||
    new Date(v.registrationOpensAt) < new Date(v.registrationClosesAt));

export const CreateOfferingBody = withCommandMeta({ programId: z.uuid(), ...OfferingFields })
  .refine(datesOrdered, {
    message: 'startsOn must not be after endsOn and registration must open before it closes',
    path: ['endsOn'],
  })
  .openapi('CreateOfferingRequest');
export type CreateOfferingInput = z.infer<typeof CreateOfferingBody>;

export const UpdateOfferingBody = withCommandMeta({
  name: Name.optional(),
  description: Description.nullable().optional(),
  activityType: z.string().trim().min(1).max(100).optional(),
  format: z.string().trim().min(1).max(100).nullable().optional(),
  location: OfferingLocationSchema.optional(),
  startsOn: CatalogDateOnly.optional(),
  endsOn: CatalogDateOnly.optional(),
  registrationOpensAt: Instant.nullable().optional(),
  registrationClosesAt: Instant.nullable().optional(),
  eligibilityReferenceDate: CatalogDateOnly.nullable().optional(),
  eligibilityPolicyVersionId: z.uuid().nullable().optional(),
  entitlementDefinitionId: z.uuid().nullable().optional(),
  capacityUnits: CapacityUnitsSchema.optional(),
  requiredFormPolicyVersionIds: z.array(z.uuid()).max(20).optional(),
  cancellationPolicyVersionId: z.uuid().nullable().optional(),
  responsibleManagerPersonId: z.uuid().nullable().optional(),
  bookingTermsKey: PolicyKey.nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .refine(datesOrdered, {
    message: 'startsOn must not be after endsOn and registration must open before it closes',
    path: ['endsOn'],
  })
  .openapi('UpdateOfferingRequest');
export type UpdateOfferingInput = z.infer<typeof UpdateOfferingBody>;

export const OfferingTransitionBody = withCommandMeta({}).openapi('OfferingTransitionRequest');
export type OfferingTransitionInput = z.infer<typeof OfferingTransitionBody>;

/** SPK-CAT-003: a copy is a new draft; nothing transactional is copied. */
export const CopyOfferingBody = withCommandMeta({
  name: Name.optional(),
  facilityId: z.uuid().optional(),
  startsOn: CatalogDateOnly.optional(),
  endsOn: CatalogDateOnly.optional(),
  registrationOpensAt: Instant.nullable().optional(),
  registrationClosesAt: Instant.nullable().optional(),
  /** Copy the offering's sessions, shifted by the difference between the old and new start dates. */
  copySessions: z.boolean().default(false),
})
  .refine(datesOrdered, {
    message: 'startsOn must not be after endsOn and registration must open before it closes',
    path: ['endsOn'],
  })
  .openapi('CopyOfferingRequest');
export type CopyOfferingInput = z.infer<typeof CopyOfferingBody>;

/** Missing configuration is reported as VALIDATION_FAILED with these details (SPK-CAT-004). */
export const PublicationProblemSchema = z
  .object({ code: z.string(), field: z.string(), message: z.string() })
  .openapi('PublicationProblem');
export type PublicationProblem = z.infer<typeof PublicationProblemSchema>;

/**
 * CAT-01 (SPK-CAT-004): the dry run of publication. `problems` are what publish would report
 * (configuration, plus `capability_disabled` when the organization has not enabled the kind);
 * `publishable` is also false when the offering's state does not allow publication. Nothing is
 * written.
 */
export const PublicationCheckSchema = z
  .object({
    offeringId: z.uuid(),
    publicationState: PublicationStateSchema,
    revision: Revision,
    publishable: z.boolean(),
    problems: z.array(PublicationProblemSchema),
  })
  .openapi('PublicationCheck');
export type PublicationCheck = z.infer<typeof PublicationCheckSchema>;

export const ListPublicOfferingsQuery = PageRequestSchema.extend({
  /** Organization slug; required for anonymous discovery, must match the principal's organization otherwise. */
  organization: z.string().trim().min(1).max(200).optional(),
  facilityId: z.uuid().optional(),
  kind: OfferingKindSchema.optional(),
  programId: z.uuid().optional(),
  /** Exact format (for example `7v7`). */
  format: z.string().trim().min(1).max(100).optional(),
  /** Only offerings ending on or after this date (defaults to all). */
  from: CatalogDateOnly.optional(),
  /** Only offerings starting on or before this date (defaults to all). */
  to: CatalogDateOnly.optional(),
  /**
   * `staff`: holders of catalog.manage_offerings get staff rows in every publication state,
   * narrowed to their facilities; anyone else gets the public view. Default `public`.
   */
  view: z.enum(['public', 'staff']).default('public'),
}).refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
  message: 'from must not be after to',
  path: ['to'],
});
export type ListPublicOfferingsQuery = z.infer<typeof ListPublicOfferingsQuery>;

export const ListProgramOfferingsQuery = PageRequestSchema.extend({
  publicationState: PublicationStateSchema.optional(),
});
export type ListProgramOfferingsQuery = z.infer<typeof ListProgramOfferingsQuery>;

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------
export const OfferingSessionSchema = z
  .object({
    id: z.uuid(),
    offeringId: z.uuid(),
    sequence: z.number().int(),
    title: z.string().nullable(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    schedulingEventId: z.uuid().nullable(),
    capacityOverride: z.array(CapacityUnitSchema).nullable(),
    status: OfferingSessionStatusSchema,
    canceledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('OfferingSession');
export type OfferingSession = z.infer<typeof OfferingSessionSchema>;

export const CreateOfferingSessionBody = withCommandMeta({
  sequence: z.number().int().min(1).optional(),
  title: Name.optional(),
  scheduledStart: Instant,
  scheduledEnd: Instant,
  schedulingEventId: z.uuid().optional(),
  capacityOverride: CapacityUnitsSchema.optional(),
})
  .refine((v) => new Date(v.scheduledStart) < new Date(v.scheduledEnd), {
    message: 'scheduledStart must be before scheduledEnd',
    path: ['scheduledEnd'],
  })
  .openapi('CreateOfferingSessionRequest');
export type CreateOfferingSessionInput = z.infer<typeof CreateOfferingSessionBody>;

export const CancelOfferingSessionBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('CancelOfferingSessionRequest');
export type CancelOfferingSessionInput = z.infer<typeof CancelOfferingSessionBody>;

/** CAT-01: the longest window `GET /sessions` lists at once. */
export const FACILITY_SESSIONS_MAX_DAYS = 31;

/**
 * CAT-01: the sessions at one facility overlapping [from, to) (at most 31 days), for desks that
 * build an attendance ActivityRef (offeringId + sessionId). Staff with catalog.read_catalog at the
 * facility only.
 */
export const ListFacilitySessionsQuery = PageRequestSchema.extend({
  facilityId: z.uuid(),
  from: Instant,
  to: Instant,
  status: OfferingSessionStatusSchema.optional(),
})
  .refine((v) => new Date(v.from) < new Date(v.to), {
    message: 'from must be before to',
    path: ['to'],
  })
  .refine(
    (v) =>
      new Date(v.to).getTime() - new Date(v.from).getTime() <=
      FACILITY_SESSIONS_MAX_DAYS * 86_400_000,
    { message: `the window is at most ${FACILITY_SESSIONS_MAX_DAYS} days`, path: ['to'] },
  );
export type ListFacilitySessionsQuery = z.infer<typeof ListFacilitySessionsQuery>;

/** One session in a facility's day, with what an attendance desk needs (SPK-SCHED-008 zone). */
export const FacilitySessionSchema = z
  .object({
    sessionId: z.uuid(),
    offeringId: z.uuid(),
    offeringName: z.string(),
    sequence: z.number().int(),
    title: z.string().nullable(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    status: OfferingSessionStatusSchema,
    facilityId: z.uuid(),
    /** IANA time zone of the facility (SPK-SCHED-008). */
    timezone: z.string(),
  })
  .openapi('FacilitySession');
export type FacilitySession = z.infer<typeof FacilitySessionSchema>;

// ---------------------------------------------------------------------------------------------
// Discounts (SPK-PAY-003)
// ---------------------------------------------------------------------------------------------
export const DiscountEligibilityRulesSchema = z
  .object({
    offeringKinds: z.array(OfferingKindSchema).max(12).optional(),
    offeringIds: z.array(z.uuid()).max(100).optional(),
    programIds: z.array(z.uuid()).max(100).optional(),
    /** Sibling / multi-line discounts: the basket must contain at least this many eligible lines. */
    minLines: z.number().int().min(2).max(50).optional(),
    /** Early registration: the evaluation instant must be before this. */
    registrationBefore: Instant.optional(),
    /** Only lines whose base amount is at least this many minor units qualify. */
    minLineAmountMinor: z.number().int().min(0).safe().optional(),
  })
  .openapi('DiscountEligibilityRules');
export type DiscountEligibilityRules = z.infer<typeof DiscountEligibilityRulesSchema>;

export const DiscountDefinitionSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    kind: DiscountKindSchema,
    amountKind: DiscountAmountKindSchema,
    /** Basis points for a percentage (10000 = 100%), minor units for a fixed amount. */
    amountValue: z.number().int(),
    currency: CurrencyCode.nullable(),
    eligibilityRules: DiscountEligibilityRulesSchema,
    stackingRule: StackingRuleSchema,
    stackingPriority: z.number().int(),
    capMinor: z.number().int().nullable(),
    redemptionLimit: z.number().int().nullable(),
    perPersonLimit: z.number().int().nullable(),
    rounding: RoundingModeSchema,
    allocationMethod: AllocationMethodSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    status: DiscountStatusSchema,
    redeemedCount: z.number().int(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('DiscountDefinition');
export type DiscountDefinition = z.infer<typeof DiscountDefinitionSchema>;

const DiscountCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/, 'letters, digits, "-" and "_" only');

export const CreateDiscountBody = withCommandMeta({
  code: DiscountCode.optional(),
  name: Name,
  description: Description.optional(),
  amountKind: DiscountAmountKindSchema,
  amountValue: z.number().int().min(1).safe(),
  currency: CurrencyCode.optional(),
  eligibilityRules: DiscountEligibilityRulesSchema.default({}),
  stackingRule: StackingRuleSchema.default('exclusive'),
  stackingPriority: z.number().int().min(0).max(10_000).default(100),
  capMinor: z.number().int().min(0).safe().optional(),
  redemptionLimit: z.number().int().min(0).optional(),
  perPersonLimit: z.number().int().min(1).optional(),
  rounding: RoundingModeSchema.default('half_up'),
  allocationMethod: AllocationMethodSchema.default('proportional'),
  effectiveFrom: Instant,
  effectiveTo: Instant.optional(),
  status: z.enum(['draft', 'active']).default('draft'),
})
  .refine((v) => v.amountKind !== 'percentage' || v.amountValue <= 10_000, {
    message: 'a percentage is at most 10000 basis points',
    path: ['amountValue'],
  })
  .refine((v) => v.amountKind !== 'fixed' || v.currency !== undefined, {
    message: 'a fixed discount needs a currency',
    path: ['currency'],
  })
  .refine(
    (v) => v.effectiveTo === undefined || new Date(v.effectiveTo) > new Date(v.effectiveFrom),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  )
  .openapi('CreateDiscountRequest');
export type CreateDiscountInput = z.infer<typeof CreateDiscountBody>;

export const UpdateDiscountBody = withCommandMeta({
  name: Name.optional(),
  description: Description.nullable().optional(),
  eligibilityRules: DiscountEligibilityRulesSchema.optional(),
  stackingRule: StackingRuleSchema.optional(),
  stackingPriority: z.number().int().min(0).max(10_000).optional(),
  capMinor: z.number().int().min(0).safe().nullable().optional(),
  redemptionLimit: z.number().int().min(0).nullable().optional(),
  perPersonLimit: z.number().int().min(1).nullable().optional(),
  rounding: RoundingModeSchema.optional(),
  allocationMethod: AllocationMethodSchema.optional(),
  effectiveTo: Instant.nullable().optional(),
  status: z.enum(['draft', 'active']).optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateDiscountRequest');
export type UpdateDiscountInput = z.infer<typeof UpdateDiscountBody>;

export const RetireDiscountBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RetireDiscountRequest');
export type RetireDiscountInput = z.infer<typeof RetireDiscountBody>;

export const ListDiscountsQuery = PageRequestSchema.extend({
  status: DiscountStatusSchema.optional(),
  code: DiscountCode.optional(),
});
export type ListDiscountsQuery = z.infer<typeof ListDiscountsQuery>;

/** One server-priced basket line the discount evaluator works on (SPK-PAY-001: kind, program and base amount come from the offering and its price rule, never the client). */
export const DiscountEvaluationLineSchema = z
  .object({
    lineId: z.string().trim().min(1).max(100),
    offeringId: z.uuid(),
    offeringKind: OfferingKindSchema,
    programId: z.uuid().nullable().default(null),
    participantPersonId: z.uuid().nullable().default(null),
    baseAmountMinor: z.number().int().min(0).safe(),
  })
  .openapi('DiscountEvaluationLine');
export type DiscountEvaluationLine = z.infer<typeof DiscountEvaluationLineSchema>;

/**
 * One basket line submitted for a discount preview. The server resolves the offering's kind and
 * program and prices the line from its effective price rule (SPK-PAY-001); `offeringKind`,
 * `programId` and `baseAmountMinor` are accepted for compatibility and ignored.
 */
export const DiscountPreviewLineSchema = z
  .object({
    lineId: z.string().trim().min(1).max(100),
    offeringId: z.uuid(),
    participantPersonId: z.uuid().nullable().default(null),
    offeringKind: OfferingKindSchema.optional(),
    programId: z.uuid().nullable().optional(),
    baseAmountMinor: z.number().int().min(0).safe().optional(),
  })
  .openapi('DiscountPreviewLine');

export const EvaluateDiscountsBody = z
  .object({
    currency: CurrencyCode,
    /** Evaluation instant; defaults to the clock. Staff only (customers preview the current instant). */
    at: Instant.optional(),
    lines: z.array(DiscountPreviewLineSchema).min(1).max(100),
    codes: z.array(DiscountCode).max(10).default([]),
  })
  .refine((v) => new Set(v.lines.map((l) => l.lineId)).size === v.lines.length, {
    message: 'lineId must be unique',
    path: ['lines'],
  })
  .openapi('EvaluateDiscountsRequest');
export type EvaluateDiscountsInput = z.infer<typeof EvaluateDiscountsBody>;

export const DiscountAllocationSchema = z.object({
  lineId: z.string(),
  amountMinor: z.number().int(),
});

/** An explainable discount line (SPK-PAY-002 "discounts", SPK-PAY-003). */
export const DiscountLineSchema = z
  .object({
    discountDefinitionId: z.uuid(),
    code: z.string().nullable(),
    name: z.string(),
    applied: z.boolean(),
    amountMinor: z.number().int(),
    allocations: z.array(DiscountAllocationSchema),
    /** Human-readable, deterministic explanation of eligibility, stacking, caps, rounding and allocation. */
    explanation: z.array(z.string()),
  })
  .openapi('DiscountLine');
export type DiscountLine = z.infer<typeof DiscountLineSchema>;

export const DiscountEvaluationSchema = z
  .object({
    currency: CurrencyCode,
    evaluatedAt: Instant,
    lines: z.array(
      z.object({
        lineId: z.string(),
        baseAmountMinor: z.number().int(),
        discountMinor: z.number().int(),
        netAmountMinor: z.number().int(),
      }),
    ),
    discounts: z.array(DiscountLineSchema),
    totalBaseMinor: z.number().int(),
    totalDiscountMinor: z.number().int(),
    totalNetMinor: z.number().int(),
    /** Codes submitted that match no active definition. */
    unknownCodes: z.array(z.string()),
  })
  .openapi('DiscountEvaluation');
export type DiscountEvaluation = z.infer<typeof DiscountEvaluationSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Catalog';
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
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed (publication lists the missing configuration in details)'),
      403: err('Access denied or participant authority required'),
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
  options: { public?: boolean } = {},
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    ...(options.public ? { security: [] } : {}),
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
  '/programs',
  'Create a reusable program (SPK-CAT-001)',
  CreateProgramBody,
  ProgramSchema,
);
query('/programs', 'List programs', ListProgramsQuery, pageSchema(ProgramSchema));
query('/programs/{id}', 'Read a program', null, ProgramSchema);
command('patch', '/programs/{id}', 'Update a program', UpdateProgramBody, ProgramSchema, 200);
query(
  '/programs/{id}/offerings',
  'List the offerings of a program in any publication state (staff)',
  ListProgramOfferingsQuery,
  pageSchema(OfferingSchema),
);

command(
  'post',
  '/entitlement-definitions',
  'Create an entitlement definition (§4.4 EntitlementDefinition)',
  CreateEntitlementDefinitionBody,
  EntitlementDefinitionSchema,
);
query(
  '/entitlement-definitions',
  'List entitlement definitions',
  null,
  z.array(EntitlementDefinitionSchema),
);
query(
  '/entitlement-definitions/{id}',
  'Read an entitlement definition',
  null,
  EntitlementDefinitionSchema,
);
command(
  'patch',
  '/entitlement-definitions/{id}',
  'Update an entitlement definition',
  UpdateEntitlementDefinitionBody,
  EntitlementDefinitionSchema,
  200,
);

command(
  'post',
  '/policy-versions',
  'Create a draft policy version (SPK-REG-002, SPK-PAY-003, §4.4)',
  CreatePolicyVersionBody,
  PolicyVersionSchema,
);
query(
  '/policy-versions',
  'List policy versions',
  ListPolicyVersionsQuery,
  pageSchema(PolicyVersionSchema),
);
query('/policy-versions/{id}', 'Read a policy version', null, PolicyVersionSchema);
command(
  'post',
  '/policy-versions/{id}/approve',
  'Approve a policy version (program/league manager for participation kinds, finance operator for financial kinds)',
  ApprovePolicyVersionBody,
  PolicyVersionSchema,
  200,
);
command(
  'post',
  '/policy-versions/{id}/retire',
  'Retire an approved policy version',
  RetirePolicyVersionBody,
  PolicyVersionSchema,
  200,
);
query(
  '/policy-versions/{id}/approvals',
  'Approval history of a policy version',
  null,
  z.array(ApprovalSchema),
);

command(
  'post',
  '/acknowledgments',
  'Record an acknowledgment signed by the adult subject or a guardian holding complete_forms (SPK-REG-009)',
  RecordAcknowledgmentBody,
  AcknowledgmentSchema,
);
query(
  '/acknowledgments',
  'List acknowledgments of a participant',
  ListAcknowledgmentsQuery,
  z.array(AcknowledgmentSchema),
);
command(
  'post',
  '/acknowledgments/{id}/withdraw',
  'Withdraw an acknowledgment',
  WithdrawAcknowledgmentBody,
  AcknowledgmentSchema,
  200,
);

command(
  'post',
  '/offerings',
  'Create a draft offering (SPK-CAT-001)',
  CreateOfferingBody,
  OfferingSchema,
);
query(
  '/offerings',
  'Discover offerings: published offerings with child-safe fields only; with view=staff, holders of catalog.manage_offerings get every state with staff details in their facilities (SPK-CAT-001, SPK-SCHED-008)',
  ListPublicOfferingsQuery,
  pageSchema(OfferingListItemSchema),
  { public: true },
);
query(
  '/offerings/{id}/publication-check',
  'Check whether an offering could be published and list what is missing, without publishing or recording anything (SPK-CAT-004)',
  null,
  PublicationCheckSchema,
);
query(
  '/offerings/{id}',
  'Read an offering (public view when published; staff details for staff readers)',
  null,
  OfferingSchema,
  { public: true },
);
command(
  'patch',
  '/offerings/{id}',
  'Update a draft or published offering',
  UpdateOfferingBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/publish',
  'Publish an offering after validating its required configuration (SPK-CAT-004)',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/registration/open',
  'Open registration',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/registration/pause',
  'Pause registration (existing participation is preserved)',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/registration/resume',
  'Resume registration',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/close',
  'Close an offering',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/archive',
  'Archive a draft or closed offering',
  OfferingTransitionBody,
  OfferingSchema,
  200,
);
command(
  'post',
  '/offerings/{id}/copy',
  'Copy an offering into a new draft without payments, attendance, enrollments, results or permissions (SPK-CAT-003)',
  CopyOfferingBody,
  OfferingSchema,
);

command(
  'post',
  '/offerings/{id}/sessions',
  'Add a session to an offering',
  CreateOfferingSessionBody,
  OfferingSessionSchema,
);
query(
  '/offerings/{id}/sessions',
  'List the sessions of an offering; readers who are not catalog staff get the child-safe view (no cancel reason, scheduling event id or capacity staffing internals, §4.14)',
  null,
  z.array(OfferingSessionSchema),
  {
    public: true,
  },
);
query(
  '/sessions',
  'List the sessions at a facility overlapping a window of at most 31 days, with the facility time zone (staff; SPK-SCHED-008)',
  ListFacilitySessionsQuery,
  pageSchema(FacilitySessionSchema),
);
command(
  'post',
  '/sessions/{id}/cancel',
  'Cancel a session',
  CancelOfferingSessionBody,
  OfferingSessionSchema,
  200,
);

command(
  'post',
  '/offerings/{id}/price-rules',
  'Create a new price rule version (SPK-PAY-001; an effective rule is never edited)',
  CreatePriceRuleBody,
  PriceRuleSchema,
);
query(
  '/offerings/{id}/price-rules',
  'List the price rule versions of an offering',
  null,
  z.array(PriceRuleSchema),
);

command(
  'post',
  '/discounts',
  'Create a discount definition (SPK-PAY-003)',
  CreateDiscountBody,
  DiscountDefinitionSchema,
);
query(
  '/discounts',
  'List discount definitions',
  ListDiscountsQuery,
  pageSchema(DiscountDefinitionSchema),
);
query('/discounts/{id}', 'Read a discount definition', null, DiscountDefinitionSchema);
command(
  'patch',
  '/discounts/{id}',
  'Update a discount definition',
  UpdateDiscountBody,
  DiscountDefinitionSchema,
  200,
);
command(
  'post',
  '/discounts/{id}/retire',
  'Retire a discount definition',
  RetireDiscountBody,
  DiscountDefinitionSchema,
  200,
);
openApiRegistry.registerPath({
  method: 'post',
  path: '/discounts/evaluate',
  summary: 'Explain the discounts that apply to a basket (pure evaluation, no redemption)',
  tags: [TAG],
  request: { body: { content: { 'application/json': { schema: EvaluateDiscountsBody } } } },
  responses: {
    200: ok('Explainable discount lines', DiscountEvaluationSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
  },
});
