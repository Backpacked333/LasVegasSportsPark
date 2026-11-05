-- 0456_competition_import_source.sql
-- CMP-09 (§5.3 seasons, teams and rosters; §5.4 extraction provenance; SPK-AT-024; IF-40): records
-- created by the migration module's import commands say so. Staff-created records keep the
-- default `staff`; the import commands (CompetitionImportService) write `import`. A roster
-- membership already records its source; `import` joins the sources migration 0453 allows.
alter table seasons
  add column source text not null default 'staff',
  add constraint seasons_source_check check (source in ('staff', 'import'));

alter table teams
  add column source text not null default 'staff',
  add constraint teams_source_check check (source in ('staff', 'import'));

alter table team_entries
  add column source text not null default 'staff',
  add constraint team_entries_source_check check (source in ('staff', 'import'));

alter table roster_memberships drop constraint roster_memberships_source_check;
alter table roster_memberships
  add constraint roster_memberships_source_check
  check (source in ('invitation', 'join_request', 'captain', 'staff', 'renewal', 'registration', 'import'));
