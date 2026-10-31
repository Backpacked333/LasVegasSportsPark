import type { Generated } from 'kysely';
import type { GeneratedJson, GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';
import type { DateOnly } from './identity';

/**
 * Competition module tables, part 2 (migration 0450, specification §3.8 SPK-FIX-001..005, §3.9
 * SPK-READY-001..004, §3.11 SPK-RESULT-001..005, §3.12 SPK-DISC-001..005, §4.4 Matches and
 * Discipline). Part 1 (migration 0400) owns competitions, seasons, divisions, teams, entries,
 * rosters and fixtures in `./competition.ts`.
 */

export type ResultRevisionStatus = 'draft' | 'submitted' | 'official' | 'superseded';
export type ResultClassification =
  'completed' | 'forfeit' | 'canceled' | 'abandoned' | 'postponed' | 'disputed';
export interface ResultRevisionsTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  revision_no: number;
  status: Generated<ResultRevisionStatus>;
  classification: ResultClassification;
  home_score: number | null;
  away_score: number | null;
  forfeiting_entry_id: string | null;
  /** CMP-10 (migration 0457): the shootout winner of a drawn playoff game. */
  shootout_winner_entry_id: Generated<string | null>;
  details: GeneratedJson<Record<string, unknown>>;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  submitted_at: NullableTimestamp;
  returned_at: NullableTimestamp;
  returned_by: Json<Record<string, unknown>> | null;
  return_reason: string | null;
  published_by: Json<Record<string, unknown>> | null;
  published_by_person_id: string | null;
  published_at: NullableTimestamp;
  supersedes_revision_id: string | null;
  superseded_at: NullableTimestamp;
  superseded_by: Json<Record<string, unknown>> | null;
  superseded_by_revision_id: string | null;
  reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface StandingsProjectionsTable {
  id: string;
  organization_id: string;
  season_id: string;
  division_id: string | null;
  rule_set_id: string;
  rule_set_version: number;
  computed_at: Timestamp;
  source_result_ids: Generated<string[]>;
  rows: GeneratedJson<unknown[]>;
  tiebreak_explanations: GeneratedJson<unknown[]>;
  trigger_result_id: string | null;
  created_by: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export interface BracketNodesTable {
  id: string;
  organization_id: string;
  season_id: string;
  division_id: string | null;
  name: string | null;
  round: number;
  slot: number;
  source_rule: Json<Record<string, unknown>>;
  home_entry_id: string | null;
  away_entry_id: string | null;
  fixture_id: string | null;
  winner_entry_id: string | null;
  published: Generated<boolean>;
  published_at: NullableTimestamp;
  published_by: Json<Record<string, unknown>> | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FixtureSpecificationsTable {
  id: string;
  organization_id: string;
  season_id: string;
  division_id: string;
  facility_id: string;
  name: string;
  games_per_team: number;
  opponent_frequency: number;
  starts_on: DateOnly;
  ends_on: DateOnly;
  blackouts: GeneratedJson<unknown[]>;
  byes_allowed: Generated<boolean>;
  minimum_rest_minutes: Generated<number>;
  allowed_start_times: GeneratedJson<unknown[]>;
  match_duration_minutes: number;
  required_resource_ids: Generated<string[]>;
  playoff_structure: Json<Record<string, unknown>> | null;
  fairness_preferences: GeneratedJson<unknown[]>;
  /** CMP-15 (migration 0459): compressed play, both optional. */
  max_games_per_team_per_day: Generated<number | null>;
  officials_per_game: Generated<number | null>;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type SolverOutcome =
  'feasible' | 'proven_optimal' | 'proven_infeasible' | 'no_proposal_within_limit';
export interface SolverRunsTable {
  id: string;
  organization_id: string;
  specification_id: string;
  specification_snapshot: Json<Record<string, unknown>>;
  rule_set_id: string;
  search_settings: Json<Record<string, unknown>>;
  outcome: SolverOutcome;
  proposal: Json<Record<string, unknown>> | null;
  completeness_report: Json<Record<string, unknown>>;
  explanation: GeneratedJson<Record<string, unknown>>;
  dry_run: Generated<boolean>;
  schedule_draft_id: string | null;
  fixture_ids: Generated<string[]>;
  operation_id: string | null;
  started_at: Timestamp;
  finished_at: Timestamp;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type IncidentKind = 'card' | 'misconduct' | 'complaint' | 'operational' | 'injury';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'under_review' | 'closed';
export type CardKind = 'yellow' | 'second_yellow' | 'red';
export interface IncidentsTable {
  id: string;
  organization_id: string;
  kind: IncidentKind;
  fixture_id: string | null;
  season_id: string | null;
  competition_id: string | null;
  subject_person_id: string | null;
  team_entry_id: string | null;
  result_revision_id: string | null;
  occurred_at: Timestamp;
  minute: number | null;
  card_kind: CardKind | null;
  severity: IncidentSeverity;
  summary: string;
  narrative: string | null;
  evidence_refs: GeneratedJson<unknown[]>;
  reported_by: Json<Record<string, unknown>>;
  reported_by_person_id: string | null;
  status: Generated<IncidentStatus>;
  closed_at: NullableTimestamp;
  closed_by: Json<Record<string, unknown>> | null;
  closure_note: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type DisciplinaryDecisionKind = 'no_action' | 'warning' | 'suspension' | 'other';
export type DisciplinaryDecisionStatus = 'issued' | 'overturned';
export interface DisciplinaryDecisionsTable {
  id: string;
  organization_id: string;
  incident_id: string | null;
  subject_person_id: string;
  rule_set_id: string | null;
  basis: string;
  decision: DisciplinaryDecisionKind;
  details: GeneratedJson<Record<string, unknown>>;
  decided_by: Json<Record<string, unknown>>;
  decided_by_person_id: string | null;
  decided_at: Timestamp;
  status: Generated<DisciplinaryDecisionStatus>;
  overturned_at: NullableTimestamp;
  overturned_by: Json<Record<string, unknown>> | null;
  overturn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type SuspensionScope = 'all' | 'competitions';
export type SuspensionStatus = 'proposed' | 'active' | 'served' | 'overturned';
export type AppealStatusSummary = 'none' | 'pending' | 'granted' | 'denied';
export type SuspensionSourceKind = 'manual' | 'red_card' | 'yellow_accumulation';
export interface SuspensionsTable {
  id: string;
  organization_id: string;
  subject_person_id: string;
  decision_id: string | null;
  basis: string;
  scope: SuspensionScope;
  competition_ids: Generated<string[]>;
  effective_from: NullableTimestamp;
  effective_to: NullableTimestamp;
  match_count: number | null;
  matches_served: Generated<number>;
  served_fixture_ids: Generated<string[]>;
  completion_criteria: string;
  source_kind: Generated<SuspensionSourceKind>;
  source_fixture_id: string | null;
  source_result_revision_id: string | null;
  status: Generated<SuspensionStatus>;
  approved_by: Json<Record<string, unknown>> | null;
  approved_at: NullableTimestamp;
  appeal_status: Generated<AppealStatusSummary>;
  overturned_at: NullableTimestamp;
  overturned_by: Json<Record<string, unknown>> | null;
  overturn_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type DisputeStatus = 'submitted' | 'under_review' | 'decided' | 'withdrawn';
export type DisputeDecision = 'upheld' | 'rejected';
export type PublicationConsequence =
  'none' | 'result_stands' | 'correction_required' | 'replay_ordered';
export interface DisputesTable {
  id: string;
  organization_id: string;
  fixture_id: string;
  result_revision_id: string | null;
  submitting_team_entry_id: string | null;
  submitting_role: string;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  submitted_at: Timestamp;
  submission_deadline_at: Timestamp;
  reason: string;
  evidence_refs: GeneratedJson<unknown[]>;
  status: Generated<DisputeStatus>;
  reviewer: Json<Record<string, unknown>> | null;
  reviewer_person_id: string | null;
  decision: DisputeDecision | null;
  decided_at: NullableTimestamp;
  decision_reason: string | null;
  publication_consequence: PublicationConsequence | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AppealStatus = 'submitted' | 'under_review' | 'granted' | 'denied' | 'withdrawn';
export interface AppealsTable {
  id: string;
  organization_id: string;
  subject_person_id: string;
  decision_id: string | null;
  suspension_id: string | null;
  dispute_id: string | null;
  grounds: string;
  evidence_refs: GeneratedJson<unknown[]>;
  submitted_by: Json<Record<string, unknown>>;
  submitted_by_person_id: string | null;
  submitted_at: Timestamp;
  status: Generated<AppealStatus>;
  reviewer: Json<Record<string, unknown>> | null;
  reviewer_person_id: string | null;
  decided_at: NullableTimestamp;
  decision_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CompetitionMatchesTables {
  result_revisions: ResultRevisionsTable;
  standings_projections: StandingsProjectionsTable;
  bracket_nodes: BracketNodesTable;
  fixture_specifications: FixtureSpecificationsTable;
  solver_runs: SolverRunsTable;
  incidents: IncidentsTable;
  disciplinary_decisions: DisciplinaryDecisionsTable;
  suspensions: SuspensionsTable;
  disputes: DisputesTable;
  appeals: AppealsTable;
}
