import type { ColumnType, Generated } from 'kysely';
import type { GeneratedJson, GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Identity module tables (migrations 0100-0102, specification §3.1 SPK-IAM-001..007).
 * `date` columns are read through a `::text` cast by the module so both drivers return
 * `YYYY-MM-DD`; the type below documents that contract.
 */
export type DateOnly = ColumnType<string, string, string>;

export type PersonKind = 'adult' | 'child';
export type PersonStatus = 'active' | 'inactive' | 'merged';
export type PersonSource = 'staff' | 'self_service' | 'import';
export interface PersonsTable {
  id: string;
  organization_id: string;
  kind: PersonKind;
  given_name: string;
  family_name: string;
  date_of_birth: DateOnly | null;
  status: Generated<PersonStatus>;
  merged_into_person_id: string | null;
  source: PersonSource;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ContactPointKind = 'email' | 'phone';
export interface ContactPointsTable {
  id: string;
  organization_id: string;
  person_id: string;
  kind: ContactPointKind;
  value: string;
  is_primary: Generated<boolean>;
  verified_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AccountStatus = 'active' | 'disabled';
export interface AccountsTable {
  id: string;
  organization_id: string;
  issuer: string;
  subject: string;
  person_id: string | null;
  status: Generated<AccountStatus>;
  last_login_at: NullableTimestamp;
  disabled_at: NullableTimestamp;
  disabled_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HouseholdsTable {
  id: string;
  organization_id: string;
  name: string;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface HouseholdMembershipsTable {
  id: string;
  organization_id: string;
  household_id: string;
  person_id: string;
  label: string | null;
  added_by: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export type RelationshipKind = 'guardian' | 'delegate' | 'caregiver' | 'self_managed';
export type RelationshipStatus = 'active' | 'suspended' | 'ended';
export type AuthoritySource =
  'staff' | 'self_service' | 'invitation' | 'claim' | 'review' | 'import';
export interface RelationshipsTable {
  id: string;
  organization_id: string;
  actor_person_id: string;
  subject_person_id: string;
  kind: RelationshipKind;
  status: Generated<RelationshipStatus>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  source: AuthoritySource;
  created_by: Json<Record<string, unknown>>;
  ended_at: NullableTimestamp;
  ended_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type GrantPermissionValue =
  'view' | 'register' | 'pay' | 'receive_messages' | 'complete_forms' | 'collect';
export interface AccessGrantsTable {
  id: string;
  organization_id: string;
  relationship_id: string;
  actor_person_id: string;
  subject_person_id: string;
  permission: GrantPermissionValue;
  source: AuthoritySource;
  granted_by: Json<Record<string, unknown>>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  suspended_at: NullableTimestamp;
  /** Migration 0102: end of a temporary restriction (SPK-IAM-005); null until lifted. */
  suspended_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  suspended_by_review_id: string | null;
  suspension_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type InvitationScopeType = 'person' | 'household';
export type InvitationRelationshipKind = Exclude<RelationshipKind, 'self_managed'>;
export interface InvitationsTable {
  id: string;
  organization_id: string;
  invited_by: Json<Record<string, unknown>>;
  invited_by_person_id: string | null;
  recipient_person_id: string | null;
  recipient_contact_kind: ContactPointKind | null;
  recipient_contact_value: string | null;
  scope_type: InvitationScopeType;
  scope_person_id: string | null;
  scope_household_id: string | null;
  relationship_kind: InvitationRelationshipKind;
  requested_permissions: GrantPermissionValue[];
  token_hash: string;
  status: Generated<InvitationStatus>;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  accepted_by_person_id: string | null;
  granted_permissions: Generated<GrantPermissionValue[]>;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/**
 * Migration 0101: the people an invitation covers, fixed at issue (SPK-IAM-004, §4.5).
 * Append-only.
 */
export interface InvitationSubjectsTable {
  organization_id: string;
  invitation_id: string;
  person_id: string;
  created_at: GeneratedTimestamp;
}

export type ClaimKind = 'self' | 'guardian';
export type ClaimStatus = InvitationStatus;
export interface ClaimsTable {
  id: string;
  organization_id: string;
  subject_person_id: string;
  kind: ClaimKind;
  requested_permissions: Generated<GrantPermissionValue[]>;
  issued_by: Json<Record<string, unknown>>;
  recipient_contact_kind: ContactPointKind | null;
  recipient_contact_value: string | null;
  token_hash: string;
  status: Generated<ClaimStatus>;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  accepted_by_account_id: string | null;
  accepted_by_person_id: string | null;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type StaffMembershipStatus = 'active' | 'ended';
export interface StaffMembershipsTable {
  id: string;
  organization_id: string;
  person_id: string;
  roles: string[];
  facility_ids: Generated<string[]>;
  status: Generated<StaffMembershipStatus>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  ended_at: NullableTimestamp;
  ended_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AccessReviewStatus = 'open' | 'escalated' | 'decided' | 'closed';
export type AccessReviewOwnerRole = 'general_manager' | 'system_administrator' | 'support_operator';
export interface AccessReviewsTable {
  id: string;
  organization_id: string;
  subject_person_id: string;
  opened_by: Json<Record<string, unknown>>;
  opened_by_person_id: string | null;
  reason: string;
  parties: GeneratedJson<unknown[]>;
  evidence: GeneratedJson<unknown[]>;
  owner_role: AccessReviewOwnerRole;
  owner_person_id: string | null;
  status: Generated<AccessReviewStatus>;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  escalated_at: NullableTimestamp;
  decided_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  outcome: Json<Record<string, unknown>> | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AccessReviewDecisionKind =
  'restrict' | 'lift' | 'escalate' | 'decide' | 'close' | 'note' | 'reassign';
export interface AccessReviewDecisionsTable {
  id: string;
  organization_id: string;
  review_id: string;
  sequence: number;
  kind: AccessReviewDecisionKind;
  decided_by: Json<Record<string, unknown>>;
  note: string | null;
  affected_grant_ids: Generated<string[]>;
  effective_from: NullableTimestamp;
  effective_to: NullableTimestamp;
  details: GeneratedJson<Record<string, unknown>>;
  occurred_at: GeneratedTimestamp;
}

export type DuplicateCandidateStatus = 'open' | 'merged' | 'dismissed';
export interface DuplicateCandidatesTable {
  id: string;
  organization_id: string;
  person_a_id: string;
  person_b_id: string;
  reasons: string[];
  score: number;
  status: Generated<DuplicateCandidateStatus>;
  flagged_by: Json<Record<string, unknown>>;
  decision: Json<Record<string, unknown>> | null;
  decided_by: Json<Record<string, unknown>> | null;
  decided_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonMergesTable {
  id: string;
  organization_id: string;
  survivor_person_id: string;
  merged_person_id: string;
  candidate_id: string | null;
  moved: Json<Record<string, unknown>>;
  actor: Json<Record<string, unknown>>;
  reason: string | null;
  operation_id: string | null;
  occurred_at: GeneratedTimestamp;
}

export interface IdentityTables {
  persons: PersonsTable;
  contact_points: ContactPointsTable;
  accounts: AccountsTable;
  households: HouseholdsTable;
  household_memberships: HouseholdMembershipsTable;
  relationships: RelationshipsTable;
  access_grants: AccessGrantsTable;
  invitations: InvitationsTable;
  invitation_subjects: InvitationSubjectsTable;
  claims: ClaimsTable;
  staff_memberships: StaffMembershipsTable;
  access_reviews: AccessReviewsTable;
  access_review_decisions: AccessReviewDecisionsTable;
  duplicate_candidates: DuplicateCandidatesTable;
  person_merges: PersonMergesTable;
}
