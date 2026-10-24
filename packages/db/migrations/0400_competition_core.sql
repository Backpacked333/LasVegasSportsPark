-- 0400_competition_core.sql
-- Competition module, part 1: the core model (specification §3.4 SPK-COMP-001..005, §3.5
-- SPK-CAP-001..005, §4.4 Competition (League, Season, Division, Team, TeamEntry,
-- RosterMembership) and Matches (Fixture), §4.5 "Team must separate continuing identity from
-- season entry", SPK-AT-002/003/013 roster parts).
--
-- Model (SPK-COMP-001): a competition (league or tournament) runs seasons; a season is played
-- under one immutable rule-set version and is divided into divisions; a team is a continuing
-- identity across seasons; a team entry is that team's participation in one season; roster
-- memberships and team roles hang off the entry and are effective-dated so history is never
-- rewritten (SPK-COMP-005, SPK-AT-003); fixtures pair two entries of a season. Results, standings,
-- brackets and discipline are part 2 (migrations 0450+).

-- ---------------------------------------------------------------------------------------------
-- Competitions
-- ---------------------------------------------------------------------------------------------
create table competitions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('league', 'tournament')),
  sport_format text not null check (sport_format in ('outdoor', 'indoor_boarded', 'futsal', 'small_sided_other')),
  description text,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name)
);
create trigger competitions_touch before update on competitions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Rule sets (SPK-COMP-002). A rule set is immutable: a change is a new version row that names the
-- version it supersedes. `content` is validated per format by the contracts (fields irrelevant to
-- a format are null). Append-only: forbid_mutation.
-- ---------------------------------------------------------------------------------------------
create table rule_sets (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  format text not null check (format in ('outdoor', 'indoor_boarded', 'futsal', 'small_sided_other')),
  version integer not null check (version >= 1),
  content jsonb not null,
  supersedes_rule_set_id uuid,
  created_by jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name, version),
  foreign key (organization_id, supersedes_rule_set_id) references rule_sets (organization_id, id),
  check (supersedes_rule_set_id is null or supersedes_rule_set_id <> id),
  check ((version = 1) = (supersedes_rule_set_id is null))
);
create index rule_sets_name_idx on rule_sets (organization_id, name, version desc);
create trigger rule_sets_append_only before update or delete on rule_sets
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Seasons. Registration window references the catalog offering by id only (no cross-module FK).
-- ---------------------------------------------------------------------------------------------
create table seasons (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  competition_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  rule_set_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  registration_offering_ref text,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'open', 'active', 'completed', 'archived')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, competition_id, name),
  foreign key (organization_id, competition_id) references competitions (organization_id, id),
  foreign key (organization_id, rule_set_id) references rule_sets (organization_id, id),
  check (starts_on <= ends_on),
  check (registration_opens_at is null or registration_closes_at is null or registration_opens_at < registration_closes_at)
);
create index seasons_competition_idx on seasons (organization_id, competition_id, status);
create trigger seasons_touch before update on seasons
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Divisions (SPK-COMP-003): documented criteria (age band, level, category, location, format),
-- never informal labels alone. `facility_id` is the location criterion with a real reference.
-- ---------------------------------------------------------------------------------------------
create table divisions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  criteria jsonb not null default '{}'::jsonb,
  facility_id uuid,
  capacity_team_entries integer check (capacity_team_entries is null or capacity_team_entries >= 1),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- lets a team entry or fixture reference a division of its own season only
  unique (organization_id, season_id, id),
  unique (organization_id, season_id, name),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create trigger divisions_touch before update on divisions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Teams: the continuing identity (§4.5). Nothing season-specific lives here.
-- ---------------------------------------------------------------------------------------------
create table teams (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  colors jsonb not null default '{}'::jsonb,
  created_by jsonb not null,
  created_by_person_id uuid,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id)
);
create index teams_name_idx on teams (organization_id, lower(name));
create trigger teams_touch before update on teams
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Team entries (SPK-COMP-004): approval, financial status, roster completion and eligibility are
-- distinct. Roster completion is derived (never stored). financial_status_ref is set by finance.
-- ---------------------------------------------------------------------------------------------
create table team_entries (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid,
  team_id uuid not null,
  status text not null default 'applied' check (status in ('applied', 'approved', 'withdrawn', 'rejected')),
  applied_by jsonb not null,
  applied_by_person_id uuid,
  applied_at timestamptz not null,
  approved_at timestamptz,
  approved_by jsonb,
  approval_note text,
  rejected_at timestamptz,
  rejected_by jsonb,
  rejection_reason text,
  withdrawn_at timestamptz,
  withdrawn_by jsonb,
  withdrawal_reason text,
  financial_status_ref text,
  eligibility_status text not null default 'pending' check (eligibility_status in ('pending', 'eligible', 'ineligible', 'review_required')),
  eligibility_reasons jsonb not null default '[]'::jsonb,
  renewed_from_entry_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, season_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id),
  foreign key (organization_id, team_id) references teams (organization_id, id),
  foreign key (organization_id, applied_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, renewed_from_entry_id) references team_entries (organization_id, id),
  check (renewed_from_entry_id is null or renewed_from_entry_id <> id),
  -- The status and its facts agree: a state requires its fact; a fact exists only in the states the
  -- machine reaches through it (an approved entry that withdraws keeps its approval as history).
  constraint team_entries_approval_fact check (status <> 'approved' or approved_at is not null),
  constraint team_entries_rejection_fact check (status <> 'rejected' or rejected_at is not null),
  constraint team_entries_withdrawal_fact check (status <> 'withdrawn' or withdrawn_at is not null),
  constraint team_entries_no_stale_approval check (status in ('approved', 'withdrawn') or approved_at is null),
  constraint team_entries_no_stale_rejection check (status = 'rejected' or rejected_at is null),
  constraint team_entries_no_stale_withdrawal check (status = 'withdrawn' or withdrawn_at is null)
);
-- One live entry per team per season (§4.7 invariant 2: no equivalent duplicate active entitlement).
create unique index team_entries_live_idx on team_entries (organization_id, season_id, team_id)
  where status in ('applied', 'approved');
create index team_entries_season_idx on team_entries (organization_id, season_id, status);
create index team_entries_division_idx on team_entries (organization_id, division_id) where division_id is not null;
create index team_entries_team_idx on team_entries (organization_id, team_id);
create trigger team_entries_touch before update on team_entries
  for each row execute function touch_updated_at();

-- Division capacity (§4.7 invariant 3: no overcommitted capacity). The division row is locked so
-- concurrent placements serialize; the count is checked after the lock.
create or replace function team_entries_check_division_capacity() returns trigger
language plpgsql as $$
declare
  cap integer;
  occupied integer;
begin
  if new.division_id is null or new.status not in ('applied', 'approved') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.division_id is not distinct from new.division_id
     and old.status in ('applied', 'approved') then
    return new;
  end if;
  select capacity_team_entries into cap from divisions
    where organization_id = new.organization_id and id = new.division_id for update;
  if cap is null then
    return new;
  end if;
  select count(*) into occupied from team_entries
    where organization_id = new.organization_id and division_id = new.division_id
      and status in ('applied', 'approved') and id <> new.id;
  if occupied >= cap then
    raise exception 'division % is at capacity (%)', new.division_id, cap
      using errcode = 'check_violation', constraint = 'team_entries_division_capacity';
  end if;
  return new;
end
$$;
create trigger team_entries_division_capacity before insert or update of division_id, status on team_entries
  for each row execute function team_entries_check_division_capacity();

-- ---------------------------------------------------------------------------------------------
-- Team roles: effective-dated authority within a season entry (SPK-IAM-001 "Team role"). The
-- kernel's TEAM_AUTHORITY_PORT reads these rows. One open role per person per entry.
-- ---------------------------------------------------------------------------------------------
create table team_roles (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  team_entry_id uuid not null,
  person_id uuid not null,
  role text not null check (role in ('captain', 'co_captain', 'member')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  assigned_by jsonb not null,
  ended_by jsonb,
  ended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check (effective_to is null or effective_to >= effective_from)
);
create unique index team_roles_one_active_idx on team_roles (organization_id, team_entry_id, person_id)
  where effective_to is null;
create index team_roles_person_idx on team_roles (organization_id, person_id);
create trigger team_roles_touch before update on team_roles
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Roster memberships (SPK-COMP-005): effective-dated, never deleted. A removal sets effective_to
-- (and status 'removed', keeping the prior status in status_before_removal) so a player removed
-- today is still part of the roster for an instant last week. invited/requested rows are pending
-- placeholders closed when the invitation or join request is resolved.
-- ---------------------------------------------------------------------------------------------
create table roster_memberships (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  team_entry_id uuid not null,
  person_id uuid not null,
  status text not null check (status in ('invited', 'requested', 'active', 'removed', 'guest', 'substitute')),
  status_before_removal text check (status_before_removal in ('active', 'guest', 'substitute')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  jersey_number integer check (jersey_number is null or jersey_number between 0 and 999),
  source text not null check (source in ('invitation', 'join_request', 'captain', 'staff', 'renewal')),
  added_by jsonb not null,
  added_by_person_id uuid,
  eligibility_snapshot jsonb not null default '[]'::jsonb,
  removed_at timestamptz,
  removed_by jsonb,
  removal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, added_by_person_id) references persons (organization_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'removed') = (removed_at is not null)),
  check ((status = 'removed') = (status_before_removal is not null)),
  check (status <> 'removed' or effective_to is not null)
);
-- A person has at most one open roster row per entry (pending or playing).
create unique index roster_memberships_one_open_idx on roster_memberships (organization_id, team_entry_id, person_id)
  where effective_to is null;
create unique index roster_memberships_jersey_idx on roster_memberships (organization_id, team_entry_id, jersey_number)
  where effective_to is null and jersey_number is not null and status in ('active', 'guest', 'substitute');
create index roster_memberships_entry_idx on roster_memberships (organization_id, team_entry_id, effective_from);
create index roster_memberships_person_idx on roster_memberships (organization_id, person_id, effective_from);
create trigger roster_memberships_touch before update on roster_memberships
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Team invitations (§4.8 POST /team-entries/{id}/invitations, SPK-CAP-001/002)
-- ---------------------------------------------------------------------------------------------
create table team_invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  team_entry_id uuid not null,
  invited_by jsonb not null,
  invited_by_person_id uuid,
  recipient_person_id uuid,
  recipient_contact_kind text check (recipient_contact_kind in ('email', 'phone')),
  recipient_contact_value text,
  message text,
  token_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_person_id uuid,
  declined_at timestamptz,
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  roster_membership_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, invited_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, recipient_person_id) references persons (organization_id, id),
  foreign key (organization_id, accepted_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, roster_membership_id) references roster_memberships (organization_id, id),
  check ((recipient_person_id is not null) <> (recipient_contact_kind is not null)),
  check ((recipient_contact_kind is null) = (recipient_contact_value is null)),
  check ((status = 'accepted') = (accepted_at is not null))
);
create unique index team_invitations_token_idx on team_invitations (token_hash);
create unique index team_invitations_pending_person_idx on team_invitations (organization_id, team_entry_id, recipient_person_id)
  where status = 'pending' and recipient_person_id is not null;
create unique index team_invitations_pending_contact_idx on team_invitations (organization_id, team_entry_id, recipient_contact_kind, recipient_contact_value)
  where status = 'pending' and recipient_contact_kind is not null;
create index team_invitations_entry_idx on team_invitations (organization_id, team_entry_id, status);
create trigger team_invitations_touch before update on team_invitations
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Join requests (SPK-CAP-001 "Review permitted join requests")
-- ---------------------------------------------------------------------------------------------
create table join_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  team_entry_id uuid not null,
  person_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  message text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by jsonb,
  decided_by_person_id uuid,
  decided_at timestamptz,
  decision_note text,
  roster_membership_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, roster_membership_id) references roster_memberships (organization_id, id),
  check ((status = 'pending') = (decided_at is null))
);
create unique index join_requests_pending_idx on join_requests (organization_id, team_entry_id, person_id)
  where status = 'pending';
create index join_requests_entry_idx on join_requests (organization_id, team_entry_id, status);
create trigger join_requests_touch before update on join_requests
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Fixtures (§4.4 Matches). Scheduling (time, field, reservations) is the scheduling module's
-- event referenced by scheduling_event_id; the copied instants are a read model kept in sync by
-- the scheduling.event_changed handler. Results, standings and brackets are part 2.
-- ---------------------------------------------------------------------------------------------
create table fixtures (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid,
  round integer check (round is null or round >= 1),
  home_entry_id uuid not null,
  away_entry_id uuid,
  scheduling_event_id uuid,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text not null default 'unscheduled' check (status in ('unscheduled', 'scheduled', 'played', 'forfeit', 'canceled', 'abandoned', 'postponed')),
  notes text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id),
  foreign key (organization_id, season_id, home_entry_id) references team_entries (organization_id, season_id, id),
  foreign key (organization_id, season_id, away_entry_id) references team_entries (organization_id, season_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  check (away_entry_id is null or away_entry_id <> home_entry_id),
  check (scheduled_start is null or scheduled_end is null or scheduled_start < scheduled_end),
  check ((scheduled_start is null) = (scheduled_end is null)),
  check (status <> 'scheduled' or (scheduling_event_id is not null and scheduled_start is not null))
);
create unique index fixtures_event_idx on fixtures (organization_id, scheduling_event_id)
  where scheduling_event_id is not null;
create index fixtures_season_idx on fixtures (organization_id, season_id, scheduled_start);
create index fixtures_home_idx on fixtures (organization_id, home_entry_id);
create index fixtures_away_idx on fixtures (organization_id, away_entry_id) where away_entry_id is not null;
create trigger fixtures_touch before update on fixtures
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Availability responses (SPK-CAP-003): RSVP states. RSVP is neither attendance nor eligibility.
-- ---------------------------------------------------------------------------------------------
create table availability_responses (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  team_entry_id uuid not null,
  person_id uuid not null,
  state text not null check (state in ('available', 'unavailable', 'tentative', 'no_response')),
  responded_at timestamptz,
  responded_by jsonb not null,
  note text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, fixture_id, person_id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check ((state = 'no_response') = (responded_at is null))
);
create index availability_responses_fixture_idx on availability_responses (organization_id, fixture_id, team_entry_id);
create trigger availability_responses_touch before update on availability_responses
  for each row execute function touch_updated_at();
