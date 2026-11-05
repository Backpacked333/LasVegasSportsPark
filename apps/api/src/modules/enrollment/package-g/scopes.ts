import { z, type PolicyVersion } from '@sportspark/contracts';
import type { OfferingSnapshot } from '../../catalog';

/**
 * Enrollment's reading of the catalog's typed Package G content (CAT-02, IF-23; §3.16,
 * SPK-COND-001 to SPK-COND-003). The catalog validates these shapes when a definition or policy
 * version is written and hands its snapshot with the scope already parsed; enrollment parses
 * again at the point of use so a stored value that does not satisfy the shape is refused rather
 * than guessed at (a missing key never becomes a default: POL-038, POL-039, POL-040). The shapes
 * mirror the catalog's schemas key for key; they are deliberately not registered as OpenAPI
 * components (the catalog owns those names).
 */

const Slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const DateOnly = z.iso.date();

export const AppliesToSchema = z
  .strictObject({
    offeringIds: z.array(z.uuid()).max(100).optional(),
    programIds: z.array(z.uuid()).max(100).optional(),
  })
  .refine((v) => (v.offeringIds?.length ?? 0) > 0 || (v.programIds?.length ?? 0) > 0, {
    message: 'name at least one offering or program',
  });
export type AppliesTo = z.infer<typeof AppliesToSchema>;

const IncludedSessionsLimit = z
  .strictObject({
    count: z.number().int().min(1).max(10_000),
    period: z.enum(['week', 'month', 'membership_term']),
    weekStartsOn: z.number().int().min(1).max(7).optional(),
  })
  .refine((v) => (v.period === 'week') === (v.weekStartsOn !== undefined));

export const MembershipBenefitScopeSchema = z.strictObject({
  attendance: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({
      mode: z.literal('included_sessions'),
      appliesTo: AppliesToSchema,
      limit: IncludedSessionsLimit,
    }),
    z.strictObject({ mode: z.literal('unlimited'), appliesTo: AppliesToSchema }),
  ]),
  term: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('offering_dates') }),
    z.strictObject({
      kind: z.literal('from_confirmation'),
      lengthDays: z.number().int().min(1).max(3660),
    }),
  ]),
  renewal: z.strictObject({ noticeLeadDays: z.number().int().min(1).max(365).nullable() }),
});
export type MembershipBenefitScope = z.infer<typeof MembershipBenefitScopeSchema>;

export const PackageCreditsScopeSchema = z.strictObject({
  credits: z.number().int().min(1).max(1000),
  appliesTo: AppliesToSchema,
  expiry: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('days_after_issue'),
      days: z.number().int().min(1).max(3650),
    }),
    z.strictObject({ kind: z.literal('fixed_date'), date: DateOnly }),
  ]),
});
export type PackageCreditsScope = z.infer<typeof PackageCreditsScopeSchema>;

const ResourceRequirement = z
  .strictObject({
    resourceIds: z.array(z.uuid()).min(1).max(50),
    count: z.number().int().min(1).max(50),
  })
  .refine((v) => new Set(v.resourceIds).size === v.resourceIds.length)
  .refine((v) => v.count <= v.resourceIds.length);

export const StaffingRequirementSchema = z.strictObject({
  kind: z.enum(['supervisor', 'organizer']),
  role: Slug,
  count: z.number().int().min(1).max(100),
  qualifications: z.array(Slug).max(20),
});
export type StaffingRequirement = z.infer<typeof StaffingRequirementSchema>;

export const PartyPackageScopeSchema = z.strictObject({
  durationMinutes: z.number().int().min(1).max(1440),
  guestLimit: z.number().int().min(1).max(10_000),
  resources: ResourceRequirement,
  staffing: z.array(StaffingRequirementSchema).max(20),
  equipmentAssetIds: z.array(z.uuid()).max(100),
});
export type PartyPackageScope = z.infer<typeof PartyPackageScopeSchema>;

export const RentalResourceScopeSchema = z.strictObject({
  resources: ResourceRequirement,
  staffing: z.array(StaffingRequirementSchema).max(20),
});
export type RentalResourceScope = z.infer<typeof RentalResourceScopeSchema>;

/** Booking terms content (policy kind `booking_terms`, POL-040, POL-005). */
export const BookingTermsContentSchema = z.strictObject({
  confirmationMode: z.enum(['instant', 'request']),
  installmentPolicyKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)
    .nullable(),
  setupMinutes: z.number().int().min(0).max(1440).optional(),
  cleanupMinutes: z.number().int().min(0).max(1440).optional(),
  accessConditions: z.string().trim().min(1).max(4000).nullable(),
  hostResponsibilities: z.string().trim().min(1).max(4000).nullable(),
});
export type BookingTermsContent = z.infer<typeof BookingTermsContentSchema>;

const PackageCreditReturnSchema = z.strictObject({
  untilMinutesBeforeStart: z.number().int().min(0).max(525_600),
});

const KIND_SCHEMAS = {
  membership_benefit: MembershipBenefitScopeSchema,
  package_credits: PackageCreditsScopeSchema,
  party_package: PartyPackageScopeSchema,
  rental_resource: RentalResourceScopeSchema,
} as const;
type TypedKind = keyof typeof KIND_SCHEMAS;
type ScopeOf<K extends TypedKind> = z.infer<(typeof KIND_SCHEMAS)[K]>;

/**
 * The snapshot's entitlement scope when the definition is of `kind` and its scope satisfies the
 * shape; otherwise null (the caller refuses: nothing is guessed).
 */
export function typedScope<K extends TypedKind>(
  snapshot: OfferingSnapshot,
  kind: K,
): ScopeOf<K> | null {
  const definition = snapshot.entitlementDefinition as
    { kind: string; scope: unknown } | null | undefined;
  if (!definition || definition.kind !== kind) return null;
  const parsed = KIND_SCHEMAS[kind].safeParse(definition.scope);
  return parsed.success ? (parsed.data as ScopeOf<K>) : null;
}

/** Approved booking terms content, or null when absent or not of the shape. */
export function bookingTermsContent(terms: PolicyVersion | null): BookingTermsContent | null {
  if (!terms) return null;
  const parsed = BookingTermsContentSchema.safeParse(terms.content);
  return parsed.success ? parsed.data : null;
}

/**
 * The cancellation policy's package credit return (POL-007, POL-039), or null when the policy
 * is absent or does not state it (the credit then stays retained pending policy).
 */
export function packageCreditReturn(
  policy: PolicyVersion | null,
): { untilMinutesBeforeStart: number } | null {
  const content = policy?.content as Record<string, unknown> | undefined;
  if (!content || !('packageCreditReturn' in content)) return null;
  const parsed = PackageCreditReturnSchema.safeParse(content['packageCreditReturn']);
  return parsed.success ? parsed.data : null;
}

/**
 * The eligibility policy's member-only requirement (ENR-12): `undefined` when the policy does
 * not ask for a membership, null when it asks but the requirement is malformed (treated as
 * unsatisfiable, never as no requirement).
 */
export function membershipRequirement(policy: PolicyVersion | null): AppliesTo | null | undefined {
  const content = policy?.content as Record<string, unknown> | undefined;
  if (!content || content['membershipRequired'] === undefined) return undefined;
  const parsed = AppliesToSchema.safeParse(content['membershipRequired']);
  return parsed.success ? parsed.data : null;
}

/** Whether an offering (by id and program) is covered by an appliesTo selection. */
export function covers(
  appliesTo: { offeringIds?: readonly string[]; programIds?: readonly string[] },
  offering: { id: string; programId: string },
): boolean {
  return (
    (appliesTo.offeringIds ?? []).includes(offering.id) ||
    (appliesTo.programIds ?? []).includes(offering.programId)
  );
}
