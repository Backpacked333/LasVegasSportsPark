-- 0467_competition_team_waiting.sql
-- Team waiting list (SPK-COMP-006, proposed amendment PA-10; capability `team_waitlist`, DEC-104).
-- Waiting is a state of the team entry: a waiting entry keeps its order (`waiting_since`, then its
-- id), holds no division place and owes nothing. A freed place is offered through its own record
-- (`team_entry_place_offers`): an open offer holds the place until it is accepted, declined,
-- withdrawn or expires, so the place cannot be taken meanwhile.

-- ---------------------------------------------------------------------------------------------
-- team_entries: the `waiting` state and its facts
-- ---------------------------------------------------------------------------------------------
alter table team_entries drop constraint team_entries_status_check;
alter table team_entries add constraint team_entries_status_check
  check (status in ('applied', 'waiting', 'approved', 'withdrawn', 'rejected'));

alter table team_entries
  add column waiting_since timestamptz,
  -- The division whose list the entry waits on; null waits for any place in the season.
  add column waiting_division_id uuid,
  add constraint team_entries_waiting_division_fk
    foreign key (organization_id, season_id, waiting_division_id)
    references divisions (organization_id, season_id, id),
  -- The state and its fact agree; nothing of the wait survives the state.
  add constraint team_entries_waiting_fact
    check ((status = 'waiting') = (waiting_since is not null)),
  add constraint team_entries_waiting_division_only_while_waiting
    check (waiting_division_id is null or status = 'waiting'),
  -- A waiting entry holds no place ...
  add constraint team_entries_waiting_holds_no_place
    check (status <> 'waiting' or division_id is null),
  -- ... and owes nothing: finance records no obligation against it.
  add constraint team_entries_waiting_owes_nothing
    check (status <> 'waiting' or financial_status_ref is null);

-- One live entry per team per season (§4.7 invariant 2). A waiting entry is still the team's one
-- live entry: a team cannot wait and apply in the same season.
drop index team_entries_live_idx;
create unique index team_entries_live_idx on team_entries (organization_id, season_id, team_id)
  where status in ('applied', 'waiting', 'approved');

-- The list order: by the instant the wait began, then the entry id (UUID v7, time ordered).
create index team_entries_waiting_idx
  on team_entries (organization_id, season_id, waiting_division_id, waiting_since, id)
  where status = 'waiting';

-- ---------------------------------------------------------------------------------------------
-- Place offers: one open offer per entry, with an expiry
-- ---------------------------------------------------------------------------------------------
create table team_entry_place_offers (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  team_entry_id uuid not null,
  division_id uuid not null,
  status text not null default 'offered'
    check (status in ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
  -- The entry's place in the list when staff chose it (1 is the longest wait): the record that an
  -- offer followed the order or did not.
  position_at_offer integer not null check (position_at_offer >= 1),
  offered_at timestamptz not null,
  offered_by jsonb not null,
  expires_at timestamptz not null,
  note text check (note is null or length(note) between 1 and 2000),
  resolved_at timestamptz,
  resolved_by jsonb,
  resolution_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- The entry and the division belong to the offer's season and organization.
  foreign key (organization_id, season_id, team_entry_id)
    references team_entries (organization_id, season_id, id),
  foreign key (organization_id, season_id, division_id)
    references divisions (organization_id, season_id, id),
  constraint team_entry_place_offers_expiry_after_offer check (expires_at > offered_at),
  constraint team_entry_place_offers_resolution_fact
    check ((status = 'offered') = (resolved_at is null)),
  constraint team_entry_place_offers_resolver_fact
    check ((resolved_at is null) = (resolved_by is null))
);
create unique index team_entry_place_offers_one_open_idx
  on team_entry_place_offers (organization_id, team_entry_id) where status = 'offered';
create index team_entry_place_offers_division_open_idx
  on team_entry_place_offers (organization_id, division_id) where status = 'offered';
create index team_entry_place_offers_entry_idx
  on team_entry_place_offers (organization_id, team_entry_id, offered_at desc);
create trigger team_entry_place_offers_touch before update on team_entry_place_offers
  for each row execute function touch_updated_at();

-- An offer is made to a waiting entry and only while the division has a free place. Lock order is
-- entry, then division (the order of every placement), so concurrent offers and approvals for the
-- last place serialize on the division row and the loser is refused.
create or replace function team_entry_place_offers_check_insert() returns trigger
language plpgsql as $$
declare
  entry_status text;
  cap integer;
  occupied integer;
  held integer;
begin
  if new.status <> 'offered' then
    raise exception 'a place offer is created open'
      using errcode = 'check_violation', constraint = 'team_entry_place_offers_created_open';
  end if;
  select status into entry_status from team_entries
    where organization_id = new.organization_id and id = new.team_entry_id for update;
  if entry_status is distinct from 'waiting' then
    raise exception 'team entry % is not waiting', new.team_entry_id
      using errcode = 'check_violation', constraint = 'team_entry_place_offers_entry_waiting';
  end if;
  select capacity_team_entries into cap from divisions
    where organization_id = new.organization_id and id = new.division_id for update;
  if cap is null then
    return new;
  end if;
  select count(*) into occupied from team_entries
    where organization_id = new.organization_id and division_id = new.division_id
      and status in ('applied', 'approved');
  select count(*) into held from team_entry_place_offers
    where organization_id = new.organization_id and division_id = new.division_id
      and status = 'offered' and id <> new.id;
  if occupied + held >= cap then
    raise exception 'division % has no free place to offer (%)', new.division_id, cap
      using errcode = 'check_violation', constraint = 'team_entry_place_offers_division_capacity';
  end if;
  return new;
end
$$;
create trigger team_entry_place_offers_check_insert before insert on team_entry_place_offers
  for each row execute function team_entry_place_offers_check_insert();

-- An offer is resolved once: only an open offer changes, only to a terminal state, and what was
-- offered (entry, division, expiry, order) never changes.
create or replace function team_entry_place_offers_guard_update() returns trigger
language plpgsql as $$
begin
  if old.status <> 'offered' then
    raise exception 'place offer % is already %', old.id, old.status
      using errcode = 'check_violation', constraint = 'team_entry_place_offers_resolved_once';
  end if;
  if new.organization_id <> old.organization_id or new.season_id <> old.season_id
     or new.team_entry_id <> old.team_entry_id or new.division_id <> old.division_id
     or new.expires_at <> old.expires_at or new.offered_at <> old.offered_at
     or new.position_at_offer <> old.position_at_offer then
    raise exception 'the terms of place offer % cannot change', old.id
      using errcode = 'check_violation', constraint = 'team_entry_place_offers_terms_immutable';
  end if;
  return new;
end
$$;
create trigger team_entry_place_offers_guard_update before update on team_entry_place_offers
  for each row execute function team_entry_place_offers_guard_update();
create trigger team_entry_place_offers_no_delete before delete on team_entry_place_offers
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Division capacity (§4.7 invariant 3) now counts applied and approved entries AND open place
-- offers, and never a waiting entry. Replaces the function of migration 0400; the trigger keeps
-- its name and events. An entry's own offer is not counted against it (it is the place it takes).
-- ---------------------------------------------------------------------------------------------
create or replace function team_entries_check_division_capacity() returns trigger
language plpgsql as $$
declare
  cap integer;
  occupied integer;
  held integer;
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
  select count(*) into held from team_entry_place_offers
    where organization_id = new.organization_id and division_id = new.division_id
      and status = 'offered' and team_entry_id <> new.id;
  if occupied + held >= cap then
    raise exception 'division % is at capacity (%)', new.division_id, cap
      using errcode = 'check_violation', constraint = 'team_entries_division_capacity';
  end if;
  return new;
end
$$;

-- An entry leaves the list only with its offer settled: accepted (it takes the place) or closed
-- (withdrawn, rejected). An open offer never outlives the wait it was made to.
create or replace function team_entries_waiting_offer_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'waiting' and new.status <> 'waiting' and exists (
    select 1 from team_entry_place_offers
      where organization_id = old.organization_id and team_entry_id = old.id and status = 'offered'
  ) then
    raise exception 'team entry % still has an open place offer', old.id
      using errcode = 'check_violation', constraint = 'team_entries_waiting_offer_settled';
  end if;
  return new;
end
$$;
create trigger team_entries_waiting_offer_guard before update of status on team_entries
  for each row execute function team_entries_waiting_offer_guard();
