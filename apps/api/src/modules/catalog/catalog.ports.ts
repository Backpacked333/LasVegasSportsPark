import type {
  CapacityUnit,
  DiscountEvaluation,
  DiscountEvaluationLine,
  EntitlementDefinition,
  EntitlementKind,
  MembershipBenefitScope,
  Offering,
  OfferingAddon,
  OfferingUniform,
  PolicyKind,
  PackageCreditsScope,
  PartyPackageScope,
  PolicyVersion,
  PriceRule,
  Principal,
  RentalResourceScope,
  TypedEntitlementKind,
  WaiverActivityRef,
  WaiverOverride,
  WaiverStatus,
} from '@sportspark/contracts';
import type { Trx } from '../../kernel';

/**
 * Ports other modules consume (README "Ports"). They are organization-scoped lookups for modules
 * that have already authorized their own command (enrollment, finance, communications); showing
 * catalog data to a user goes through the controllers so object-level authorization applies.
 */
export const OFFERING_LOOKUP_PORT = Symbol('OFFERING_LOOKUP_PORT');
export const POLICY_PORT = Symbol('POLICY_PORT');
export const PRICING_PORT = Symbol('PRICING_PORT');

type DefinitionWith<K extends EntitlementKind, S> = Omit<
  EntitlementDefinition,
  'kind' | 'scope'
> & {
  kind: K;
  scope: S;
};

/**
 * CAT-02, IF-23: an entitlement definition whose scope is typed by its kind (SPK-COND-001 to
 * SPK-COND-003). The four Package G kinds carry their parsed scope; every other kind keeps the
 * free-form scope.
 */
export type SnapshotEntitlementDefinition =
  | DefinitionWith<'membership_benefit', MembershipBenefitScope>
  | DefinitionWith<'package_credits', PackageCreditsScope>
  | DefinitionWith<'party_package', PartyPackageScope>
  | DefinitionWith<'rental_resource', RentalResourceScope>
  | DefinitionWith<Exclude<EntitlementKind, TypedEntitlementKind>, Record<string, unknown>>;

/** Everything a quote or an eligibility evaluation needs about an offering at one instant. */
export interface OfferingSnapshot {
  offering: Offering;
  /** The price rule effective at the instant, or null when the offering is unpriced then. */
  priceRule: PriceRule | null;
  /**
   * The definition with its scope typed by kind (IF-23). A Package G definition whose stored
   * scope does not satisfy its schema is reported as null, so a consumer refuses rather than
   * guesses an effect.
   */
  entitlementDefinition: SnapshotEntitlementDefinition | null;
  capacityUnits: CapacityUnit[];
  /** SPK-REG-002: the configured reference date (YYYY-MM-DD) eligibility is evaluated against. */
  eligibilityReferenceDate: string;
  eligibilityPolicy: PolicyVersion | null;
  cancellationPolicy: PolicyVersion | null;
  requiredForms: PolicyVersion[];
  /**
   * SPK-REG-011 (proposed amendment PA-01): the waiver families the offering requires, by policy
   * key. Whether a participant's waiver is current is asked of `PolicyPort.waiverFindings`.
   */
  requiredWaiverKeys: string[];
  /** Whether registration intents are accepted right now (publication state and window). */
  registrationOpen: boolean;
  /**
   * CAT-02, IF-23: the approved `booking_terms` version of a rental or party offering effective at
   * the instant (its content satisfies `BookingTermsContentSchema`); null for other kinds or when
   * no approved version is effective, and a booking without terms is refused with
   * BOOKING_TERMS_REQUIRED.
   */
  bookingTerms: PolicyVersion | null;
}

export interface OfferingLookupPort {
  /** Returns null for unknown or cross-organization ids (never throws for them). */
  getOffering(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<OfferingSnapshot | null>;
  /**
   * The facility of each offering (§4.3 facility boundaries), for modules that authorize records
   * hanging off an offering against the caller's facility scope. Unknown or cross-organization
   * ids are absent from the map.
   */
  facilitiesOfOfferings(
    organizationId: string,
    offeringIds: readonly string[],
    trx?: Trx,
  ): Promise<Map<string, string>>;
  /** The ids of the organization's offerings at any of the facilities (§4.3, §4.14 list scope). */
  offeringIdsAtFacilities(
    organizationId: string,
    facilityIds: readonly string[],
    trx?: Trx,
  ): Promise<string[]>;
}

/**
 * SPK-REG-011 (proposed amendment PA-01): one person whose required waiver is missing or lapsed
 * for an activity. `severity` is what the rule of the version in force makes of it: `warning`
 * when the rule warns, `blocking` when it blocks; a recorded override of a block (`override`)
 * turns it into a warning. A caller never treats `lapsed` as current: there is no finding at all
 * for a current waiver.
 */
export interface WaiverFinding {
  personId: string;
  policyKey: string;
  title: string;
  status: 'missing' | 'lapsed';
  severity: 'warning' | 'blocking';
  override: WaiverOverride | null;
  waiver: WaiverStatus;
}

export interface WaiverFindingsRequest {
  personIds: readonly string[];
  /** The waiver families the activity requires (`OfferingSnapshot.requiredWaiverKeys`). */
  policyKeys: readonly string[];
  at: Date;
  /** The activity references an override may have been recorded against. */
  activities: readonly WaiverActivityRef[];
}

export interface PolicyPort {
  /**
   * SPK-REG-011 (proposed amendment PA-01, ADR-004): whether the person holds an acceptance of
   * the waiver family that is current under the rule of the version in force at the instant:
   * `current`, `lapsed` or `missing`, with the accepted version, time, method and the rule
   * applied. A pure evaluation: it does not look at the capability switch.
   */
  waiverStatus(
    organizationId: string,
    personId: string,
    policyKey: string,
    at: Date,
    trx?: Trx,
  ): Promise<WaiverStatus>;
  /** `waiverStatus` for many people in two reads (a roster). Every id asked about is answered. */
  waiverStatuses(
    organizationId: string,
    personIds: readonly string[],
    policyKey: string,
    at: Date,
    trx?: Trx,
  ): Promise<Map<string, WaiverStatus>>;
  /**
   * The missing or lapsed required waivers of the people for one activity, with the severity the
   * rule gives them and any recorded override. Empty while the organization has not turned
   * liability waivers on (capability `liability_waivers`): nothing is evaluated then.
   */
  waiverFindings(
    organizationId: string,
    request: WaiverFindingsRequest,
    trx?: Trx,
  ): Promise<WaiverFinding[]>;
  getPolicyVersion(
    organizationId: string,
    policyVersionId: string,
    trx?: Trx,
  ): Promise<PolicyVersion | null>;
  /** The approved version of a policy family effective at the instant (highest version wins). */
  currentPolicyVersion(
    organizationId: string,
    kind: PolicyKind,
    key: string,
    at: Date,
    trx?: Trx,
  ): Promise<PolicyVersion | null>;
  /** True when an active acknowledgment of the policy version exists for the participant. */
  hasAcknowledgment(
    organizationId: string,
    subjectPersonId: string,
    policyVersionId: string,
    trx?: Trx,
  ): Promise<boolean>;
  /**
   * R3-PERFORMANCE-01: the participants among `subjectPersonIds` with an active acknowledgment of
   * the policy version, in one query (a roster's required-form check).
   */
  acknowledgedSubjects(
    organizationId: string,
    subjectPersonIds: readonly string[],
    policyVersionId: string,
    trx?: Trx,
  ): Promise<Set<string>>;
}

export interface EvaluateDiscountsRequest {
  currency: string;
  at: Date;
  lines: DiscountEvaluationLine[];
  codes: string[];
}

export interface RedeemDiscountInput {
  discountDefinitionId: string;
  /** The record that consumes the redemption (order line, enrollment …). */
  referenceType: string;
  referenceId: string;
  personId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  actor: Principal;
  correlationId?: string | null;
}

export interface RedemptionOutcome {
  discountDefinitionId: string;
  redeemedCount: number;
  redemptionLimit: number | null;
  /** True when this reference had already redeemed (replay): nothing was consumed again. */
  replayed: boolean;
}

/** A session a participant joining at an instant can still attend (SPK-PAY-013, PA-02). */
export interface RemainingSession {
  id: string;
  /** ISO instant of the scheduled start. */
  scheduledStart: string;
}

/**
 * Every add-on and uniform of an offering, retired ones included (SPK-PAY-014, SPK-REG-012):
 * enrollment validates a selection against the active ones and names the retired ones a past
 * purchase still carries; finance prices a selection from them.
 */
export interface OfferingExtras {
  addons: OfferingAddon[];
  uniforms: OfferingUniform[];
}

export interface PricingPort {
  /**
   * SPK-PAY-014 (PA-03), SPK-REG-012 (PA-07): the add-ons and uniforms of an offering. Unknown and
   * cross-organization ids answer empty lists. Whether a capability is on is the caller's to
   * check: this is the catalog's record, not a decision to offer it.
   */
  offeringExtras(organizationId: string, offeringId: string, trx?: Trx): Promise<OfferingExtras>;
  effectivePriceRule(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PriceRule | null>;
  /**
   * SPK-PAY-013 (PA-02): the offering's sessions that are scheduled and start strictly after
   * `at`, ordered by start. A per-session price is multiplied by their number; a quote stores
   * their ids so the count can be reproduced. Unknown and cross-organization ids answer [].
   * Read it before the caller's unit of work (or pass the transaction).
   */
  remainingSessions(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<RemainingSession[]>;
  /** Explainable discount lines (SPK-PAY-003): pure evaluation over the active definitions, no redemption. */
  evaluateDiscounts(
    organizationId: string,
    input: EvaluateDiscountsRequest,
    trx?: Trx,
  ): Promise<DiscountEvaluation>;
  /**
   * Consumes one redemption inside the caller's transaction. The database refuses the redemption
   * that would exceed the limit (§4.7 invariant 7); a repeated call for the same reference replays.
   * Throws RESOURCE_CONFLICT (details.code DISCOUNT_REDEMPTION_LIMIT) when exhausted.
   */
  redeemDiscount(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome>;
  /** Gives a redemption back (cancellation); idempotent per reference. */
  releaseDiscount(
    trx: Trx,
    organizationId: string,
    input: RedeemDiscountInput,
  ): Promise<RedemptionOutcome>;
}
