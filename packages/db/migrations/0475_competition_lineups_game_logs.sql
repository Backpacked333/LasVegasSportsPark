-- 0475_competition_lineups_game_logs.sql
-- Competition module: a side's lineup for a fixture and the coach's game log with each player's
-- minutes (SPK-CAP-001 captain tools, SPK-CAP-003 availability, SPK-UX-007 field-side work,
-- SPK-RESULT-001 result reporting; staff redesign Phase 8 "Coach · Lineup" and "Coach · Live
-- game day").
--
-- - fixture_lineups: one lineup per fixture side (formation, who starts where, when it was shared
--   with the families). Editable with a revision (§4.9).
-- - fixture_lineup_slots: who stands in which starting place (slot 1 is the goalkeeper). A player
--   holds at most one place, and a place holds one player.
-- - fixture_game_logs: the side's own record of the game kept at the field: the score as the coach
--   saw it and the timeline (goals with scorer and assist, substitutions, the opponent's goals,
--   half time). It is never the result: the result stays the referee's or the league's (results
--   module of competition, SPK-RESULT-001/002); the official's match report checks against it.
-- - fixture_player_minutes: minutes each player of the side played in that game, written with the
--   game log; summed per season they order the bench (fewest minutes first).
-- The side is always one of the fixture's sides (trigger below); the people are on the side's
-- roster at kickoff (checked by the service, which owns the effective roster).

create table fixture_lineups (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  team_entry_id uuid not null,
  formation text not null check (formation ~ '^[1-9](-[1-9]){1,3}$'),
  shared_at timestamptz,
  shared_by jsonb,
  -- the revision that was shared; a later save moves the revision past it
  shared_revision integer,
  updated_by jsonb not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- one lineup per fixture side
  unique (organization_id, fixture_id, team_entry_id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  constraint fixture_lineups_shared_facts check (
    (shared_at is null) = (shared_by is null)
    and (shared_at is null) = (shared_revision is null)
    and (shared_revision is null or shared_revision <= revision)
  )
);
create trigger fixture_lineups_touch before update on fixture_lineups
  for each row execute function touch_updated_at();

create table fixture_lineup_slots (
  organization_id uuid not null references organizations(id),
  lineup_id uuid not null,
  slot smallint not null check (slot between 1 and 11),
  person_id uuid not null,
  primary key (organization_id, lineup_id, slot),
  -- a player stands in one place only
  constraint fixture_lineup_slots_one_place unique (organization_id, lineup_id, person_id),
  foreign key (organization_id, lineup_id) references fixture_lineups (organization_id, id)
    on delete cascade,
  foreign key (organization_id, person_id) references persons (organization_id, id)
);

create table fixture_game_logs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  team_entry_id uuid not null,
  home_score smallint not null check (home_score between 0 and 99),
  away_score smallint not null check (away_score between 0 and 99),
  -- [{ kind: goal | opponent_goal | substitution | half_time, minute, personId?, assistPersonId?,
  --    offPersonId?, onPersonId? }]; identifiers only, never names (§4.14)
  events jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array'),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  recorded_at timestamptz not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- one game log per fixture side; a correction is a new revision of it
  unique (organization_id, fixture_id, team_entry_id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id)
);
create trigger fixture_game_logs_touch before update on fixture_game_logs
  for each row execute function touch_updated_at();

create table fixture_player_minutes (
  organization_id uuid not null references organizations(id),
  game_log_id uuid not null,
  team_entry_id uuid not null,
  person_id uuid not null,
  minutes smallint not null check (minutes between 0 and 150),
  primary key (organization_id, game_log_id, person_id),
  foreign key (organization_id, game_log_id) references fixture_game_logs (organization_id, id)
    on delete cascade,
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);
create index fixture_player_minutes_entry_idx
  on fixture_player_minutes (organization_id, team_entry_id, person_id);

-- The side named by a lineup or a game log is one of the fixture's sides; the minutes belong to
-- the game log's side.
create or replace function competition_fixture_side_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from fixtures f
     where f.organization_id = new.organization_id
       and f.id = new.fixture_id
       and (f.home_entry_id = new.team_entry_id or f.away_entry_id = new.team_entry_id)
  ) then
    raise exception 'the team entry is not a side of the fixture'
      using errcode = 'check_violation', constraint = tg_table_name || '_fixture_side';
  end if;
  return new;
end
$$;
create trigger fixture_lineups_side_guard before insert or update on fixture_lineups
  for each row execute function competition_fixture_side_guard();
create trigger fixture_game_logs_side_guard before insert or update on fixture_game_logs
  for each row execute function competition_fixture_side_guard();

create or replace function fixture_player_minutes_side_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from fixture_game_logs g
     where g.organization_id = new.organization_id
       and g.id = new.game_log_id
       and g.team_entry_id = new.team_entry_id
  ) then
    raise exception 'player minutes belong to the game log''s side'
      using errcode = 'check_violation', constraint = 'fixture_player_minutes_log_side';
  end if;
  return new;
end
$$;
create trigger fixture_player_minutes_side_guard before insert or update on fixture_player_minutes
  for each row execute function fixture_player_minutes_side_guard();
