import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, Timestamp } from './core';

/**
 * Competition module tables for placement and field-side work (migrations 0464 to 0466): staff
 * player profiles for placement balance (SPK-PLACE-002), fixture attendance marks on the match
 * sheet (SPK-UX-007, SPK-STAFF-005) and result reminders to captains (SPK-RESULT-001).
 */

export type PlayerPosition = 'goalkeeper' | 'defender' | 'midfielder' | 'forward' | 'outfield';
export type FixtureAttendanceState = 'present' | 'absent' | 'cleared';

/** Migration 0464: one staff profile per season and person (revisioned, never deleted). */
export interface SeasonPlayerProfilesTable {
  id: string;
  organization_id: string;
  season_id: string;
  person_id: string;
  position: PlayerPosition | null;
  skill_rating: number | null;
  note: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  recorded_at: Timestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** Migration 0465: append-only attendance marks; a player's state is the mark nobody supersedes. */
export interface FixtureAttendanceMarksTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  team_entry_id: string;
  person_id: string;
  state: FixtureAttendanceState;
  /** The mark this one supersedes (null for a player's first mark of the fixture side). */
  supersedes_mark_id: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  recorded_at: Timestamp;
  created_at: GeneratedTimestamp;
}

/** Migration 0466: append-only reminders to a fixture's captains that its result is missing. */
export interface ResultRemindersTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  message: string | null;
  requested_at: Timestamp;
  recipient_count: number;
  created_at: GeneratedTimestamp;
}

export interface CompetitionFieldTables {
  season_player_profiles: SeasonPlayerProfilesTable;
  fixture_attendance_marks: FixtureAttendanceMarksTable;
  result_reminders: ResultRemindersTable;
}
