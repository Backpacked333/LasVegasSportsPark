-- 1200_migration_core.sql
-- Migration module (specification §5.3 inventory, §5.4 import behaviour, §5.5 reconciliation,
-- §5.6 one authority during transition, §5.7 cutover, §5.8 recovery; §4.4 Migration:
-- ExternalMapping, ImportBatch, ImportException, AuthorityAssignment; §4.7 invariant 11 "no
-- duplicated authority during migration"; SPK-AT-024 "migration snapshot imported twice").
--
-- The module owns these tables and is their only writer (§4.2). Imported records themselves are
-- created by their owning modules' public services (identity, catalog, finance); this module only
-- records batches, staged rows, row outcomes, review decisions, the mapping from a source system's
-- external identifier to the internal record, the authority matrix and reconciliation evidence.
-- Mappings reference the internal records through composite (organization_id, id) foreign keys so
-- a mapping can never point at another organization's record (§4.3).
--
-- The source system's export format is not known (no legacy system has been supplied, §1.4), so
-- the staging contract is neutral: rows of (entity type, external id, JSON payload), accepted as
-- JSON or CSV (packages/contracts/src/api/migration.ts).

-- ---------------------------------------------------------------------------------------------
-- Import batches (§5.4): one received snapshot of one source system. A batch retains the source,
-- the snapshot timestamp, the receipt timestamp, the declared and computed checksums, the
-- transformation version, the declared control totals, extraction provenance, planned and final
-- row counts by outcome, and every actor. Lifecycle (ImportBatchMachine, migration.machines.ts):
--   received → validated → reviewed → applied, with re-validation from validated/reviewed and
--   abort from any non-terminal state. Once an apply has started, records exist in other modules
--   and cannot be undone by aborting (§5.8), so abort and re-validation are refused from then on.
-- At most one apply per source system runs at a time (apply lock with a lease), so two applies
-- can never create the same external record twice (§4.7 invariants 5 and 11).
-- ---------------------------------------------------------------------------------------------
create table import_batches (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  source_system text not null check (source_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  snapshot_taken_at timestamptz not null,
  received_at timestamptz not null,
  transformation_version text not null check (length(transformation_version) between 1 and 100),
  declared_checksum text check (declared_checksum is null or declared_checksum ~ '^[0-9a-f]{64}$'),
  declared_row_count integer check (declared_row_count is null or declared_row_count >= 0),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  extraction jsonb not null default '{}'::jsonb check (jsonb_typeof(extraction) = 'object'),
  control_totals jsonb not null check (jsonb_typeof(control_totals) = 'object'),
  status text not null default 'received'
    check (status in ('received', 'validated', 'reviewed', 'applied', 'aborted')),
  row_count integer not null default 0 check (row_count between 0 and 200000),
  planned_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(planned_counts) = 'object'),
  validation_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_summary) = 'object'),
  created_count integer not null default 0 check (created_count >= 0),
  matched_count integer not null default 0 check (matched_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  exception_count integer not null default 0 check (exception_count >= 0),
  validated_at timestamptz,
  validated_by jsonb,
  reviewed_at timestamptz,
  reviewed_by jsonb,
  review_reason text check (review_reason is null or length(review_reason) between 1 and 2000),
  apply_started_at timestamptz,
  apply_lock_operation_id uuid references operations(id),
  apply_lock_until timestamptz,
  applied_operation_id uuid references operations(id),
  applied_at timestamptz,
  applied_by jsonb,
  aborted_at timestamptz,
  aborted_by jsonb,
  abort_reason text check (abort_reason is null or length(abort_reason) between 1 and 2000),
  submitted_by jsonb not null,
  submitted_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, submitted_by_person_id) references persons (organization_id, id),
  check (snapshot_taken_at <= received_at),
  check (status not in ('validated', 'reviewed', 'applied') or (checksum is not null and validated_at is not null)),
  check (status not in ('reviewed', 'applied') or reviewed_at is not null),
  check ((status = 'applied') = (applied_at is not null)),
  check (status <> 'applied' or (
    applied_operation_id is not null
    and created_count + matched_count + updated_count + skipped_count + exception_count = row_count)),
  check ((status = 'aborted') = (aborted_at is not null)),
  check (status <> 'aborted' or (abort_reason is not null and aborted_by is not null)),
  -- Records created by an apply cannot be withdrawn by aborting or re-validating (§5.8).
  check (status not in ('received', 'validated', 'aborted') or apply_started_at is null),
  check ((apply_lock_operation_id is null) = (apply_lock_until is null)),
  check (apply_lock_operation_id is null or (status = 'reviewed' and apply_started_at is not null))
);
-- One apply in progress per source system (§4.7 invariants 5 and 11).
create unique index import_batches_one_apply_per_source on import_batches (organization_id, source_system)
  where apply_lock_operation_id is not null;
create index import_batches_source_idx on import_batches (organization_id, source_system, received_at desc);
create index import_batches_checksum_idx on import_batches (organization_id, source_system, checksum)
  where checksum is not null;
create trigger import_batches_touch before update on import_batches
  for each row execute function touch_updated_at();
create trigger import_batches_no_delete before delete on import_batches
  for each row execute function forbid_mutation();

create or replace function import_batches_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.source_system <> old.source_system
     or new.snapshot_taken_at <> old.snapshot_taken_at
     or new.received_at <> old.received_at
     or new.transformation_version <> old.transformation_version
     or new.declared_checksum is distinct from old.declared_checksum
     or new.declared_row_count is distinct from old.declared_row_count
     or new.control_totals <> old.control_totals
     or new.extraction <> old.extraction
     or new.submitted_by <> old.submitted_by
     or new.submitted_by_person_id is distinct from old.submitted_by_person_id then
    raise exception 'import batch % source, snapshot and provenance are immutable', old.id
      using errcode = 'check_violation', constraint = 'import_batches_provenance';
  end if;
  if old.status in ('applied', 'aborted') then
    raise exception 'import batch % is % and final', old.id, old.status
      using errcode = 'check_violation', constraint = 'import_batches_machine';
  end if;
  if old.checksum is not null and new.checksum is distinct from old.checksum then
    raise exception 'import batch % checksum is sealed', old.id
      using errcode = 'check_violation', constraint = 'import_batches_sealed';
  end if;
  if new.row_count <> old.row_count and old.status <> 'received' then
    raise exception 'import batch % rows are sealed after validation', old.id
      using errcode = 'check_violation', constraint = 'import_batches_sealed';
  end if;
  if old.apply_started_at is not null and new.apply_started_at is distinct from old.apply_started_at then
    raise exception 'import batch % apply start is a fact', old.id
      using errcode = 'check_violation', constraint = 'import_batches_sealed';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'received' and new.status in ('validated', 'aborted'))
     or (old.status = 'validated' and new.status in ('reviewed', 'aborted'))
     or (old.status = 'reviewed' and new.status in ('validated', 'applied', 'aborted')) then
    return new;
  end if;
  raise exception 'import batch % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'import_batches_machine';
end
$$;
create trigger import_batches_guard before update on import_batches
  for each row execute function import_batches_guard();

-- ---------------------------------------------------------------------------------------------
-- Staged rows (§5.3 inventory, §5.4 row outcomes). One row per (batch, entity type, external
-- id): a snapshot that lists the same external record twice is refused at staging. The staged
-- payload and its hash never change. Validation records the planned outcome and its reasons; the
-- apply records the final outcome (created|matched|updated|skipped|exception), which is a fact.
-- ---------------------------------------------------------------------------------------------
create table import_rows (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  batch_id uuid not null,
  sequence integer not null check (sequence >= 1),
  entity_type text not null check (entity_type in (
    'person', 'household', 'relationship_evidence', 'account', 'program', 'season', 'team',
    'roster', 'future_schedule', 'attendance_history', 'result', 'order', 'open_obligation',
    'credit', 'refund', 'document', 'communication_preference')),
  external_id text not null check (length(external_id) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  planned_outcome text check (planned_outcome in ('created', 'matched', 'updated', 'skipped', 'exception')),
  outcome text check (outcome in ('created', 'matched', 'updated', 'skipped', 'exception')),
  mapping_id uuid,
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  applied_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, batch_id, id),
  unique (organization_id, batch_id, sequence),
  constraint import_rows_external_unique unique (organization_id, batch_id, entity_type, external_id),
  foreign key (organization_id, batch_id) references import_batches (organization_id, id),
  check ((outcome is null) = (applied_at is null)),
  check (outcome is null or (outcome in ('created', 'matched', 'updated')) = (mapping_id is not null))
);
create index import_rows_batch_idx on import_rows (organization_id, batch_id, entity_type, sequence);
create trigger import_rows_touch before update on import_rows
  for each row execute function touch_updated_at();
create trigger import_rows_no_delete before delete on import_rows
  for each row execute function forbid_mutation();

create or replace function import_rows_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.batch_id <> old.batch_id
     or new.sequence <> old.sequence
     or new.entity_type <> old.entity_type
     or new.external_id <> old.external_id
     or new.payload <> old.payload
     or new.payload_hash <> old.payload_hash then
    raise exception 'import row % staged content is immutable', old.id
      using errcode = 'check_violation', constraint = 'import_rows_staged_immutable';
  end if;
  if old.outcome is not null and (
       new.outcome is distinct from old.outcome
       or new.mapping_id is distinct from old.mapping_id
       or new.applied_at is distinct from old.applied_at
       or new.reasons <> old.reasons) then
    raise exception 'import row % outcome is final', old.id
      using errcode = 'check_violation', constraint = 'import_rows_outcome_final';
  end if;
  return new;
end
$$;
create trigger import_rows_guard before update on import_rows
  for each row execute function import_rows_guard();

-- ---------------------------------------------------------------------------------------------
-- External mappings (§5.3 "preserve external identifiers and extraction provenance"; §4.4
-- ExternalMapping). The key is (source system, entity type, external id): names and emails are
-- never keys. A mapping is reserved (`pending`) before the owning module creates the record and
-- `linked` once the record exists; the link never changes afterwards. Re-importing the same
-- external record therefore always reaches the same internal record (SPK-AT-024).
-- ---------------------------------------------------------------------------------------------
create table external_mappings (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  source_system text not null check (source_system ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  entity_type text not null check (entity_type in (
    'person', 'household', 'relationship_evidence', 'program', 'open_obligation', 'credit')),
  external_id text not null check (length(external_id) between 1 and 200),
  status text not null default 'pending' check (status in ('pending', 'linked')),
  person_id uuid,
  household_id uuid,
  relationship_id uuid,
  program_id uuid,
  obligation_id uuid,
  credit_id uuid,
  internal_id uuid generated always as (
    coalesce(person_id, household_id, relationship_id, program_id, obligation_id, credit_id)) stored,
  applied_payload_hash text check (applied_payload_hash is null or applied_payload_hash ~ '^[0-9a-f]{64}$'),
  first_seen_batch_id uuid not null,
  last_seen_batch_id uuid not null,
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  linked_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint external_mappings_key unique (organization_id, source_system, entity_type, external_id),
  foreign key (organization_id, first_seen_batch_id) references import_batches (organization_id, id),
  foreign key (organization_id, last_seen_batch_id) references import_batches (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, household_id) references households (organization_id, id),
  foreign key (organization_id, relationship_id) references relationships (organization_id, id),
  foreign key (organization_id, program_id) references programs (organization_id, id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  foreign key (organization_id, credit_id) references credits (organization_id, id),
  check (num_nonnulls(person_id, household_id, relationship_id, program_id, obligation_id, credit_id) <= 1),
  check ((status = 'linked') = (num_nonnulls(person_id, household_id, relationship_id, program_id, obligation_id, credit_id) = 1)),
  check ((status = 'linked') = (linked_at is not null)),
  check (person_id is null or entity_type = 'person'),
  check (household_id is null or entity_type = 'household'),
  check (relationship_id is null or entity_type = 'relationship_evidence'),
  check (program_id is null or entity_type = 'program'),
  check (obligation_id is null or entity_type = 'open_obligation'),
  check (credit_id is null or entity_type = 'credit')
);
create index external_mappings_internal_idx on external_mappings (organization_id, entity_type, internal_id)
  where internal_id is not null;
create trigger external_mappings_touch before update on external_mappings
  for each row execute function touch_updated_at();
create trigger external_mappings_no_delete before delete on external_mappings
  for each row execute function forbid_mutation();

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
  if old.status = 'linked' and (
       new.status <> 'linked'
       or new.person_id is distinct from old.person_id
       or new.household_id is distinct from old.household_id
       or new.relationship_id is distinct from old.relationship_id
       or new.program_id is distinct from old.program_id
       or new.obligation_id is distinct from old.obligation_id
       or new.credit_id is distinct from old.credit_id
       or new.linked_at is distinct from old.linked_at) then
    raise exception 'external mapping % is linked and its target never changes', old.id
      using errcode = 'check_violation', constraint = 'external_mappings_link_final';
  end if;
  return new;
end
$$;
create trigger external_mappings_guard before update on external_mappings
  for each row execute function external_mappings_guard();

alter table import_rows
  add foreign key (organization_id, mapping_id) references external_mappings (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Import exceptions (§5.4 "ambiguous relationships and balances enter review queues"; §4.4
-- ImportException). One exception per (row, kind) with its reasons, owned by a staff role queue.
-- A decision (accept|reject|defer) is final and carries a reason; only ambiguity can be accepted —
-- a validation error or a conflict is rejected (row skipped) or deferred (row left as exception).
-- An open exception whose cause disappeared on re-validation is withdrawn, never deleted.
-- ---------------------------------------------------------------------------------------------
create table import_exceptions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  batch_id uuid not null,
  row_id uuid not null,
  kind text not null check (kind in ('ambiguous_relationship', 'ambiguous_balance', 'conflict', 'validation')),
  phase text not null check (phase in ('validation', 'apply')),
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) > 0),
  review_owner_role text not null check (review_owner_role in (
    'front_desk', 'league_manager', 'program_manager', 'scheduler', 'finance_operator',
    'facilities_operator', 'general_manager', 'system_administrator', 'support_operator')),
  status text not null default 'open' check (status in ('open', 'decided', 'withdrawn')),
  decision text check (decision in ('accept', 'reject', 'defer')),
  resolution jsonb check (resolution is null or jsonb_typeof(resolution) = 'object'),
  decision_reason text check (decision_reason is null or length(decision_reason) between 1 and 2000),
  decided_by jsonb,
  decided_by_person_id uuid,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint import_exceptions_row_kind_unique unique (organization_id, row_id, kind),
  foreign key (organization_id, batch_id) references import_batches (organization_id, id),
  foreign key (organization_id, batch_id, row_id) references import_rows (organization_id, batch_id, id),
  foreign key (organization_id, decided_by_person_id) references persons (organization_id, id),
  check ((status = 'decided') = (decision is not null)),
  check ((decision is null) = (decided_at is null)),
  check (decision is null or (decision_reason is not null and decided_by is not null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check (decision <> 'accept' or kind in ('ambiguous_relationship', 'ambiguous_balance')),
  check (resolution is null or decision = 'accept')
);
create index import_exceptions_queue_idx on import_exceptions (organization_id, review_owner_role, status, created_at)
  where status = 'open';
create index import_exceptions_batch_idx on import_exceptions (organization_id, batch_id, status);
create trigger import_exceptions_touch before update on import_exceptions
  for each row execute function touch_updated_at();
create trigger import_exceptions_no_delete before delete on import_exceptions
  for each row execute function forbid_mutation();

create or replace function import_exceptions_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.batch_id <> old.batch_id
     or new.row_id <> old.row_id
     or new.kind <> old.kind
     or new.phase <> old.phase
     or new.review_owner_role <> old.review_owner_role then
    raise exception 'import exception % identity is immutable', old.id
      using errcode = 'check_violation', constraint = 'import_exceptions_immutable';
  end if;
  if old.status <> 'open' and (
       new.status <> old.status
       or new.decision is distinct from old.decision
       or new.resolution is distinct from old.resolution
       or new.decision_reason is distinct from old.decision_reason
       or new.decided_at is distinct from old.decided_at
       or new.reasons <> old.reasons) then
    raise exception 'import exception % is % and final', old.id, old.status
      using errcode = 'check_violation', constraint = 'import_exceptions_final';
  end if;
  return new;
end
$$;
create trigger import_exceptions_guard before update on import_exceptions
  for each row execute function import_exceptions_guard();

-- ---------------------------------------------------------------------------------------------
-- Authority matrix (§5.6 "maintain an authority matrix for each record category and scope";
-- §4.4 AuthorityAssignment; §4.7 invariant 11). For one record category and one scope exactly
-- one system is authoritative at any instant: the exclusion constraint refuses two assignments
-- whose effective periods overlap. A transfer ends the current assignment and starts the next one
-- in the same transaction; an assignment's period can only be shortened (never moved, widened or
-- deleted), so the history of who was authoritative is never rewritten (§4.7 invariant 9).
-- Shared pitches need one scheduling authority across migrated and non-migrated activities, so
-- the schedule category can only be assigned per organization or facility, never per program.
-- ---------------------------------------------------------------------------------------------
create table authority_assignments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  record_category text not null check (record_category in (
    'person', 'household', 'relationship_evidence', 'account', 'program', 'season', 'team',
    'roster', 'future_schedule', 'attendance_history', 'result', 'order', 'open_obligation',
    'credit', 'refund', 'document', 'communication_preference')),
  scope_kind text not null check (scope_kind in ('organization', 'facility', 'program', 'competition')),
  facility_id uuid,
  program_id uuid,
  competition_id uuid,
  authoritative_system text not null check (authoritative_system in ('legacy', 'sportspark')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  effective tstzrange generated always as (tstzrange(effective_from, effective_to, '[)')) stored,
  reason text not null check (length(reason) between 1 and 2000),
  policy_references text[] not null default '{}',
  approved_by jsonb not null,
  approved_by_person_id uuid,
  supersedes_assignment_id uuid,
  ended_at timestamptz,
  ended_by jsonb,
  end_reason text check (end_reason is null or length(end_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, program_id) references programs (organization_id, id),
  foreign key (organization_id, competition_id) references competitions (organization_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, supersedes_assignment_id) references authority_assignments (organization_id, id),
  check (effective_to is null or effective_to > effective_from),
  check (num_nonnulls(facility_id, program_id, competition_id) <= 1),
  check ((scope_kind = 'organization') = (num_nonnulls(facility_id, program_id, competition_id) = 0)),
  check ((scope_kind = 'facility') = (facility_id is not null)),
  check ((scope_kind = 'program') = (program_id is not null)),
  check ((scope_kind = 'competition') = (competition_id is not null)),
  check (record_category <> 'future_schedule' or scope_kind in ('organization', 'facility')),
  check ((ended_at is null) = (ended_by is null)),
  check (ended_at is null or (effective_to is not null and end_reason is not null)),
  -- §4.7 invariant 11: one authority per record category and scope at every instant.
  constraint authority_assignments_one_authority exclude using gist (
    organization_id with =,
    record_category with =,
    scope_kind with =,
    (coalesce(facility_id, program_id, competition_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    effective with &&
  )
);
create index authority_assignments_lookup_idx on authority_assignments (organization_id, record_category, effective_from);
create trigger authority_assignments_touch before update on authority_assignments
  for each row execute function touch_updated_at();
create trigger authority_assignments_no_delete before delete on authority_assignments
  for each row execute function forbid_mutation();

create or replace function authority_assignments_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.record_category <> old.record_category
     or new.scope_kind <> old.scope_kind
     or new.facility_id is distinct from old.facility_id
     or new.program_id is distinct from old.program_id
     or new.competition_id is distinct from old.competition_id
     or new.authoritative_system <> old.authoritative_system
     or new.effective_from <> old.effective_from
     or new.reason <> old.reason
     or new.policy_references <> old.policy_references
     or new.approved_by <> old.approved_by
     or new.approved_by_person_id is distinct from old.approved_by_person_id
     or new.supersedes_assignment_id is distinct from old.supersedes_assignment_id then
    raise exception 'authority assignment % is immutable except for ending it', old.id
      using errcode = 'check_violation', constraint = 'authority_assignments_immutable';
  end if;
  if new.effective_to is distinct from old.effective_to and (
       new.effective_to is null
       or (old.effective_to is not null and new.effective_to >= old.effective_to)) then
    raise exception 'authority assignment % can only be shortened', old.id
      using errcode = 'check_violation', constraint = 'authority_assignments_only_shortens';
  end if;
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'authority assignment % end is a fact', old.id
      using errcode = 'check_violation', constraint = 'authority_assignments_immutable';
  end if;
  return new;
end
$$;
create trigger authority_assignments_guard before update on authority_assignments
  for each row execute function authority_assignments_guard();

-- ---------------------------------------------------------------------------------------------
-- Reconciliation (§5.5): four levels (control totals, record identity, relationships,
-- operational outcomes). Each discrepancy is its own append-only row with its own currency:
-- unrelated discrepancies are never netted to make totals look correct. Approvals are per area
-- (finance approves opening balances; program and league owners approve participation;
-- operations approves the schedule; the operator approves identity) and are append-only facts.
-- Regenerating a report supersedes the pending one; an approved or rejected report is final.
-- ---------------------------------------------------------------------------------------------
create table reconciliation_reports (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  batch_id uuid not null,
  generated_at timestamptz not null,
  generated_by jsonb not null,
  generated_by_person_id uuid,
  status text not null check (status in ('balanced', 'discrepancy')),
  levels jsonb not null check (jsonb_typeof(levels) = 'array'),
  discrepancy_count integer not null check (discrepancy_count >= 0),
  required_areas text[] not null check (required_areas <@ array['identity', 'participation', 'schedule', 'finance']::text[]),
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected', 'superseded')),
  approval_completed_at timestamptz,
  superseded_by_report_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, batch_id) references import_batches (organization_id, id),
  foreign key (organization_id, generated_by_person_id) references persons (organization_id, id),
  -- Deferred: the superseding report is inserted in the same transaction that supersedes this one.
  foreign key (organization_id, superseded_by_report_id) references reconciliation_reports (organization_id, id)
    deferrable initially deferred,
  check ((status = 'balanced') = (discrepancy_count = 0)),
  check ((approval_status in ('approved', 'rejected')) = (approval_completed_at is not null)),
  check ((approval_status = 'superseded') = (superseded_by_report_id is not null))
);
create unique index reconciliation_reports_one_pending on reconciliation_reports (organization_id, batch_id)
  where approval_status = 'pending';
create trigger reconciliation_reports_touch before update on reconciliation_reports
  for each row execute function touch_updated_at();
create trigger reconciliation_reports_no_delete before delete on reconciliation_reports
  for each row execute function forbid_mutation();

create or replace function reconciliation_reports_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.batch_id <> old.batch_id
     or new.generated_at <> old.generated_at
     or new.generated_by <> old.generated_by
     or new.status <> old.status
     or new.levels <> old.levels
     or new.discrepancy_count <> old.discrepancy_count
     or new.required_areas <> old.required_areas then
    raise exception 'reconciliation report % evidence is immutable', old.id
      using errcode = 'check_violation', constraint = 'reconciliation_reports_immutable';
  end if;
  if new.approval_status = old.approval_status then
    return new;
  end if;
  if old.approval_status = 'pending' and new.approval_status in ('approved', 'rejected', 'superseded') then
    return new;
  end if;
  raise exception 'reconciliation report % cannot move from % to %', old.id, old.approval_status, new.approval_status
    using errcode = 'check_violation', constraint = 'reconciliation_reports_machine';
end
$$;
create trigger reconciliation_reports_guard before update on reconciliation_reports
  for each row execute function reconciliation_reports_guard();

create table reconciliation_discrepancies (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  report_id uuid not null,
  level text not null check (level in ('control_totals', 'record_identity', 'relationships', 'operational_outcomes')),
  area text not null check (area in ('identity', 'participation', 'schedule', 'finance')),
  entity_type text not null check (entity_type in (
    'person', 'household', 'relationship_evidence', 'account', 'program', 'season', 'team',
    'roster', 'future_schedule', 'attendance_history', 'result', 'order', 'open_obligation',
    'credit', 'refund', 'document', 'communication_preference')),
  code text not null check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  external_id text,
  internal_id uuid,
  expected jsonb,
  actual jsonb,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  difference_minor bigint,
  count_difference integer,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, report_id) references reconciliation_reports (organization_id, id),
  -- A money difference always names its currency: amounts in different currencies never offset.
  check (difference_minor is null or currency is not null)
);
create index reconciliation_discrepancies_report_idx on reconciliation_discrepancies (organization_id, report_id, level);
create trigger reconciliation_discrepancies_append_only before update or delete on reconciliation_discrepancies
  for each row execute function forbid_mutation();

create table reconciliation_approvals (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  report_id uuid not null,
  area text not null check (area in ('identity', 'participation', 'schedule', 'finance')),
  decision text not null check (decision in ('approved', 'rejected')),
  approver jsonb not null,
  approver_person_id uuid not null,
  approver_role text not null check (approver_role in (
    'league_manager', 'program_manager', 'scheduler', 'finance_operator', 'general_manager',
    'support_operator')),
  reason text check (reason is null or length(reason) between 1 and 2000),
  acknowledged_discrepancies integer not null check (acknowledged_discrepancies >= 0),
  decided_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint reconciliation_approvals_one_per_area unique (organization_id, report_id, area),
  foreign key (organization_id, report_id) references reconciliation_reports (organization_id, id),
  foreign key (organization_id, approver_person_id) references persons (organization_id, id),
  -- Discrepancies are accepted only with an explanation; they stay listed (never netted away).
  check (reason is not null or (decision = 'approved' and acknowledged_discrepancies = 0))
);
create trigger reconciliation_approvals_append_only before update or delete on reconciliation_approvals
  for each row execute function forbid_mutation();
