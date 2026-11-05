-- 0700_workforce_core.sql
-- Workforce module (specification §3.10 SPK-STAFF-001..006, §2.4 SPK-UX-007, §4.4 Workforce:
-- Availability, Qualification, Assignment, FeeSubmission; §4.6 Assignment machine; SPK-AT-012).
--
-- The module owns these tables and is their only writer (§4.2). It references people (identity),
-- fixtures (competition), events (scheduling), offering sessions (catalog) and staff memberships
-- (identity) through composite (organization_id, id) foreign keys so a row can never point at
-- another organization's record (§4.3). Historical work records are never deleted (SPK-STAFF-004):
-- every table refuses DELETE; corrections are state changes or appended rows.

-- ---------------------------------------------------------------------------------------------
-- Availability (SPK-STAFF-001): a person's own statement of when they can or cannot work. The
-- interval is a half-open tstzrange; one active statement per person per instant (an available
-- and an unavailable window can never overlap), enforced by an exclusion constraint.
-- ---------------------------------------------------------------------------------------------
create table availability (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  during tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  kind text not null check (kind in ('available', 'unavailable')),
  note text check (note is null or length(note) between 1 and 500),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check (starts_at < ends_at),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check (status <> 'withdrawn' or withdrawn_reason is not null),
  constraint availability_no_overlap
    exclude using gist (organization_id with =, person_id with =, during with &&)
    where (status = 'active')
);
create index availability_person_idx on availability (organization_id, person_id, starts_at);
create trigger availability_touch before update on availability
  for each row execute function touch_updated_at();
create trigger availability_no_delete before delete on availability
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Qualifications (SPK-STAFF-001): evidence that a person may hold a role (referee grade, coaching
-- licence, safeguarding check). Evidence is a reference, never an upload. Only a verified
-- qualification inside its validity window satisfies a requirement.
-- ---------------------------------------------------------------------------------------------
create table qualifications (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  level text check (level is null or length(level) between 1 and 100),
  evidence_reference text check (evidence_reference is null or length(evidence_reference) between 1 and 2000),
  valid_from timestamptz not null,
  valid_to timestamptz,
  status text not null default 'pending_verification'
    check (status in ('pending_verification', 'verified', 'rejected', 'revoked')),
  verified_by jsonb,
  verified_by_person_id uuid,
  verified_at timestamptz,
  status_reason text,
  status_changed_at timestamptz,
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check (valid_to is null or valid_to > valid_from),
  check (status <> 'verified' or (verified_at is not null and verified_by is not null)),
  check (status not in ('rejected', 'revoked') or (status_reason is not null and status_changed_at is not null))
);
create index qualifications_person_idx on qualifications (organization_id, person_id, kind);
create trigger qualifications_touch before update on qualifications
  for each row execute function touch_updated_at();
create trigger qualifications_no_delete before delete on qualifications
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Assignment requirements: how many people a target needs in a role, whether only accepted
-- assignments satisfy it (SPK-STAFF-002) and which qualifications are required (SPK-STAFF-001).
-- A target is a competition fixture, a scheduling event or a catalog offering session; the
-- matching id column carries the composite foreign key to the owning module's record.
-- ---------------------------------------------------------------------------------------------
create table assignment_requirements (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  target_type text not null check (target_type in ('fixture', 'event', 'session')),
  target_id uuid not null,
  fixture_id uuid,
  scheduling_event_id uuid,
  offering_session_id uuid,
  offering_id uuid,
  kind text not null check (kind in ('official', 'coach', 'supervisor', 'organizer')),
  role text not null check (role ~ '^[a-z][a-z0-9_]{0,63}$'),
  required_count integer not null check (required_count between 1 and 50),
  must_be_accepted boolean not null default true,
  required_qualifications text[] not null default '{}' check (cardinality(required_qualifications) <= 20),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, target_type, target_id, role),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  check ((target_type = 'fixture') = (fixture_id is not null)),
  check (fixture_id is null or fixture_id = target_id),
  check (target_type <> 'event' or scheduling_event_id = target_id),
  check ((target_type = 'session') = (offering_session_id is not null and offering_id is not null)),
  check (offering_session_id is null or offering_session_id = target_id)
);
create trigger assignment_requirements_touch before update on assignment_requirements
  for each row execute function touch_updated_at();
create trigger assignment_requirements_no_delete before delete on assignment_requirements
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Assignments (§4.6 Assignment machine: proposed → offered → accepted | declined; withdrawn from
-- proposed, offered or accepted; accepted → completed). The target's interval is copied at
-- creation and kept in step by the module's handlers; `committed` is the interval the person is
-- held for: the scheduled interval plus the required turnaround (SPK-STAFF-003).
--
-- Database guarantees:
--   * one accepted (or completed) assignment per (target, role, slot) — partial unique index;
--   * one live assignment per person per (target, role, slot);
--   * no two accepted assignments of a person overlap, turnaround included — GiST exclusion;
--   * temporary and substitute assignments carry the time-bounded access window (SPK-STAFF-004);
--   * rows are never deleted.
-- ---------------------------------------------------------------------------------------------
create table assignments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  person_id uuid not null,
  kind text not null check (kind in ('official', 'coach', 'supervisor', 'organizer')),
  target_type text not null check (target_type in ('fixture', 'event', 'session')),
  target_id uuid not null,
  fixture_id uuid,
  scheduling_event_id uuid,
  offering_session_id uuid,
  offering_id uuid,
  target_title text not null check (length(target_title) between 1 and 300),
  role text not null check (role ~ '^[a-z][a-z0-9_]{0,63}$'),
  slot integer not null default 1 check (slot between 1 and 50),
  engagement text not null default 'regular' check (engagement in ('regular', 'temporary', 'substitute')),
  status text not null default 'proposed'
    check (status in ('proposed', 'offered', 'accepted', 'declined', 'withdrawn', 'completed')),
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  turnaround_minutes integer not null default 0 check (turnaround_minutes between 0 and 720),
  committed_end timestamptz not null,
  committed tstzrange generated always as (tstzrange(scheduled_start, committed_end, '[)')) stored,
  replaces_assignment_id uuid,
  offered_at timestamptz,
  responded_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  withdrawn_at timestamptz,
  withdrawn_reason text,
  withdrawn_by jsonb,
  completed_at timestamptz,
  completed_by jsonb,
  access_status text not null default 'not_applicable'
    check (access_status in ('not_applicable', 'pending', 'granted', 'failed', 'ended')),
  access_membership_id uuid,
  access_from timestamptz,
  access_until timestamptz,
  created_by jsonb not null,
  created_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, replaces_assignment_id) references assignments (organization_id, id),
  foreign key (organization_id, access_membership_id) references staff_memberships (organization_id, id),
  check ((target_type = 'fixture') = (fixture_id is not null)),
  check (fixture_id is null or fixture_id = target_id),
  check (target_type <> 'event' or scheduling_event_id = target_id),
  check ((target_type = 'session') = (offering_session_id is not null and offering_id is not null)),
  check (offering_session_id is null or offering_session_id = target_id),
  check (replaces_assignment_id is null or replaces_assignment_id <> id),
  check (scheduled_start < scheduled_end),
  check (committed_end = scheduled_end + make_interval(mins => turnaround_minutes)),
  -- each state carries the fact that produced it
  check (status not in ('offered', 'accepted', 'declined', 'completed') or offered_at is not null),
  check (status not in ('accepted', 'completed') or accepted_at is not null),
  check (status <> 'declined' or (declined_at is not null and responded_at is not null)),
  check (status <> 'withdrawn' or (withdrawn_at is not null and withdrawn_reason is not null)),
  check ((status = 'completed') = (completed_at is not null)),
  -- time-bounded access only for temporary or substitute work (SPK-STAFF-004)
  check (engagement <> 'regular' or access_status = 'not_applicable'),
  check (access_status not in ('granted', 'ended') or access_membership_id is not null),
  check ((access_from is null) = (access_until is null)),
  check (access_from is null or access_from < access_until),
  constraint assignments_no_overlap
    exclude using gist (organization_id with =, person_id with =, committed with &&)
    where (status = 'accepted')
);
-- One accepted assignment per role slot (a completed one keeps the slot served).
create unique index assignments_one_accepted_per_slot
  on assignments (organization_id, target_type, target_id, role, slot)
  where status in ('accepted', 'completed');
-- A person holds at most one live assignment for the same slot.
create unique index assignments_one_live_per_person_slot
  on assignments (organization_id, target_type, target_id, role, slot, person_id)
  where status in ('proposed', 'offered', 'accepted');
create index assignments_target_idx on assignments (organization_id, target_type, target_id, role, slot);
create index assignments_person_idx on assignments (organization_id, person_id, scheduled_start);
create index assignments_event_idx on assignments (organization_id, scheduling_event_id)
  where scheduling_event_id is not null;
create trigger assignments_touch before update on assignments
  for each row execute function touch_updated_at();
create trigger assignments_no_delete before delete on assignments
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Fee export batches (SPK-STAFF-006): an immutable record of what was handed to payment
-- administration. Exporting is not payroll execution (§1.7, DEC-052).
-- ---------------------------------------------------------------------------------------------
create table fee_export_batches (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  submission_count integer not null check (submission_count >= 1),
  total_minor bigint not null check (total_minor >= 0),
  lines jsonb not null,
  note text check (note is null or length(note) between 1 and 2000),
  created_by jsonb not null,
  created_by_person_id uuid,
  operation_id uuid references operations(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, currency)
);
create trigger fee_export_batches_append_only before update or delete on fee_export_batches
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Fee submissions (SPK-STAFF-006): assignment, rate basis, submitted amount, approver, current
-- approved amount, export status. submitted → approved | adjusted | rejected; approved → adjusted;
-- adjusted → adjusted; approved | adjusted → exported. One live submission per assignment.
-- ---------------------------------------------------------------------------------------------
create table fee_submissions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  assignment_id uuid not null,
  person_id uuid not null,
  rate_basis jsonb not null,
  computed_amount_minor bigint not null check (computed_amount_minor >= 0),
  submitted_amount_minor bigint not null check (submitted_amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  note text check (note is null or length(note) between 1 and 2000),
  status text not null default 'submitted'
    check (status in ('submitted', 'approved', 'adjusted', 'rejected', 'exported')),
  submitted_by jsonb not null,
  submitted_at timestamptz not null,
  approved_amount_minor bigint check (approved_amount_minor is null or approved_amount_minor >= 0),
  approver jsonb,
  approver_person_id uuid,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  export_batch_id uuid,
  exported_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, assignment_id) references assignments (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  -- the batch's currency must be the submission's currency
  foreign key (organization_id, export_batch_id, currency) references fee_export_batches (organization_id, id, currency),
  check (status not in ('approved', 'adjusted', 'exported')
         or (approved_amount_minor is not null and approver is not null and approved_at is not null)),
  check (status <> 'rejected' or (rejected_at is not null and rejection_reason is not null)),
  check ((status = 'exported') = (export_batch_id is not null and exported_at is not null))
);
create unique index fee_submissions_one_live_per_assignment
  on fee_submissions (organization_id, assignment_id) where status <> 'rejected';
create index fee_submissions_status_idx on fee_submissions (organization_id, status, currency);
create index fee_submissions_person_idx on fee_submissions (organization_id, person_id);
create trigger fee_submissions_touch before update on fee_submissions
  for each row execute function touch_updated_at();
create trigger fee_submissions_no_delete before delete on fee_submissions
  for each row execute function forbid_mutation();

-- Adjustment history (append-only): every change of the approved amount is a new row.
create table fee_adjustments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fee_submission_id uuid not null,
  sequence integer not null check (sequence >= 1),
  previous_amount_minor bigint not null check (previous_amount_minor >= 0),
  adjusted_amount_minor bigint not null check (adjusted_amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null check (length(reason) between 1 and 2000),
  adjusted_by jsonb not null,
  adjusted_by_person_id uuid,
  adjusted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, fee_submission_id, sequence),
  foreign key (organization_id, fee_submission_id) references fee_submissions (organization_id, id)
);
create trigger fee_adjustments_append_only before update or delete on fee_adjustments
  for each row execute function forbid_mutation();
