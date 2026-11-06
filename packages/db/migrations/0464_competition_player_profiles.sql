-- 0464_competition_player_profiles.sql
-- Staff player profiles for team placement (SPK-PLACE-002 "staff receive eligible candidate teams
-- with explainable reasons", SPK-PLACE-005 operator-mediated placement, no public profiles). One
-- row per season and person: the playing position staff recorded (goalkeeper or an outfield line)
-- and a staff skill rating on a 1 to 5 scale, so the placement board can check "at least one
-- keeper" and skill balance per team. A staff record, never a registrant declaration: what a
-- registrant may declare (declared level, position preferences) stays on enrollment's placement
-- request and is pending DEC-051. The scale is an engineering placeholder (competition.policy.ts).
-- Editable with a revision (§4.9); every change is audited; a profile is never deleted.
create table season_player_profiles (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  season_id uuid not null,
  person_id uuid not null,
  position text check (
    position is null or position in ('goalkeeper', 'defender', 'midfielder', 'forward', 'outfield')
  ),
  skill_rating smallint check (skill_rating is null or skill_rating between 1 and 5),
  note text check (note is null or length(note) between 1 and 500),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  recorded_at timestamptz not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, season_id, person_id),
  foreign key (organization_id, season_id) references seasons (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  constraint season_player_profiles_has_fact check (position is not null or skill_rating is not null)
);
create trigger season_player_profiles_touch before update on season_player_profiles
  for each row execute function touch_updated_at();
create trigger season_player_profiles_no_delete before delete on season_player_profiles
  for each row execute function forbid_mutation();
