import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Enrollment rental-group roster tables (migration 0530; SPK-COND-005, proposed amendment PA-09,
 * DEC-103; capability `rental_rosters`). The lifecycles are the module-local machines of
 * `enrollment.state-machines.ts`.
 */
export type BookingRosterMemberStatus = 'invited' | 'joined' | 'removed';
export type BookingRosterContactKind = 'email' | 'phone';
export interface BookingRosterMembersTable {
  id: string;
  organization_id: string;
  booking_id: string;
  /** Null while the row is an invitation to a contact nobody has accepted yet. */
  person_id: string | null;
  invited_contact_kind: BookingRosterContactKind | null;
  invited_contact_value: string | null;
  status: Generated<BookingRosterMemberStatus>;
  added_by: Json<Record<string, unknown>>;
  added_by_person_id: string | null;
  joined_at: NullableTimestamp;
  removed_at: NullableTimestamp;
  removed_by: Json<Record<string, unknown>> | null;
  removal_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type BookingRosterInvitationStatus =
  'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
export interface BookingRosterInvitationsTable {
  id: string;
  organization_id: string;
  booking_id: string;
  member_id: string;
  invited_by: Json<Record<string, unknown>>;
  invited_by_person_id: string | null;
  recipient_person_id: string | null;
  recipient_contact_kind: BookingRosterContactKind | null;
  recipient_contact_value: string | null;
  message: string | null;
  token_hash: string;
  status: Generated<BookingRosterInvitationStatus>;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  accepted_by_person_id: string | null;
  declined_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revoked_by: Json<Record<string, unknown>> | null;
  revocation_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface EnrollmentRostersTables {
  booking_roster_members: BookingRosterMembersTable;
  booking_roster_invitations: BookingRosterInvitationsTable;
}
