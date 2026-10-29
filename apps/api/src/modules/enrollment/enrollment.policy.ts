import type {
  CapabilityId,
  OfferingKind,
  PolicyVersion,
  RegistrationIntent,
} from '@sportspark/contracts';

/**
 * Enrollment policy defaults. They implement the mechanisms the specification requires with the
 * specification's proposed values as configuration; the values themselves await the operator
 * decisions cited on each one (docs/package-a/decision-register.md, §6.6 "Waitlist, holds,
 * approvals, basket behavior"). None of them is law.
 */
export interface EnrollmentPolicy {
  /** SPK-REG-006 server-owned hold duration (DEC-027: ten minutes proposed). */
  holdMinutes: number;
  /** SPK-REG-008 offer duration (POL-006 proposes nothing; engineering placeholder, DEC-006). */
  waitlistOfferHours: number;
  /** SPK-REG-008 "expiration releases it according to the configured priority policy" (DEC-006). */
  offerExpiryBehaviour: 'requeue_end' | 'keep_position' | 'remove';
  /** SPK-REG-007 (DEC-028): intents that need human approval unless a policy says otherwise. */
  approvalRequiredIntents: readonly RegistrationIntent[];
  /** SPK-REG-007 (DEC-029): approval never reserves capacity unless the policy says so. */
  approvalReservesCapacity: boolean;
  /** Policy family (kind `approval`) consulted for offering-specific approval rules. */
  approvalPolicyKey: string;
  /** SPK-REG-004 (DEC-026): household fulfillment default. */
  defaultFulfillmentMode: 'all_or_nothing' | 'partial';
  /**
   * SPK-REG-008 (DEC-006): while participants wait, a freed place is offered to the waitlist
   * rather than taken by a new registrant who did not queue.
   */
  waitlistFirst: boolean;
}

export const ENROLLMENT_POLICY = Symbol('ENROLLMENT_POLICY');

export const DEFAULT_ENROLLMENT_POLICY: EnrollmentPolicy = {
  holdMinutes: 10,
  waitlistOfferHours: 48,
  offerExpiryBehaviour: 'requeue_end',
  approvalRequiredIntents: ['join_team', 'create_team_entry'],
  approvalReservesCapacity: false,
  approvalPolicyKey: 'registration',
  defaultFulfillmentMode: 'all_or_nothing',
  waitlistFirst: true,
};

/**
 * Intents that have their own command and record instead of a basket line: trials keep a trial
 * participation (SPK-YOUTH-003), makeups redeem an entitlement (SPK-YOUTH-004) and pickup books a
 * session seat that never creates league membership (SPK-PLACE-004).
 */
export const SESSION_INTENT_COMMANDS: Partial<Record<RegistrationIntent, string>> = {
  trial: 'POST /v1/trial-participations',
  makeup: 'POST /v1/makeup-entitlements/{id}/redeem',
  pickup: 'POST /v1/session-bookings',
};

/**
 * An offering kind an intent may target. `party` is the catalog's party package kind (CAT-02,
 * §3.16); it is named here so the intent map is complete whichever catalog vocabulary is merged.
 */
export type IntentOfferingKind = OfferingKind | 'party';

/** Offering kinds each registration intent may target (SPK-REG-001 × SPK-CAT-002, ENR-10). */
export const INTENT_OFFERING_KINDS: Record<RegistrationIntent, readonly IntentOfferingKind[]> = {
  individual_league: ['season', 'term'],
  join_team: ['season'],
  create_team_entry: ['season'],
  youth: ['term', 'camp', 'session', 'private_coaching', 'season'],
  trial: ['trial'],
  makeup: ['makeup', 'session', 'term', 'camp'],
  pickup: ['pickup'],
  rental_request: ['rental'],
  membership: ['membership'],
  package_purchase: ['package'],
  party_request: ['party'],
};

/**
 * Capacity units an offering-level hold for the intent must acquire (SPK-REG-005). A membership
 * or package purchase holds a seat only when its offering configures a seats pool; a party
 * request holds the offering's rental resource pool when configured (its space is reserved by
 * scheduling, ENR-13).
 */
export const INTENT_CAPACITY_UNITS: Record<
  RegistrationIntent,
  readonly ('seats' | 'camp_group_places' | 'team_entries' | 'roster_places' | 'rental_resources')[]
> = {
  individual_league: ['seats', 'camp_group_places'],
  youth: ['seats', 'camp_group_places'],
  join_team: ['roster_places'],
  create_team_entry: ['team_entries'],
  rental_request: ['rental_resources'],
  membership: ['seats'],
  package_purchase: ['seats'],
  party_request: ['rental_resources'],
  // session-scoped intents hold session pools, never offering pools
  trial: [],
  makeup: [],
  pickup: [],
};

/**
 * ENR-10 (DEC-016; DEC-072, DEC-074, DEC-076, DEC-077): the capability switch a new commitment of
 * the intent needs. Adding the line, holding it and starting its checkout re-check it, so
 * disabling a capability stops new sales of offerings already published; releasing, cancelling,
 * expiring and recording payment outcomes never check it.
 */
export const INTENT_CAPABILITIES: Partial<Record<RegistrationIntent, CapabilityId>> = {
  membership: 'memberships',
  package_purchase: 'session_packages',
  rental_request: 'rentals',
  party_request: 'parties',
};

/** ENR-10 (SPK-COND-003): intents that exist only with their reservation (POST /bookings). */
export const BOOKING_INTENTS: readonly RegistrationIntent[] = ['rental_request', 'party_request'];

/** ENR-10: intents whose line is exactly one entitlement. */
export const SINGLE_ENTITLEMENT_INTENTS: readonly RegistrationIntent[] = [
  'membership',
  'package_purchase',
];

export interface ApprovalRuleContent {
  intents?: RegistrationIntent[];
  offeringKinds?: OfferingKind[];
  offeringIds?: string[];
  requiresApproval?: boolean;
  reservesCapacity?: boolean;
}

/**
 * SPK-REG-007 mechanism: does this intent for this offering need human approval before a payment
 * is captured? The eligibility policy may demand it, the organization's approval policy family
 * may name intents/kinds/offerings, else the configured default intents apply (DEC-028).
 */
export function requiresApproval(
  policy: EnrollmentPolicy,
  intent: RegistrationIntent,
  offering: { id: string; kind: OfferingKind },
  eligibilityPolicy: PolicyVersion | null,
  approvalPolicy: PolicyVersion | null,
): boolean {
  const eligibilityContent = (eligibilityPolicy?.content ?? {}) as { requiresApproval?: unknown };
  if (eligibilityContent.requiresApproval === true) return true;
  if (eligibilityContent.requiresApproval === false) return false;
  if (approvalPolicy) {
    const rule = approvalPolicy.content as ApprovalRuleContent;
    if (rule.requiresApproval === false) return false;
    if (rule.offeringIds?.includes(offering.id)) return true;
    if (rule.offeringKinds?.includes(offering.kind)) return true;
    if (rule.intents?.includes(intent)) return true;
    if (rule.requiresApproval === true) return true;
    return false;
  }
  return policy.approvalRequiredIntents.includes(intent);
}
