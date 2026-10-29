import type { Generated } from 'kysely';
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

export interface EnrollmentPackageGTables {
  package_entitlements: PackageEntitlementsTable;
  package_redemptions: PackageRedemptionsTable;
  membership_suspensions: MembershipSuspensionsTable;
  membership_benefit_uses: MembershipBenefitUsesTable;
}
