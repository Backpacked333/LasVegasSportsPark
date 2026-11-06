-- 0465_competition_fixture_attendance.sql
-- Fixture attendance: player check-in on the match sheet (SPK-UX-007 field-side work,
-- SPK-STAFF-005 officials submit the required confirmation, SPK-CAP-003 RSVP is neither
-- attendance nor eligibility). The referee, league staff or a captain of the side marks a rostered
-- player present or absent at the field, or clears an earlier mark. Each mark is an append-only
-- observation (§4.7 "corrections are new rows that reference what they correct"): a later mark
-- names the mark it supersedes, so each player's marks form one chain and the current state is
-- the mark nobody supersedes. The database keeps the chain linear: one first mark per player and
-- fixture side, and a mark is superseded at most once (two concurrent check-ins of the same player
-- cannot both win; the loser retries on the new state).
-- The entry is always one of the fixture's sides (trigger below), and the person a member of that
-- entry's roster at kickoff (checked by the service, which owns the effective roster).
create table fixture_attendance_marks (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  team_entry_id uuid not null,
  person_id uuid not null,
  state text not null check (state in ('present', 'absent', 'cleared')),
  supersedes_mark_id uuid,
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, supersedes_mark_id) references fixture_attendance_marks (organization_id, id),
  check (supersedes_mark_id is null or supersedes_mark_id <> id)
);
create unique index fixture_attendance_marks_first_idx
  on fixture_attendance_marks (organization_id, fixture_id, team_entry_id, person_id)
  where supersedes_mark_id is null;
create unique index fixture_attendance_marks_supersedes_idx
  on fixture_attendance_marks (organization_id, supersedes_mark_id)
  where supersedes_mark_id is not null;
create index fixture_attendance_marks_fixture_idx
  on fixture_attendance_marks (organization_id, fixture_id, team_entry_id, person_id);
create trigger fixture_attendance_marks_append_only before update or delete on fixture_attendance_marks
  for each row execute function forbid_mutation();

create or replace function fixture_attendance_marks_side_guard() returns trigger
language plpgsql as $$
begin
  if new.supersedes_mark_id is not null and not exists (
    select 1 from fixture_attendance_marks m
     where m.organization_id = new.organization_id
       and m.id = new.supersedes_mark_id
       and m.fixture_id = new.fixture_id
       and m.team_entry_id = new.team_entry_id
       and m.person_id = new.person_id
  ) then
    raise exception 'an attendance mark supersedes a mark of the same player and fixture side'
      using errcode = 'check_violation', constraint = 'fixture_attendance_marks_same_chain';
  end if;
  if not exists (
    select 1 from fixtures f
     where f.organization_id = new.organization_id
       and f.id = new.fixture_id
       and (f.home_entry_id = new.team_entry_id or f.away_entry_id = new.team_entry_id)
  ) then
    raise exception 'an attendance mark names one of the fixture''s sides'
      using errcode = 'check_violation', constraint = 'fixture_attendance_marks_fixture_side';
  end if;
  return new;
end
$$;
create trigger fixture_attendance_marks_side_guard before insert on fixture_attendance_marks
  for each row execute function fixture_attendance_marks_side_guard();
