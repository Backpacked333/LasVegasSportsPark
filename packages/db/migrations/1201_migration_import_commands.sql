-- MIG-02 (§5.3, §5.4, §5.5 level 4, §5.6, SPK-AT-024; IF-40): the apply creates persons, programs,
-- seasons, teams, team entries, roster memberships, future events (drafts) and communication
-- preferences only through the owning modules' import commands, with a record id the mapping
-- reserves first.
--
-- 1. external_mappings maps the operational categories too: season → seasons, team → teams or
--    team_entries (a staged team row is a team or its entry in a season), roster →
--    roster_memberships, future_schedule → events, communication_preference →
--    communication_preference_imports. Each target is an organization-scoped composite foreign key
--    (§4.3), so a mapping can never reach another organization's record; a linked mapping still
--    reaches exactly one record of the column its entity type allows.
-- 2. reserved_record_id: the UUID v7 the mapping reserves before the owning module's import command
--    runs (the command inserts with id = reserved_record_id, create-if-absent). Once set it never
--    changes, and a linked mapping with a reservation links exactly that record, so an apply that
--    resumes after an interruption can only ever create the reserved record (SPK-AT-024).
-- Applied migrations are immutable: this file changes 1200's table.

-- The generated internal id covers the new target columns.
drop index external_mappings_internal_idx;
alter table external_mappings drop column internal_id;

alter table external_mappings
  add column season_id uuid,
  add column team_id uuid,
  add column team_entry_id uuid,
  add column roster_membership_id uuid,
  add column event_id uuid,
  add column preference_import_id uuid,
  add column reserved_record_id uuid,
  add constraint external_mappings_season_fk
    foreign key (organization_id, season_id) references seasons (organization_id, id),
  add constraint external_mappings_team_fk
    foreign key (organization_id, team_id) references teams (organization_id, id),
  add constraint external_mappings_team_entry_fk
    foreign key (organization_id, team_entry_id) references team_entries (organization_id, id),
  add constraint external_mappings_roster_membership_fk
    foreign key (organization_id, roster_membership_id) references roster_memberships (organization_id, id),
  add constraint external_mappings_event_fk
    foreign key (organization_id, event_id) references events (organization_id, id),
  add constraint external_mappings_preference_import_fk
    foreign key (organization_id, preference_import_id)
    references communication_preference_imports (organization_id, id);

alter table external_mappings
  add column internal_id uuid generated always as (
    coalesce(person_id, household_id, relationship_id, program_id, obligation_id, credit_id,
             season_id, team_id, team_entry_id, roster_membership_id, event_id,
             preference_import_id)) stored;
create index external_mappings_internal_idx on external_mappings (organization_id, entity_type, internal_id)
  where internal_id is not null;

-- Replace 1200's (unnamed) entity-type and target-count checks with named ones over all targets.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'external_mappings'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%num_nonnulls%'
           or pg_get_constraintdef(oid) like '%entity_type%')
  loop
    execute format('alter table external_mappings drop constraint %I', c.conname);
  end loop;
end
$$;

alter table external_mappings
  add constraint external_mappings_entity_type_check check (entity_type in (
    'person', 'household', 'relationship_evidence', 'program', 'open_obligation', 'credit',
    'season', 'team', 'roster', 'future_schedule', 'communication_preference')),
  add constraint external_mappings_one_target check (num_nonnulls(
    person_id, household_id, relationship_id, program_id, obligation_id, credit_id, season_id,
    team_id, team_entry_id, roster_membership_id, event_id, preference_import_id) <= 1),
  add constraint external_mappings_linked_has_target check ((status = 'linked') = (num_nonnulls(
    person_id, household_id, relationship_id, program_id, obligation_id, credit_id, season_id,
    team_id, team_entry_id, roster_membership_id, event_id, preference_import_id) = 1)),
  add constraint external_mappings_person_type check (person_id is null or entity_type = 'person'),
  add constraint external_mappings_household_type check (household_id is null or entity_type = 'household'),
  add constraint external_mappings_relationship_type check (relationship_id is null or entity_type = 'relationship_evidence'),
  add constraint external_mappings_program_type check (program_id is null or entity_type = 'program'),
  add constraint external_mappings_obligation_type check (obligation_id is null or entity_type = 'open_obligation'),
  add constraint external_mappings_credit_type check (credit_id is null or entity_type = 'credit'),
  add constraint external_mappings_season_type check (season_id is null or entity_type = 'season'),
  add constraint external_mappings_team_type check (team_id is null or entity_type = 'team'),
  add constraint external_mappings_team_entry_type check (team_entry_id is null or entity_type = 'team'),
  add constraint external_mappings_roster_type check (roster_membership_id is null or entity_type = 'roster'),
  add constraint external_mappings_event_type check (event_id is null or entity_type = 'future_schedule'),
  add constraint external_mappings_preference_type check (
    preference_import_id is null or entity_type = 'communication_preference'),
  -- The operational categories are only ever created through an import command with a reserved id.
  add constraint external_mappings_import_command_reserved check (
    entity_type not in ('season', 'team', 'roster', 'future_schedule', 'communication_preference')
    or reserved_record_id is not null),
  -- A reservation is the record it links.
  add constraint external_mappings_reservation_links check (
    reserved_record_id is null or status <> 'linked' or reserved_record_id = coalesce(
      person_id, household_id, relationship_id, program_id, obligation_id, credit_id, season_id,
      team_id, team_entry_id, roster_membership_id, event_id, preference_import_id));

create or replace function external_mappings_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.source_system <> old.source_system
     or new.entity_type <> old.entity_type
     or new.external_id <> old.external_id
     or new.first_seen_batch_id <> old.first_seen_batch_id
     or new.provenance <> old.provenance then
    raise exception 'external mapping % key and provenance are immutable', old.id
      using errcode = 'check_violation', constraint = 'external_mappings_key_immutable';
  end if;
  if old.reserved_record_id is not null
     and new.reserved_record_id is distinct from old.reserved_record_id then
    raise exception 'external mapping % reserved record id never changes', old.id
      using errcode = 'check_violation', constraint = 'external_mappings_reservation_final';
  end if;
  if old.status = 'linked' and (
       new.status <> 'linked'
       or new.person_id is distinct from old.person_id
       or new.household_id is distinct from old.household_id
       or new.relationship_id is distinct from old.relationship_id
       or new.program_id is distinct from old.program_id
       or new.obligation_id is distinct from old.obligation_id
       or new.credit_id is distinct from old.credit_id
       or new.season_id is distinct from old.season_id
       or new.team_id is distinct from old.team_id
       or new.team_entry_id is distinct from old.team_entry_id
       or new.roster_membership_id is distinct from old.roster_membership_id
       or new.event_id is distinct from old.event_id
       or new.preference_import_id is distinct from old.preference_import_id
       or new.reserved_record_id is distinct from old.reserved_record_id
       or new.linked_at is distinct from old.linked_at) then
    raise exception 'external mapping % is linked and its target never changes', old.id
      using errcode = 'check_violation', constraint = 'external_mappings_link_final';
  end if;
  return new;
end
$$;
