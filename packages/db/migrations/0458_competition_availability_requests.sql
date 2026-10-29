-- 0458_competition_availability_requests.sql
-- CMP-14 (SPK-CAP-001 "request player availability", SPK-CAP-003, SCR-C-24, §4.9, IF-45): a
-- captain (or league staff) asks the entry's players without an answer for their availability;
-- a later request for the same fixture and entry is the reminder. Each request is an append-only
-- fact: its recipients are named in the audit record and in `competition.availability_requested`,
-- the row keeps how many there were. The entry is always one of the fixture's sides.
create table availability_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  team_entry_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  message text check (message is null or length(message) between 1 and 500),
  requested_at timestamptz not null,
  recipient_count integer not null check (recipient_count >= 0),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id)
);
create index availability_requests_fixture_idx
  on availability_requests (organization_id, fixture_id, team_entry_id, requested_at desc);
create trigger availability_requests_append_only before update or delete on availability_requests
  for each row execute function forbid_mutation();

create or replace function availability_requests_side_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from fixtures f
     where f.organization_id = new.organization_id
       and f.id = new.fixture_id
       and (f.home_entry_id = new.team_entry_id or f.away_entry_id = new.team_entry_id)
  ) then
    raise exception 'an availability request names one of the fixture''s sides'
      using errcode = 'check_violation', constraint = 'availability_requests_fixture_side';
  end if;
  return new;
end
$$;
create trigger availability_requests_side_guard before insert on availability_requests
  for each row execute function availability_requests_side_guard();
