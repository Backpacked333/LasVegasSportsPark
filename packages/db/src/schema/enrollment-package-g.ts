import type { ColumnType, Generated } from 'kysely';
import type { GeneratedJson, GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Enrollment Package G tables (migrations 0506 to 0509; §3.16, SPK-COND-001 to SPK-COND-003,
 * SPK-YOUTH-005, SPK-YOUTH-006). Each capability is behind its organization switch (DEC-016);
 * the lifecycles are the module-local machines of `enrollment.state-machines.ts`.
 */

// ---------------------------------------------------------------------------------------------
// Session packages (0506, ENR-11)
// ---------------------------------------------------------------------------------------------
export type PackageEntitlementStatus = 'active' | 'exhausted' | 'expired' | 'revoked';
export interface PackageEntitlementsTable {
  id: string;
  organization_id: string;
  participant_person_id: string;
  enrollment_id: string;
  entitlement_definition_id: string;
  offering_id: string;
  applies_to_offering_ids: GeneratedJson<string[]>;
  applies_to_program_ids: GeneratedJson<string[]>;
  credits: number;
  redeemed_count: Generated<number>;
  status: Generated<PackageEntitlementStatus>;
  expires_at: NullableTimestamp;
  issued_at: Timestamp;
  expired_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PackageRedemptionKind = 'redeem' | 'reversal';
export interface PackageRedemptionsTable {
  id: string;
  organization_id: string;
  package_entitlement_id: string;
  session_booking_id: string;
  participant_person_id: string;
  kind: PackageRedemptionKind;
  reverses_redemption_id: string | null;
  reason: string | null;
  actor: Json<Record<string, unknown>>;
  redeemed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// Memberships (0507, ENR-12)
// ---------------------------------------------------------------------------------------------
export type MembershipSuspensionStatus = 'active' | 'ended';
export interface MembershipSuspensionsTable {
  id: string;
  organization_id: string;
  enrollment_id: string;
  participant_person_id: string;
  suspended_from: Timestamp;
  suspended_until: NullableTimestamp;
  reason: string;
  status: Generated<MembershipSuspensionStatus>;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  ended_at: NullableTimestamp;
  ended_reason: string | null;
  ended_by: Json<Record<string, unknown>> | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface MembershipBenefitUsesTable {
  id: string;
  organization_id: string;
  enrollment_id: string;
  /** `week:<YYYY-MM-DD>` (first local date of the week), `month:<YYYY-MM>` or `term`. */
  period_key: string;
  used_count: Generated<number>;
  limit_count: number;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// Rentals and parties (0508, ENR-13)
// ---------------------------------------------------------------------------------------------
export type BookingKindValue = 'rental' | 'party';
export type BookingStatusValue =
  | 'requested'
  | 'held'
  | 'awaiting_staff'
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'canceled'
  | 'completed';
export interface BookingsTable {
  id: string;
  organization_id: string;
  facility_id: string;
  offering_id: string;
  kind: BookingKindValue;
  basket_id: string | null;
  basket_line_id: string | null;
  enrollment_id: string | null;
  booker_person_id: string;
  status: Generated<BookingStatusValue>;
  first_start: Timestamp;
  last_end: Timestamp;
  occurrences: Json<Array<{ start: string; end: string }>>;
  recurrence: Json<Record<string, unknown>> | null;
  scheduling_series_id: string | null;
  scheduling_event_ids: Generated<string[]>;
  resource_ids: string[];
  equipment_asset_ids: Generated<string[]>;
  guest_count: number | null;
  booking_terms_policy_version_id: string;
  confirmation_mode: 'instant' | 'request';
  access_conditions: string | null;
  host_responsibilities: string | null;
  staffing: GeneratedJson<Array<Record<string, unknown>>>;
  pool_id: string | null;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  decided_by: Json<Record<string, unknown>> | null;
  decided_by_person_id: string | null;
  decided_at: NullableTimestamp;
  decision_reason: string | null;
  ended_at: NullableTimestamp;
  end_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

// ---------------------------------------------------------------------------------------------
// Youth progression (0509, ENR-14)
// ---------------------------------------------------------------------------------------------
export type AssessmentTemplateStatus = 'draft' | 'approved' | 'retired';
export interface AssessmentTemplatesTable {
  id: string;
  organization_id: string;
  program_id: string;
  name: string;
  version: Generated<number>;
  skill_areas: Json<Array<{ key: string; label: string }>>;
  scale: Json<{ kind: 'ordinal'; levels: string[] }>;
  status: Generated<AssessmentTemplateStatus>;
  authored_by_person_id: string | null;
  authored_by: Json<Record<string, unknown>>;
  approved_by_person_id: string | null;
  approved_at: NullableTimestamp;
  retired_at: NullableTimestamp;
  retired_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AssessmentStatus =
  'draft' | 'submitted' | 'returned' | 'published' | 'recorded' | 'withdrawn';
export type AssessmentVisibility = 'staff_only' | 'family';
export interface AssessmentsTable {
  id: string;
  organization_id: string;
  template_id: string;
  participant_person_id: string;
  offering_id: string;
  skill_area_key: string;
  /** YYYY-MM-DD */
  observed_on: ColumnType<string, string, string>;
  scale_value: number;
  comments: string | null;
  staff_note: string | null;
  visibility: AssessmentVisibility;
  status: Generated<AssessmentStatus>;
  author_person_id: string;
  author: Json<Record<string, unknown>>;
  submitted_at: NullableTimestamp;
  reviewer_person_id: string | null;
  review_note: string | null;
  reviewed_at: NullableTimestamp;
  corrects_assessment_id: string | null;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ProgressionRecommendationStatus = 'draft' | 'shared' | 'withdrawn';
export interface ProgressionRecommendationsTable {
  id: string;
  organization_id: string;
  participant_person_id: string;
  from_offering_id: string;
  recommended_offering_id: string | null;
  recommended_program_id: string | null;
  eligibility_snapshot: Json<Record<string, unknown>> | null;
  suitability: string;
  status: Generated<ProgressionRecommendationStatus>;
  author_person_id: string;
  author: Json<Record<string, unknown>>;
  shared_at: NullableTimestamp;
  withdrawn_at: NullableTimestamp;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EnrollmentPackageGTables {
  package_entitlements: PackageEntitlementsTable;
  package_redemptions: PackageRedemptionsTable;
  membership_suspensions: MembershipSuspensionsTable;
  membership_benefit_uses: MembershipBenefitUsesTable;
  bookings: BookingsTable;
  assessment_templates: AssessmentTemplatesTable;
  assessments: AssessmentsTable;
  progression_recommendations: ProgressionRecommendationsTable;
}
