-- 0459_competition_tournament_pools.sql
-- CMP-15 (§3.16 Tournaments: pools, compressed scheduling, officials; DEC-016, DEC-078): a
-- division of a tournament may split its entries into pools; pool standings seed bracket nodes.
-- Creating pools and changing their entries is gated by the organization's `tournaments`
-- capability in the service; this schema holds the integrity:
--
-- * a pool belongs to one division of one season, and its name is unique in the division;
-- * a pool entry names the pool's own season and division, and the team entry must be of that
--   same season and division (composite foreign keys), so another season's or division's entry
--   can never join;
-- * an entry is in at most one pool of its division.
--
-- Compressed play: fixture specifications may cap games per team per facility-local day and state
-- how many officials a game needs. Both are optional; existing specifications are unchanged.
alter table team_entries
  add constraint team_entries_division_scoped_key unique (organization_id, id, season_id, division_id);

create table pools (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  division_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, season_id, division_id),
  unique (organization_id, division_id, name),
  foreign key (organization_id, season_id, division_id) references divisions (organization_id, season_id, id)
);
create trigger pools_touch before update on pools
  for each row execute function touch_updated_at();

create table pool_entries (
  organization_id uuid not null references organizations(id),
  pool_id uuid not null,
  season_id uuid not null,
  division_id uuid not null,
  team_entry_id uuid not null,
  seed integer check (seed is null or seed > 0),
  added_by jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, pool_id, team_entry_id),
  unique (organization_id, division_id, team_entry_id),
  foreign key (organization_id, pool_id, season_id, division_id)
    references pools (organization_id, id, season_id, division_id),
  foreign key (organization_id, team_entry_id, season_id, division_id)
    references team_entries (organization_id, id, season_id, division_id)
);
create index pool_entries_pool_idx on pool_entries (organization_id, pool_id);

alter table fixture_specifications
  add column max_games_per_team_per_day integer,
  add column officials_per_game integer,
  add constraint fixture_specifications_max_games_per_day_check
    check (max_games_per_team_per_day is null or max_games_per_team_per_day > 0),
  add constraint fixture_specifications_officials_per_game_check
    check (officials_per_game is null or officials_per_game > 0);
