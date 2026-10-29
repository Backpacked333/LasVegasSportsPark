-- 1006_communications_preference_source.sql
-- Communications module (COM-04): communication preference import (§5.3 "communication
-- preferences", §5.4 import provenance, SPK-AT-024 "importing twice writes once", SPK-COMMS-007).
--
-- 1. communication_preferences.source records who last wrote a stored choice: the person
--    ('person', every row written before this migration) or a migration import ('import'). An
--    import writes only where the person has not chosen; a person's own later change always wins.
-- 2. communication_preference_imports records each imported preference record once, keyed by the
--    import's record id (create-if-absent): the same record with the same content is the existing
--    record and changes nothing; different content is refused by the service. Append-only.
-- The mandatory operational in-app notice stays mandatory whatever is imported (migration 1000's
-- check still refuses disabling it).

alter table communication_preferences
  add column source text not null default 'person' check (source in ('person', 'import'));

create table communication_preference_imports (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  batch_id uuid not null,
  external_key text not null check (length(external_key) between 1 and 200),
  content jsonb not null,
  outcome jsonb not null,
  imported_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id)
);
create index communication_preference_imports_person_idx
  on communication_preference_imports (organization_id, person_id);
create trigger communication_preference_imports_append_only
  before update or delete on communication_preference_imports
  for each row execute function forbid_mutation();
