import type {
  CapacityUnit,
  DiscountEvaluation,
  DiscountEvaluationLine,
  EntitlementDefinition,
  Offering,
  PolicyKind,
  PolicyVersion,
  PriceRule,
  Principal,
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

/** Everything a quote or an eligibility evaluation needs about an offering at one instant. */
export interface OfferingSnapshot {
  offering: Offering;
  /** The price rule effective at the instant, or null when the offering is unpriced then. */
  priceRule: PriceRule | null;
  entitlementDefinition: EntitlementDefinition | null;
  capacityUnits: CapacityUnit[];
  /** SPK-REG-002: the configured reference date (YYYY-MM-DD) eligibility is evaluated against. */
  eligibilityReferenceDate: string;
  eligibilityPolicy: PolicyVersion | null;
  cancellationPolicy: PolicyVersion | null;
  requiredForms: PolicyVersion[];
  /** Whether registration intents are accepted right now (publication state and window). */
  registrationOpen: boolean;
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

export interface PolicyPort {
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

export interface PricingPort {
  effectivePriceRule(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<PriceRule | null>;
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
