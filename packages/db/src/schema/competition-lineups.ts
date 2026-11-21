import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';

/**
 * Competition module: a side's lineup for a fixture and the coach's game log with each player's
 * minutes (migration 0475; SPK-CAP-001, SPK-CAP-003, SPK-UX-007, SPK-RESULT-001).
 */
export type GameLogEventKind = 'goal' | 'opponent_goal' | 'substitution' | 'half_time';

export interface GameLogEventRow {
  kind: GameLogEventKind;
  minute: number;
  personId?: string | null;
  assistPersonId?: string | null;
  offPersonId?: string | null;
  onPersonId?: string | null;
}

export interface FixtureLineupsTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  team_entry_id: string;
  formation: string;
  shared_at: NullableTimestamp;
  shared_by: Json<Record<string, unknown>> | null;
  shared_revision: number | null;
  updated_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FixtureLineupSlotsTable {
  organization_id: string;
  lineup_id: string;
  slot: number;
  person_id: string;
}

export interface FixtureGameLogsTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  team_entry_id: string;
  home_score: number;
  away_score: number;
  events: Json<GameLogEventRow[]>;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string | null;
  recorded_at: Timestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FixturePlayerMinutesTable {
  organization_id: string;
  game_log_id: string;
  team_entry_id: string;
  person_id: string;
  minutes: number;
}

export interface CompetitionLineupsTables {
  fixture_lineups: FixtureLineupsTable;
  fixture_lineup_slots: FixtureLineupSlotsTable;
  fixture_game_logs: FixtureGameLogsTable;
  fixture_player_minutes: FixturePlayerMinutesTable;
}
