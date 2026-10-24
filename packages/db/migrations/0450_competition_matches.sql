-- 0450_competition_matches.sql
-- Competition module, part 2: matches, results, standings, brackets, fixture generation, disputes
-- and discipline (specification §3.8 SPK-FIX-001..005, §3.9 SPK-READY-001..004, §3.11
-- SPK-RESULT-001..005, §3.12 SPK-DISC-001..005, §4.4 Matches and Discipline, §4.6 Result machine,
-- §4.7 invariants 8 and 9, SPK-STAFF-005, SPK-AT-010/011/013/014).
--
-- Readiness (SPK-READY-004) is derived on read from the authoritative records below and in
-- migrations 0300/0400; there is no editable "ready" row.

-- ---------------------------------------------------------------------------------------------
-- Result revisions (SPK-RESULT-001/002/004, §4.6 Result: draft → submitted → official → superseded).
-- A fixture has at most one official result (§4.7 invariant 8: publishing it requires publication
-- authority, enforced by the action) and at most one open (draft/submitted) revision. A correction
-- is a new revision that supersedes the official one; the superseded row keeps actor, reason and
-- publication time (§4.7 invariant 9: a trigger allows an official row to change only to superseded).
-- ---------------------------------------------------------------------------------------------
create table result_revisions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'official', 'superseded')),
  classification text not null check (classification in ('completed', 'forfeit', 'canceled', 'abandoned', 'postponed', 'disputed')),
  home_score integer check (home_score is null or home_score >= 0),
  away_score integer check (away_score is null or away_score >= 0),
  forfeiting_entry_id uuid,
  -- cards, abandonment details, notes and the ids of incidents reported with the result
  details jsonb not null default '{}'::jsonb,
  submitted_by jsonb not null,
  submitted_by_person_id uuid,
  submitted_at timestamptz,
  returned_at timestamptz,
  returned_by jsonb,
  return_reason text,
  published_by jsonb,
  published_by_person_id uuid,
  published_at timestamptz,
  supersedes_revision_id uuid,
  superseded_at timestamptz,
  superseded_by jsonb,
  superseded_by_revision_id uuid,
  reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, fixture_id, revision_no),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, forfeiting_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, published_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, supersedes_revision_id) references result_revisions (organization_id, id),
  foreign key (organization_id, superseded_by_revision_id) references result_revisions (organization_id, id),
  check (supersedes_revision_id is null or supersedes_revision_id <> id),
  check (classification not in ('completed', 'forfeit') or (home_score is not null and away_score is not null)),
  check (classification <> 'forfeit' or forfeiting_entry_id is not null),
  constraint result_revisions_submitted_fact check (status not in ('submitted', 'official', 'superseded') or submitted_at is not null),
  constraint result_revisions_published_fact check ((status in ('official', 'superseded')) = (published_at is not null)),
  constraint result_revisions_superseded_fact check ((status = 'superseded') = (superseded_at is not null))
);
-- Exactly one official result per fixture (§4.7 invariant 8).
create unique index result_revisions_one_official_idx on result_revisions (organization_id, fixture_id)
  where status = 'official';
-- One revision in progress per fixture: competing submissions are rejected by the database.
create unique index result_revisions_one_open_idx on result_revisions (organization_id, fixture_id)
  where status in ('draft', 'submitted');
create index result_revisions_fixture_idx on result_revisions (organization_id, fixture_id, revision_no desc);
create trigger result_revisions_touch before update on result_revisions
  for each row execute function touch_updated_at();

-- §4.7 invariant 9 "no silent rewriting of published history": an official row may only move to
-- superseded (keeping its scores, classification, actor, reason and publication time); a superseded
-- row is immutable; no revision is ever deleted.
create or replace function result_revisions_guard_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'result revisions are never deleted; a correction is a new revision'
      using errcode = 'restrict_violation', constraint = 'result_revisions_no_delete';
  end if;
  if old.status = 'superseded' then
    raise exception 'a superseded result revision is immutable history'
      using errcode = 'restrict_violation', constraint = 'result_revisions_history_immutable';
  end if;
  if old.status = 'official' then
    if new.status <> 'superseded'
       or new.home_score is distinct from old.home_score
       or new.away_score is distinct from old.away_score
       or new.classification <> old.classification
       or new.forfeiting_entry_id is distinct from old.forfeiting_entry_id
       or new.details <> old.details
       or new.submitted_by <> old.submitted_by
       or new.submitted_at is distinct from old.submitted_at
       or new.published_by is distinct from old.published_by
       or new.published_at is distinct from old.published_at
       or new.reason is distinct from old.reason
       or new.fixture_id <> old.fixture_id
       or new.revision_no <> old.revision_no then
      raise exception 'an official result may only be superseded, never rewritten'
        using errcode = 'restrict_violation', constraint = 'result_revisions_official_immutable';
    end if;
  end if;
  return new;
end
$$;
create trigger result_revisions_guard before update or delete on result_revisions
  for each row execute function result_revisions_guard_history();

-- ---------------------------------------------------------------------------------------------
-- Standings projections (SPK-RESULT-001 "official standings derive only from official results",
-- SPK-RESULT-003 versioned rule set with explained tiebreaks). Append-only: every recomputation
-- is a new row naming its source results; the latest row per scope is the current table.
-- ---------------------------------------------------------------------------------------------
create table standings_projections (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid,
  rule_set_id uuid not null,
  computed_at timestamptz not null,
  source_result_ids uuid[] not null default '{}',
  rows jsonb not null default '[]'::jsonb,
  tiebreak_explanations jsonb not null default '[]'::jsonb,
  trigger_result_id uuid,
  created_by jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id),
  foreign key (organization_id, rule_set_id) references rule_sets (organization_id, id),
  foreign key (organization_id, trigger_result_id) references result_revisions (organization_id, id)
);
create index standings_projections_scope_idx on standings_projections (organization_id, season_id, division_id, computed_at desc);
create trigger standings_projections_append_only before update or delete on standings_projections
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Bracket nodes (§4.4 BracketNode, SPK-RESULT-004 / SPK-AT-014). A node is a slot in a playoff
-- round fed by seeds or by the winner/loser of another node; once published a correction of a
-- feeding result requires management review instead of a silent rewrite.
-- ---------------------------------------------------------------------------------------------
create table bracket_nodes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid,
  name text check (name is null or length(name) between 1 and 200),
  round integer not null check (round >= 1),
  slot integer not null check (slot >= 1),
  -- { home: {kind: 'seed', seed} | {kind: 'winner_of' | 'loser_of', nodeId} | {kind: 'bye'}, away: {...} }
  source_rule jsonb not null,
  home_entry_id uuid,
  away_entry_id uuid,
  fixture_id uuid,
  winner_entry_id uuid,
  published boolean not null default false,
  published_at timestamptz,
  published_by jsonb,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, season_id, home_entry_id) references team_entries (organization_id, season_id, id),
  foreign key (organization_id, season_id, away_entry_id) references team_entries (organization_id, season_id, id),
  foreign key (organization_id, season_id, winner_entry_id) references team_entries (organization_id, season_id, id),
  check (published = (published_at is not null))
);
create unique index bracket_nodes_slot_idx on bracket_nodes (organization_id, season_id, coalesce(division_id, '00000000-0000-0000-0000-000000000000'::uuid), round, slot);
create unique index bracket_nodes_fixture_idx on bracket_nodes (organization_id, fixture_id)
  where fixture_id is not null;
create trigger bracket_nodes_touch before update on bracket_nodes
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Fixture specifications (SPK-FIX-001) and solver runs (SPK-FIX-004). A run keeps the input
-- snapshot, the rule-set version, the search settings and an honest outcome; a timeout is
-- `no_proposal_within_limit`, never `proven_infeasible`. The proposal becomes a scheduling draft
-- through the scheduling module's draft API and is never auto-published (SPK-FIX-005).
-- ---------------------------------------------------------------------------------------------
create table fixture_specifications (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid not null,
  facility_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  games_per_team integer not null check (games_per_team >= 1),
  opponent_frequency integer not null check (opponent_frequency >= 1),
  starts_on date not null,
  ends_on date not null,
  -- [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }] inclusive facility-local dates
  blackouts jsonb not null default '[]'::jsonb,
  byes_allowed boolean not null default true,
  minimum_rest_minutes integer not null default 0 check (minimum_rest_minutes >= 0),
  -- [{ weekday: 0-6, time: 'HH:MM' }]
  allowed_start_times jsonb not null default '[]'::jsonb,
  match_duration_minutes integer not null check (match_duration_minutes between 10 and 300),
  required_resource_ids uuid[] not null default '{}',
  playoff_structure jsonb,
  -- [{ kind, hard, weight }] (SPK-FIX-003: hard constraints and preferences visibly distinct)
  fairness_preferences jsonb not null default '[]'::jsonb,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check (starts_on <= ends_on)
);
create index fixture_specifications_division_idx on fixture_specifications (organization_id, division_id);
create trigger fixture_specifications_touch before update on fixture_specifications
  for each row execute function touch_updated_at();

create table solver_runs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  specification_id uuid not null,
  specification_snapshot jsonb not null,
  rule_set_id uuid not null,
  search_settings jsonb not null,
  outcome text not null check (outcome in ('feasible', 'proven_optimal', 'proven_infeasible', 'no_proposal_within_limit')),
  proposal jsonb,
  completeness_report jsonb not null,
  explanation jsonb not null default '{}'::jsonb,
  dry_run boolean not null default false,
  schedule_draft_id uuid,
  fixture_ids uuid[] not null default '{}',
  operation_id uuid,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, specification_id) references fixture_specifications (organization_id, id),
  foreign key (organization_id, rule_set_id) references rule_sets (organization_id, id),
  foreign key (organization_id, schedule_draft_id) references schedule_drafts (organization_id, id),
  check (outcome <> 'proven_infeasible' or proposal is null),
  check (started_at <= finished_at)
);
create index solver_runs_specification_idx on solver_runs (organization_id, specification_id, created_at desc);
create trigger solver_runs_touch before update on solver_runs
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Incidents (SPK-DISC-001/004/005). `summary` is a safe label; `narrative` is restricted and is
-- never returned in public results, team views or customer exports. Injury incidents record
-- operational facts only, never diagnosis or medical advice (SPK-DISC-005, DEC-063).
-- ---------------------------------------------------------------------------------------------
create table incidents (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  kind text not null check (kind in ('card', 'misconduct', 'complaint', 'operational', 'injury')),
  fixture_id uuid,
  season_id uuid,
  competition_id uuid,
  subject_person_id uuid,
  team_entry_id uuid,
  result_revision_id uuid,
  occurred_at timestamptz not null,
  minute integer check (minute is null or minute between 0 and 200),
  card_kind text check (card_kind in ('yellow', 'second_yellow', 'red')),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  summary text not null check (length(summary) between 1 and 300),
  narrative text,
  evidence_refs jsonb not null default '[]'::jsonb,
  reported_by jsonb not null,
  reported_by_person_id uuid,
  status text not null default 'open' check (status in ('open', 'under_review', 'closed')),
  closed_at timestamptz,
  closed_by jsonb,
  closure_note text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, competition_id) references competitions (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, result_revision_id) references result_revisions (organization_id, id),
  foreign key (organization_id, reported_by_person_id) references persons (organization_id, id),
  check ((kind = 'card') = (card_kind is not null)),
  check (kind <> 'card' or subject_person_id is not null),
  check ((status = 'closed') = (closed_at is not null))
);
create index incidents_fixture_idx on incidents (organization_id, fixture_id) where fixture_id is not null;
create index incidents_subject_idx on incidents (organization_id, subject_person_id) where subject_person_id is not null;
create index incidents_season_idx on incidents (organization_id, season_id, status);
create trigger incidents_touch before update on incidents
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Disciplinary decisions (SPK-DISC-003: discipline affects eligibility only through the approved
-- rule set; overrides require authorized review and keep history).
-- ---------------------------------------------------------------------------------------------
create table disciplinary_decisions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  incident_id uuid,
  subject_person_id uuid not null,
  rule_set_id uuid,
  basis text not null check (length(basis) between 1 and 2000),
  decision text not null check (decision in ('no_action', 'warning', 'suspension', 'other')),
  details jsonb not null default '{}'::jsonb,
  decided_by jsonb not null,
  decided_by_person_id uuid,
  decided_at timestamptz not null,
  status text not null default 'issued' check (status in ('issued', 'overturned')),
  overturned_at timestamptz,
  overturned_by jsonb,
  overturn_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, incident_id) references incidents (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, rule_set_id) references rule_sets (organization_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  check ((status = 'overturned') = (overturned_at is not null))
);
create index disciplinary_decisions_subject_idx on disciplinary_decisions (organization_id, subject_person_id);
create trigger disciplinary_decisions_touch before update on disciplinary_decisions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Suspensions (SPK-DISC-002): subject, basis, scope (all or named competitions — never assumed
-- to span every program), effective period or match count with matches served, approval, appeal
-- status and completion criteria. Lifecycle proposed → active → served; overturned by review.
-- ---------------------------------------------------------------------------------------------
create table suspensions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_person_id uuid not null,
  decision_id uuid,
  basis text not null check (length(basis) between 1 and 2000),
  scope text not null check (scope in ('all', 'competitions')),
  competition_ids uuid[] not null default '{}',
  effective_from timestamptz,
  effective_to timestamptz,
  match_count integer check (match_count is null or match_count >= 1),
  matches_served integer not null default 0 check (matches_served >= 0),
  served_fixture_ids uuid[] not null default '{}',
  completion_criteria text not null check (length(completion_criteria) between 1 and 2000),
  status text not null default 'proposed' check (status in ('proposed', 'active', 'served', 'overturned')),
  approved_by jsonb,
  approved_at timestamptz,
  appeal_status text not null default 'none' check (appeal_status in ('none', 'pending', 'granted', 'denied')),
  overturned_at timestamptz,
  overturned_by jsonb,
  overturn_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, decision_id) references disciplinary_decisions (organization_id, id),
  constraint suspensions_period_or_matches check (match_count is not null or effective_from is not null),
  check (effective_to is null or effective_from is null or effective_from < effective_to),
  constraint suspensions_scope_named check (scope <> 'competitions' or cardinality(competition_ids) > 0),
  constraint suspensions_approval_fact check (status not in ('active', 'served') or approved_at is not null),
  constraint suspensions_served_within_count check (match_count is null or matches_served <= match_count),
  check ((status = 'overturned') = (overturned_at is not null))
);
create index suspensions_subject_idx on suspensions (organization_id, subject_person_id, status);
create trigger suspensions_touch before update on suspensions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Disputes (SPK-RESULT-005): eligible submitting role, fixture, submission window from the rule
-- set's protest deadline, reason, evidence references, reviewer, decision, publication
-- consequence and appeal handling.
-- ---------------------------------------------------------------------------------------------
create table disputes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  result_revision_id uuid,
  submitting_team_entry_id uuid,
  submitting_role text not null check (length(submitting_role) between 1 and 50),
  submitted_by jsonb not null,
  submitted_by_person_id uuid,
  submitted_at timestamptz not null,
  submission_deadline_at timestamptz not null,
  reason text not null check (length(reason) between 1 and 4000),
  evidence_refs jsonb not null default '[]'::jsonb,
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'decided', 'withdrawn')),
  reviewer jsonb,
  reviewer_person_id uuid,
  decision text check (decision in ('upheld', 'rejected')),
  decided_at timestamptz,
  decision_reason text,
  publication_consequence text check (publication_consequence in ('none', 'result_stands', 'correction_required', 'replay_ordered')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, result_revision_id) references result_revisions (organization_id, id),
  foreign key (organization_id, submitting_team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, reviewer_person_id) references persons (organization_id, id),
  check (submitted_at <= submission_deadline_at),
  constraint disputes_decision_fact check ((status = 'decided') = (decision is not null)),
  check ((status = 'decided') = (decided_at is not null)),
  check (status <> 'decided' or publication_consequence is not null)
);
create index disputes_fixture_idx on disputes (organization_id, fixture_id, status);
create trigger disputes_touch before update on disputes
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Appeals (SPK-DISC-001/002 "appeal status", SPK-RESULT-005 "appeal handling"): against exactly
-- one decision, suspension or dispute outcome; one open appeal per target.
-- ---------------------------------------------------------------------------------------------
create table appeals (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  subject_person_id uuid not null,
  decision_id uuid,
  suspension_id uuid,
  dispute_id uuid,
  grounds text not null check (length(grounds) between 1 and 4000),
  evidence_refs jsonb not null default '[]'::jsonb,
  submitted_by jsonb not null,
  submitted_by_person_id uuid,
  submitted_at timestamptz not null,
  status text not null default 'submitted' check (status in ('submitted', 'under_review', 'granted', 'denied', 'withdrawn')),
  reviewer jsonb,
  reviewer_person_id uuid,
  decided_at timestamptz,
  decision_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, decision_id) references disciplinary_decisions (organization_id, id),
  foreign key (organization_id, suspension_id) references suspensions (organization_id, id),
  foreign key (organization_id, dispute_id) references disputes (organization_id, id),
  foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, reviewer_person_id) references persons (organization_id, id),
  constraint appeals_one_target check (
    (decision_id is not null)::integer + (suspension_id is not null)::integer + (dispute_id is not null)::integer = 1
  ),
  check ((status in ('granted', 'denied')) = (decided_at is not null))
);
create unique index appeals_open_decision_idx on appeals (organization_id, decision_id)
  where decision_id is not null and status in ('submitted', 'under_review');
create unique index appeals_open_suspension_idx on appeals (organization_id, suspension_id)
  where suspension_id is not null and status in ('submitted', 'under_review');
create unique index appeals_open_dispute_idx on appeals (organization_id, dispute_id)
  where dispute_id is not null and status in ('submitted', 'under_review');
create index appeals_subject_idx on appeals (organization_id, subject_person_id, status);
create trigger appeals_touch before update on appeals
  for each row execute function touch_updated_at();
