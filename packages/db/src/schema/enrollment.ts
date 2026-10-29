import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Enrollment module tables (migrations 0500-0502, specification §3.3 SPK-REG-001..010, §3.6
 * SPK-PLACE-001..005, §3.13 SPK-YOUTH-001..007, §4.4 Participation + Capacity, §4.6
 * Application/Enrollment/Placement/Hold/SessionBooking machines, §4.7 invariants 2, 3, 7).
 */

export type RegistrationIntent =
  | 'individual_league'
  | 'join_team'
  | 'create_team_entry'
  | 'youth'
  | 'trial'
  | 'makeup'
  | 'pickup'
  | 'rental_request'
  | 'membership'
  | 'package_purchase'
  | 'party_request';

export type CapacityPoolScopeType =
  'offering' | 'session' | 'division' | 'team_entry' | 'camp_group' | 'rental';
export type CapacityPoolUnit =
  | 'team_entries'
  | 'roster_places'
  | 'seats'
  | 'session_seats'
  | 'camp_group_places'
  | 'rental_resources';
export type CapacityConstraintKind = 'commercial' | 'staffing' | 'space';
export type CapacityPoolStatus = 'active' | 'closed';
export interface CapacityPoolsTable {
  id: string;
  organization_id: string;
  offering_id: string | null;
  scope_type: CapacityPoolScopeType;
  scope_id: string;
  unit: CapacityPoolUnit;
  constraint_kind: Generated<CapacityConstraintKind>;
  capacity: number;
  committed: Generated<number>;
  held: Generated<number>;
  participants_per_staff: number | null;
  staff_count: number | null;
  status: Generated<CapacityPoolStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type BasketFulfillmentMode = 'all_or_nothing' | 'partial';
export type BasketStatus =
  | 'open'
  | 'held'
  | 'checking_out'
  | 'fulfilled'
  | 'partially_fulfilled'
  | 'expired'
  | 'released'
  | 'abandoned';
export interface BasketsTable {
  id: string;
  organization_id: string;
  owner_person_id: string;
  payer_person_id: string | null;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  assisted_by_person_id: string | null;
  fulfillment_mode: Generated<BasketFulfillmentMode>;
  partial_accepted_at: NullableTimestamp;
  status: Generated<BasketStatus>;
  hold_expires_at: NullableTimestamp;
  currency: string | null;
  order_ref: string | null;
  last_operation_id: string | null;
  checkout_started_at: NullableTimestamp;
  fulfilled_at: NullableTimestamp;
  released_at: NullableTimestamp;
  release_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ApplicationStatusValue =
  'draft' | 'submitted' | 'awaiting_review' | 'accepted' | 'declined' | 'withdrawn';
export interface ApplicationsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  participant_person_id: string;
  intent: RegistrationIntent;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  payer_person_id: string | null;
  status: Generated<ApplicationStatusValue>;
  eligibility_result: GeneratedJson<Record<string, unknown>>;
  override: Json<Record<string, unknown>> | null;
  requires_approval: Generated<boolean>;
  team_entry_id: string | null;
  session_id: string | null;
  notes: string | null;
  submitted_at: NullableTimestamp;
  decided_at: NullableTimestamp;
  decided_by: Json<Record<string, unknown>> | null;
  decided_by_person_id: string | null;
  decision_reason: string | null;
  withdrawn_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type HoldStatusValue = 'active' | 'committed' | 'released' | 'expired';
export type HoldOwnerKind = 'basket' | 'waitlist_offer' | 'session_booking' | 'placement' | 'staff';
export interface HoldsTable {
  id: string;
  organization_id: string;
  pool_id: string;
  quantity: number;
  owner_kind: HoldOwnerKind;
  owner_id: string | null;
  basket_id: string | null;
  actor: Json<Record<string, unknown>>;
  status: Generated<HoldStatusValue>;
  acquired_at: Timestamp;
  expires_at: Timestamp;
  committed_at: NullableTimestamp;
  released_at: NullableTimestamp;
  expired_at: NullableTimestamp;
  release_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type EnrollmentStatusValue =
  'pending' | 'confirmed' | 'canceled' | 'transferred' | 'completed';
export interface EnrollmentsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  participant_person_id: string;
  intent: RegistrationIntent;
  entitlement_definition_id: string | null;
  equivalence_key: string | null;
  status: Generated<EnrollmentStatusValue>;
  payer_person_id: string | null;
  registered_by: Json<Record<string, unknown>>;
  registered_by_person_id: string | null;
  assisted_by_person_id: string | null;
  source_application_id: string | null;
  basket_id: string | null;
  basket_line_id: string | null;
  placement_request_id: string | null;
  trial_participation_id: string | null;
  order_ref: string | null;
  last_operation_id: string | null;
  price_snapshot: Json<Record<string, unknown>> | null;
  policy_references: GeneratedJson<Record<string, unknown>>;
  eligibility_result: GeneratedJson<Record<string, unknown>>;
  confirmed_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancellation_reason: string | null;
  cancellation_policy_version_id: string | null;
  cancellation_consequence: Json<Record<string, unknown>> | null;
  transferred_at: NullableTimestamp;
  transferred_to_enrollment_id: string | null;
  transferred_from_enrollment_id: string | null;
  /** Migration 0501: the financial consequence accepted with the transfer (SPK-REG-010). */
  transfer_consequence: Json<Record<string, unknown>> | null;
  completed_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type BasketLineOutcome = 'pending' | 'held' | 'confirmed' | 'failed' | 'released';
export interface BasketLinesTable {
  id: string;
  organization_id: string;
  basket_id: string;
  sequence: number;
  participant_person_id: string;
  offering_id: string;
  session_id: string | null;
  team_entry_id: string | null;
  intent: RegistrationIntent;
  quantity: Generated<number>;
  application_id: string | null;
  trial_participation_id: string | null;
  entitlement_definition_id: string | null;
  equivalence_key: string | null;
  eligibility_result: GeneratedJson<Record<string, unknown>>;
  price_snapshot: Json<Record<string, unknown>> | null;
  policy_references: GeneratedJson<Record<string, unknown>>;
  requires_approval: Generated<boolean>;
  enrollment_id: string | null;
  outcome: Generated<BasketLineOutcome>;
  outcome_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PlacementStatusValue = 'unassigned' | 'proposed' | 'assigned' | 'released';
export interface PlacementRequestsTable {
  id: string;
  organization_id: string;
  participant_person_id: string;
  application_id: string | null;
  enrollment_id: string | null;
  offering_id: string | null;
  season_id: string;
  status: Generated<PlacementStatusValue>;
  availability: GeneratedJson<JsonObject>;
  preferred_competition_id: string | null;
  preferred_division_id: string | null;
  declared_level: string | null;
  position_preferences: GeneratedJson<JsonObject>;
  requested_teammate_person_ids: GeneratedJson<JsonObject>;
  notes: string | null;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  proposed_team_entry_id: string | null;
  proposed_at: NullableTimestamp;
  proposed_by: Json<Record<string, unknown>> | null;
  proposal_reasons: GeneratedJson<JsonObject>;
  assigned_team_entry_id: string | null;
  assigned_at: NullableTimestamp;
  decided_by: Json<Record<string, unknown>> | null;
  decided_by_person_id: string | null;
  decision_reasons: GeneratedJson<JsonObject>;
  roster_membership_ref: string | null;
  last_operation_id: string | null;
  released_at: NullableTimestamp;
  release_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MakeupOriginKind = 'session_canceled' | 'absence' | 'policy_event' | 'manual';
export type MakeupEntitlementStatus = 'active' | 'exhausted' | 'expired' | 'revoked';
export interface MakeupEntitlementsTable {
  id: string;
  organization_id: string;
  participant_person_id: string;
  originating_enrollment_id: string | null;
  originating_session_id: string | null;
  origin_kind: MakeupOriginKind;
  origin_reference: string | null;
  eligible_offering_ids: GeneratedJson<JsonObject>;
  eligible_program_ids: GeneratedJson<JsonObject>;
  issued_by: Json<Record<string, unknown>>;
  issued_by_person_id: string | null;
  reason: string;
  expires_at: Timestamp;
  redemption_limit: Generated<number>;
  redeemed_count: Generated<number>;
  status: Generated<MakeupEntitlementStatus>;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type SessionBookingKind = 'pickup' | 'trial' | 'makeup' | 'session';
export type SessionBookingStatusValue = 'pending' | 'confirmed' | 'canceled' | 'expired';
export interface SessionBookingsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  session_id: string;
  participant_person_id: string;
  kind: SessionBookingKind;
  status: Generated<SessionBookingStatusValue>;
  pool_id: string | null;
  hold_id: string | null;
  makeup_entitlement_id: string | null;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  booked_by: Json<Record<string, unknown>>;
  booked_by_person_id: string | null;
  assisted_by_person_id: string | null;
  payer_person_id: string | null;
  price_snapshot: Json<Record<string, unknown>> | null;
  policy_references: GeneratedJson<Record<string, unknown>>;
  eligibility_result: GeneratedJson<Record<string, unknown>>;
  expires_at: NullableTimestamp;
  confirmed_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  expired_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MakeupRedemptionKind = 'redeem' | 'reversal';
export interface MakeupRedemptionsTable {
  id: string;
  organization_id: string;
  makeup_entitlement_id: string;
  session_booking_id: string;
  participant_person_id: string;
  kind: Generated<MakeupRedemptionKind>;
  reverses_redemption_id: string | null;
  actor: Json<Record<string, unknown>>;
  redeemed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type AllocationStatus = 'active' | 'released';
export interface AllocationsTable {
  id: string;
  organization_id: string;
  pool_id: string;
  hold_id: string | null;
  enrollment_id: string | null;
  session_booking_id: string | null;
  placement_request_id: string | null;
  quantity: number;
  status: Generated<AllocationStatus>;
  allocated_at: Timestamp;
  released_at: NullableTimestamp;
  release_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type WaitlistPriorityBasis = 'joined_at' | 'priority_tier' | 'returning' | 'manual';
export type WaitlistEntryStatus =
  'waiting' | 'offered' | 'accepted' | 'expired' | 'withdrawn' | 'removed';
export interface WaitlistEntriesTable {
  id: string;
  organization_id: string;
  offering_id: string;
  pool_id: string;
  session_id: string | null;
  participant_person_id: string;
  intent: RegistrationIntent;
  priority_basis: Generated<WaitlistPriorityBasis>;
  priority_rank: Generated<number>;
  joined_at: Timestamp;
  queued_at: Timestamp;
  preferences: GeneratedJson<Record<string, unknown>>;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  payer_person_id: string | null;
  status: Generated<WaitlistEntryStatus>;
  offer_count: Generated<number>;
  accepted_enrollment_id: string | null;
  withdrawn_at: NullableTimestamp;
  removed_at: NullableTimestamp;
  removal_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type WaitlistOfferStatus = 'offered' | 'accepted' | 'expired' | 'declined';
export interface WaitlistOffersTable {
  id: string;
  organization_id: string;
  waitlist_entry_id: string;
  pool_id: string;
  hold_id: string;
  quantity: number;
  offered_at: Timestamp;
  expires_at: Timestamp;
  status: Generated<WaitlistOfferStatus>;
  accepted_at: NullableTimestamp;
  accepted_basket_id: string | null;
  accepted_enrollment_id: string | null;
  accepted_session_booking_id: string | null;
  declined_at: NullableTimestamp;
  expired_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TrialParticipationStatus =
  'scheduled' | 'attended' | 'no_show' | 'canceled' | 'converted';
export interface TrialParticipationsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  session_id: string | null;
  session_booking_id: string | null;
  participant_person_id: string;
  application_id: string | null;
  status: Generated<TrialParticipationStatus>;
  scheduled_for: NullableTimestamp;
  attended_at: NullableTimestamp;
  /** Migration 0502: the no-show outcome, kept after conversion (SPK-AT-019). */
  no_show_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  follow_up_consent: Generated<boolean>;
  follow_up: GeneratedJson<Record<string, unknown>>;
  converted_enrollment_id: string | null;
  converted_basket_id: string | null;
  converted_at: NullableTimestamp;
  registered_by: Json<Record<string, unknown>>;
  registered_by_person_id: string | null;
  assisted_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EnrollmentTables {
  capacity_pools: CapacityPoolsTable;
  baskets: BasketsTable;
  applications: ApplicationsTable;
  holds: HoldsTable;
  enrollments: EnrollmentsTable;
  basket_lines: BasketLinesTable;
  placement_requests: PlacementRequestsTable;
  makeup_entitlements: MakeupEntitlementsTable;
  session_bookings: SessionBookingsTable;
  makeup_redemptions: MakeupRedemptionsTable;
  allocations: AllocationsTable;
  waitlist_entries: WaitlistEntriesTable;
  waitlist_offers: WaitlistOffersTable;
  trial_participations: TrialParticipationsTable;
}
