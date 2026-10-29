import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  NullableTimestamp,
  Timestamp,
} from './core';
import type { DateOnly } from './identity';

/**
 * Competition module tables, part 1 (migration 0400, specification §3.4 SPK-COMP-001..005,
 * §3.5 SPK-CAP-001..005, §4.4 Competition and Matches). Results, standings, brackets and
 * discipline tables are added by part 2.
 */

export type CompetitionKind = 'league' | 'tournament';
export type SportFormat = 'outdoor' | 'indoor_boarded' | 'futsal' | 'small_sided_other';
export type CompetitionStatus = 'draft' | 'active' | 'archived';
export interface CompetitionsTable {
  id: string;
  organization_id: string;
  name: string;
  kind: CompetitionKind;
  sport_format: SportFormat;
  description: string | null;
  status: Generated<CompetitionStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RuleSetsTable {
  id: string;
  organization_id: string;
  name: string;
  format: SportFormat;
  version: number;
  content: Json<Record<string, unknown>>;
  supersedes_rule_set_id: string | null;
  created_by: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export type SeasonStatus = 'draft' | 'open' | 'active' | 'completed' | 'archived';
export interface SeasonsTable {
  id: string;
  organization_id: string;
  competition_id: string;
  name: string;
  rule_set_id: string;
  starts_on: DateOnly;
  ends_on: DateOnly;
  registration_offering_ref: string | null;
  registration_opens_at: NullableTimestamp;
  registration_closes_at: NullableTimestamp;
  status: Generated<SeasonStatus>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DivisionsTable {
  id: string;
  organization_id: string;
  season_id: string;
  name: string;
  criteria: GeneratedJson<Record<string, unknown>>;
  facility_id: string | null;
  capacity_team_entries: number | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TeamStatus = 'active' | 'inactive' | 'archived';
export interface TeamsTable {
  id: string;
  organization_id: string;
  name: string;
  colors: GeneratedJson<Record<string, unknown>>;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  status: Generated<TeamStatus>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TeamEntryStatus = 'applied' | 'approved' | 'withdrawn' | 'rejected';
export type TeamEntryEligibilityStatus = 'pending' | 'eligible' | 'ineligible' | 'review_required';
export interface TeamEntriesTable {
  id: string;
  organization_id: string;
  season_id: string;
  division_id: string | null;
  team_id: string;
  status: Generated<TeamEntryStatus>;
  applied_by: Json<Record<string, unknown>>;
  applied_by_person_id: string | null;
  applied_at: Timestamp;
  approved_at: NullableTimestamp;
  approved_by: Json<Record<string, unknown>> | null;
  approval_note: string | null;
  rejected_at: NullableTimestamp;
  rejected_by: Json<Record<string, unknown>> | null;
  rejection_reason: string | null;
  withdrawn_at: NullableTimestamp;
  withdrawn_by: Json<Record<string, unknown>> | null;
  withdrawal_reason: string | null;
  financial_status_ref: string | null;
  eligibility_status: Generated<TeamEntryEligibilityStatus>;
  eligibility_reasons: GeneratedJson<unknown[]>;
  renewed_from_entry_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TeamRoleValue = 'captain' | 'co_captain' | 'member';
export interface TeamRolesTable {
  id: string;
  organization_id: string;
  team_entry_id: string;
  person_id: string;
  role: TeamRoleValue;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  assigned_by: Json<Record<string, unknown>>;
  ended_by: Json<Record<string, unknown>> | null;
  ended_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RosterMembershipStatus =
  'invited' | 'requested' | 'active' | 'removed' | 'guest' | 'substitute';
export type RosterPlayingStatus = 'active' | 'guest' | 'substitute';
export type RosterSource =
  | 'invitation'
  | 'join_request'
  | 'captain'
  | 'staff'
  | 'renewal'
  /** A paid and approved join_team registration (SPK-AT-002, migration 0453). */
  | 'registration';
export interface RosterMembershipsTable {
  id: string;
  organization_id: string;
  team_entry_id: string;
  person_id: string;
  status: RosterMembershipStatus;
  status_before_removal: RosterPlayingStatus | null;
  effective_from: Timestamp;
  effective_to: NullableTimestamp;
  jersey_number: number | null;
  source: RosterSource;
  added_by: Json<Record<string, unknown>>;
  added_by_person_id: string | null;
  eligibility_snapshot: GeneratedJson<unknown[]>;
  removed_at: NullableTimestamp;
  removed_by: Json<Record<string, unknown>> | null;
  removal_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type TeamInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
export interface TeamInvitationsTable {
  id: string;
  organization_id: string;
  team_entry_id: string;
  invited_by: Json<Record<string, unknown>>;
  invited_by_person_id: string | null;
  recipient_person_id: string | null;
  recipient_contact_kind: 'email' | 'phone' | null;
  recipient_contact_value: string | null;
  message: string | null;
  token_hash: string;
  status: Generated<TeamInvitationStatus>;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  accepted_by_person_id: string | null;
  declined_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  roster_membership_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type JoinRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';
export interface JoinRequestsTable {
  id: string;
  organization_id: string;
  team_entry_id: string;
  person_id: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  message: string | null;
  status: Generated<JoinRequestStatus>;
  decided_by: Json<Record<string, unknown>> | null;
  decided_by_person_id: string | null;
  decided_at: NullableTimestamp;
  decision_note: string | null;
  roster_membership_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type FixtureStatus =
  'unscheduled' | 'scheduled' | 'played' | 'forfeit' | 'canceled' | 'abandoned' | 'postponed';
export interface FixturesTable {
  id: string;
  organization_id: string;
  season_id: string;
  division_id: string | null;
  round: number | null;
  home_entry_id: string;
  away_entry_id: string | null;
  scheduling_event_id: string | null;
  scheduled_start: NullableTimestamp;
  scheduled_end: NullableTimestamp;
  status: Generated<FixtureStatus>;
  notes: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AvailabilityState = 'available' | 'unavailable' | 'tentative' | 'no_response';
export interface AvailabilityResponsesTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  team_entry_id: string;
  person_id: string;
  state: AvailabilityState;
  responded_at: NullableTimestamp;
  responded_by: Json<Record<string, unknown>>;
  note: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CompetitionJson = JsonObject;

export interface CompetitionTables {
  competitions: CompetitionsTable;
  rule_sets: RuleSetsTable;
  seasons: SeasonsTable;
  divisions: DivisionsTable;
  teams: TeamsTable;
  team_entries: TeamEntriesTable;
  team_roles: TeamRolesTable;
  roster_memberships: RosterMembershipsTable;
  team_invitations: TeamInvitationsTable;
  join_requests: JoinRequestsTable;
  fixtures: FixturesTable;
  availability_responses: AvailabilityResponsesTable;
}
