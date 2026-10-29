import type { ColumnType, Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  MinorUnits,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Catalog module tables (migrations 0200 to 0207, specification §3.2 SPK-CAT-001..004, §3.15
 * SPK-PAY-001..003, §4.4 Catalog + Policies). `date` columns are read through a `::text` cast by
 * the module so both drivers return `YYYY-MM-DD`.
 */
export type CatalogDate = ColumnType<string, string, string>;

export type ProgramStatus = 'draft' | 'active' | 'archived';
/** CAT-03 (migration 0206): staff-created or written by the migration import of one batch. */
export type ProgramSource = 'staff' | 'import';
export interface ProgramsTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  activity_type: string;
  format: string | null;
  age_band: GeneratedJson<Record<string, unknown>>;
  status: Generated<ProgramStatus>;
  source: Generated<ProgramSource>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PolicyKind =
  | 'eligibility'
  | 'cancellation'
  | 'refund'
  | 'discount'
  | 'waitlist'
  | 'hold'
  | 'approval'
  | 'form'
  | 'overpayment'
  | 'installment'
  | 'booking_terms'
  | 'tax_fee';
export type PolicyApprovalStatus = 'draft' | 'approved' | 'retired';
export interface PolicyVersionsTable {
  id: string;
  organization_id: string;
  kind: PolicyKind;
  key: string;
  version: number;
  title: string;
  content: Json<Record<string, unknown>>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  approval_status: Generated<PolicyApprovalStatus>;
  approved_by: Json<Record<string, unknown>> | null;
  approved_at: NullableTimestamp;
  retired_at: NullableTimestamp;
  retired_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ApprovalSubjectType = 'policy_version' | 'offering_publication';
export type ApprovalDecision = 'approved' | 'rejected';
export interface ApprovalsTable {
  id: string;
  organization_id: string;
  subject_type: ApprovalSubjectType;
  subject_id: string;
  decision: ApprovalDecision;
  actor: Json<Record<string, unknown>>;
  actor_person_id: string | null;
  reason: string | null;
  details: GeneratedJson<Record<string, unknown>>;
  occurred_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type AcknowledgmentBasis = 'self' | 'guardian';
export type AcknowledgmentStatus = 'active' | 'withdrawn';
export type RecordedByKind = 'customer' | 'staff' | 'system';
export interface AcknowledgmentsTable {
  id: string;
  organization_id: string;
  subject_person_id: string;
  policy_version_id: string;
  signed_by_person_id: string;
  basis: AcknowledgmentBasis;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_kind: RecordedByKind;
  recorded_by_person_id: string | null;
  signed_at: Timestamp;
  evidence: GeneratedJson<Record<string, unknown>>;
  status: Generated<AcknowledgmentStatus>;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type EntitlementKind =
  | 'team_entry'
  | 'roster_place'
  | 'seat'
  | 'session_seat'
  | 'camp_group_place'
  | 'rental_resource'
  | 'package_credits'
  | 'membership_benefit'
  | 'party_package';
export type EquivalenceScope = 'offering' | 'program' | 'program_period' | 'session' | 'none';
export type EntitlementDefinitionStatus = 'active' | 'archived';
export interface EntitlementDefinitionsTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  kind: EntitlementKind;
  scope: GeneratedJson<Record<string, unknown>>;
  equivalence_scope: EquivalenceScope;
  equivalence_rule: GeneratedJson<Record<string, unknown>>;
  status: Generated<EntitlementDefinitionStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type OfferingKind =
  | 'season'
  | 'term'
  | 'camp'
  | 'session'
  | 'trial'
  | 'makeup'
  | 'pickup'
  | 'private_coaching'
  | 'rental'
  | 'package'
  | 'membership'
  | 'party';
export type PublicationState =
  'draft' | 'published' | 'registration_open' | 'registration_paused' | 'closed' | 'archived';
export interface OfferingsTable {
  id: string;
  organization_id: string;
  program_id: string;
  facility_id: string;
  name: string;
  description: string | null;
  kind: OfferingKind;
  activity_type: string;
  format: string | null;
  location: GeneratedJson<Record<string, unknown>>;
  starts_on: CatalogDate;
  ends_on: CatalogDate;
  registration_opens_at: NullableTimestamp;
  registration_closes_at: NullableTimestamp;
  eligibility_reference_date: CatalogDate | null;
  eligibility_policy_version_id: string | null;
  entitlement_definition_id: string | null;
  capacity_units: GeneratedJson<unknown[]>;
  cancellation_policy_version_id: string | null;
  responsible_manager_person_id: string | null;
  publication_state: Generated<PublicationState>;
  published_at: NullableTimestamp;
  registration_opened_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  archived_at: NullableTimestamp;
  copied_from_offering_id: string | null;
  /** CAT-02 (migration 0205): the booking_terms policy family of a rental or party offering. */
  booking_terms_key: Generated<string | null>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OfferingRequiredFormsTable {
  organization_id: string;
  offering_id: string;
  policy_version_id: string;
  sequence: Generated<number>;
}

export type OfferingSessionStatus = 'scheduled' | 'canceled' | 'completed';
export interface OfferingSessionsTable {
  id: string;
  organization_id: string;
  offering_id: string;
  sequence: number;
  title: string | null;
  scheduled_start: Timestamp;
  scheduled_end: Timestamp;
  scheduling_event_id: string | null;
  capacity_override: Json<JsonObject> | null;
  status: Generated<OfferingSessionStatus>;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PriceRulesTable {
  id: string;
  organization_id: string;
  offering_id: string;
  version: number;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  base_price_minor: MinorUnits;
  currency: string;
  charge_lines: GeneratedJson<unknown[]>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type DiscountKind = 'promo_code' | 'automatic';
export type DiscountAmountKind = 'percentage' | 'fixed';
export type StackingRule = 'exclusive' | 'stackable';
export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';
export type AllocationMethod = 'proportional' | 'largest_first' | 'first_line' | 'even';
export type DiscountStatus = 'draft' | 'active' | 'retired';
export interface DiscountDefinitionsTable {
  id: string;
  organization_id: string;
  code: string | null;
  name: string;
  description: string | null;
  kind: DiscountKind;
  amount_kind: DiscountAmountKind;
  amount_value: MinorUnits;
  currency: string | null;
  eligibility_rules: GeneratedJson<Record<string, unknown>>;
  stacking_rule: Generated<StackingRule>;
  stacking_priority: Generated<number>;
  cap_minor: MinorUnits | null;
  redemption_limit: number | null;
  per_person_limit: number | null;
  rounding: Generated<RoundingMode>;
  allocation_method: Generated<AllocationMethod>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  status: Generated<DiscountStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DiscountRedemptionsTable {
  organization_id: string;
  discount_definition_id: string;
  redemption_limit: number | null;
  redeemed_count: Generated<number>;
  updated_at: GeneratedTimestamp;
}

export type RedemptionEntryKind = 'redeem' | 'release';
export interface DiscountRedemptionEntriesTable {
  id: string;
  organization_id: string;
  discount_definition_id: string;
  kind: RedemptionEntryKind;
  reference_type: string;
  reference_id: string;
  person_id: string | null;
  amount_minor: MinorUnits | null;
  currency: string | null;
  actor: Json<Record<string, unknown>>;
  occurred_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface CatalogTables {
  programs: ProgramsTable;
  policy_versions: PolicyVersionsTable;
  approvals: ApprovalsTable;
  acknowledgments: AcknowledgmentsTable;
  entitlement_definitions: EntitlementDefinitionsTable;
  offerings: OfferingsTable;
  offering_required_forms: OfferingRequiredFormsTable;
  offering_sessions: OfferingSessionsTable;
  price_rules: PriceRulesTable;
  discount_definitions: DiscountDefinitionsTable;
  discount_redemptions: DiscountRedemptionsTable;
  discount_redemption_entries: DiscountRedemptionEntriesTable;
}
