-- 1100_support_core.sql
-- Support module (specification §3.19 SPK-SUPPORT-001..003, §2.3 SPK-UX-006, §4.4 Operations:
-- Case and Exception, SPK-IAM-005 escalation, SPK-AT-026).
--
-- The module owns these tables and is their only writer (§4.2). It references people and
-- households (identity), facilities and access reviews through composite (organization_id, id)
-- foreign keys so a row can never point at another organization's record (§4.3). Kernel tables
-- (operations, audit_records, operational_exceptions) carry no `unique (organization_id, id)`, so
-- references to them are plain foreign keys plus a trigger that refuses a row of another
-- organization. Support never records another module's facts as its own: a case action links to
-- the operation or audit record of a command the owning module executed (SPK-SUPPORT-003).

-- ---------------------------------------------------------------------------------------------
-- Cases (SPK-SUPPORT-002): owner, category, related records, history (case_events) and
-- resolution. The subject person or household is customer-private: the service reports a case a
-- caller may not see as not found (§4.10). Lifecycle (CaseMachine, support.machines.ts):
--   open → waiting_customer | waiting_internal | resolved
--   waiting_customer → open | waiting_internal | resolved
--   waiting_internal → open | waiting_customer | resolved
--   resolved → open (reopen) | closed;   closed is final.
-- ---------------------------------------------------------------------------------------------
create table cases (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid,
  category text not null
    check (category in ('access', 'registration', 'payment', 'schedule', 'team', 'facility', 'other')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open'
    check (status in ('open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed')),
  title text not null check (length(title) between 1 and 200),
  description text check (description is null or length(description) between 1 and 5000),
  subject_person_id uuid,
  subject_household_id uuid,
  owner_person_id uuid,
  owner_queue text check (owner_queue is null or owner_queue ~ '^[a-z][a-z0-9_]{0,63}$'),
  related_records jsonb not null default '[]'::jsonb
    check (jsonb_typeof(related_records) = 'array' and jsonb_array_length(related_records) <= 50),
  -- Cases opened by a hook: a disputed-access escalation (SPK-IAM-005) or an operational exception.
  origin_access_review_id uuid,
  origin_exception_id uuid references operational_exceptions(id),
  due_at timestamptz,
  resolution_kind text
    check (resolution_kind is null or resolution_kind in
      ('action_taken', 'information_provided', 'no_action_needed', 'duplicate', 'customer_unreachable')),
  resolution_summary text check (resolution_summary is null or length(resolution_summary) between 1 and 2000),
  resolved_at timestamptz,
  resolved_by jsonb,
  closed_at timestamptz,
  opened_by jsonb not null,
  opened_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, subject_person_id) references persons (organization_id, id),
  foreign key (organization_id, subject_household_id) references households (organization_id, id),
  foreign key (organization_id, owner_person_id) references persons (organization_id, id),
  foreign key (organization_id, opened_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, origin_access_review_id) references access_reviews (organization_id, id),
  check (num_nonnulls(origin_access_review_id, origin_exception_id) <= 1),
  -- A resolution exists exactly while the case is resolved or closed (reopening clears it).
  check ((status in ('resolved', 'closed')) = (resolution_kind is not null)),
  check ((resolution_kind is null) = (resolution_summary is null)),
  check ((status in ('resolved', 'closed')) = (resolved_at is not null and resolved_by is not null)),
  check ((status = 'closed') = (closed_at is not null))
);
create index cases_status_idx on cases (organization_id, status, priority, created_at);
create index cases_subject_idx on cases (organization_id, subject_person_id, created_at desc)
  where subject_person_id is not null;
create index cases_owner_idx on cases (organization_id, owner_person_id) where status <> 'closed';
create index cases_queue_idx on cases (organization_id, owner_queue) where status <> 'closed';
-- One live case per origin: a replayed escalation hook never opens a second case.
create unique index cases_live_access_review_idx on cases (organization_id, origin_access_review_id)
  where origin_access_review_id is not null and status <> 'closed';
create unique index cases_live_exception_idx on cases (organization_id, origin_exception_id)
  where origin_exception_id is not null and status <> 'closed';
create trigger cases_touch before update on cases
  for each row execute function touch_updated_at();
create trigger cases_no_delete before delete on cases
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Case actions (SPK-SUPPORT-003): a link from a case to the outcome of a normal authorized command
-- of the owning module (refund, permission change, transfer, resend). A note never counts as an
-- action: a succeeded action carries the operation or audit record of the executed command.
-- `via = 'helper'` actions are coordinated by a support operation: the intent is recorded first,
-- the owning module's command runs outside support's transaction, and the outcome (succeeded,
-- failed, or unknown when the process could not learn it) is recorded after. Lifecycle
-- (CaseActionMachine): requested → succeeded | failed | unknown; unknown → succeeded | failed.
-- ---------------------------------------------------------------------------------------------
create table case_actions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  case_id uuid not null,
  action_id text not null check (action_id ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  via text not null check (via in ('linked', 'helper')),
  status text not null check (status in ('requested', 'succeeded', 'failed', 'unknown')),
  command_operation_id uuid references operations(id),
  audit_record_id uuid references audit_records(id),
  support_operation_id uuid references operations(id),
  record_type text check (record_type is null or record_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  record_id text check (record_id is null or length(record_id) between 1 and 200),
  request_key text check (request_key is null or length(request_key) between 8 and 128),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  error jsonb,
  note text check (note is null or length(note) between 1 and 2000),
  actor jsonb not null,
  actor_person_id uuid,
  requested_at timestamptz not null,
  completed_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, case_id) references cases (organization_id, id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  -- SPK-SUPPORT-003: a succeeded action is evidenced by the executed command, never by a note.
  constraint case_actions_succeeded_has_evidence
    check (status <> 'succeeded' or num_nonnulls(command_operation_id, audit_record_id) >= 1),
  check ((status = 'requested') = (completed_at is null)),
  check (status not in ('failed', 'unknown') or error is not null),
  check ((record_type is null) = (record_id is null)),
  check ((via = 'helper') = (support_operation_id is not null)),
  check ((via = 'helper') = (request_key is not null)),
  -- A linked action records a command the operator already ran.
  check (via <> 'linked' or status = 'succeeded')
);
create index case_actions_case_idx on case_actions (organization_id, case_id, requested_at);
-- A helper request is executed at most once per case and idempotency key.
create unique index case_actions_request_key_idx on case_actions (organization_id, case_id, request_key)
  where request_key is not null;
-- The same command outcome is linked to a case once.
create unique index case_actions_operation_once_idx on case_actions (case_id, command_operation_id)
  where command_operation_id is not null;
create unique index case_actions_audit_once_idx on case_actions (case_id, audit_record_id)
  where audit_record_id is not null;
create trigger case_actions_touch before update on case_actions
  for each row execute function touch_updated_at();
create trigger case_actions_no_delete before delete on case_actions
  for each row execute function forbid_mutation();

-- Kernel references must stay inside the organization (the kernel tables have no composite key).
create or replace function case_actions_scope() returns trigger
language plpgsql as $$
begin
  if new.command_operation_id is not null and not exists (
    select 1 from operations o
    where o.id = new.command_operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'case action %: operation % belongs to another organization', new.id, new.command_operation_id
      using errcode = 'foreign_key_violation', constraint = 'case_actions_operation_scope';
  end if;
  if new.support_operation_id is not null and not exists (
    select 1 from operations o
    where o.id = new.support_operation_id and o.organization_id = new.organization_id
  ) then
    raise exception 'case action %: operation % belongs to another organization', new.id, new.support_operation_id
      using errcode = 'foreign_key_violation', constraint = 'case_actions_operation_scope';
  end if;
  if new.audit_record_id is not null and not exists (
    select 1 from audit_records a
    where a.id = new.audit_record_id and a.organization_id = new.organization_id
  ) then
    raise exception 'case action %: audit record % belongs to another organization', new.id, new.audit_record_id
      using errcode = 'foreign_key_violation', constraint = 'case_actions_audit_scope';
  end if;
  return new;
end
$$;
create trigger case_actions_scope before insert or update on case_actions
  for each row execute function case_actions_scope();

-- CaseActionMachine; the action, actor, request and coordination are fixed at creation; a closed
-- case accepts no new action.
create or replace function case_actions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1 from cases c
      where c.organization_id = new.organization_id and c.id = new.case_id and c.status = 'closed'
    ) then
      raise exception 'case % is closed: open a new case to record further actions', new.case_id
        using errcode = 'check_violation', constraint = 'case_actions_case_open';
    end if;
    if new.revision <> 1 then
      raise exception 'case action % must start at revision 1', new.id
        using errcode = 'check_violation', constraint = 'case_actions_revision';
    end if;
    return new;
  end if;
  if new.organization_id <> old.organization_id or new.case_id <> old.case_id
     or new.action_id <> old.action_id or new.via <> old.via or new.actor <> old.actor
     or new.actor_person_id is distinct from old.actor_person_id
     or new.request_key is distinct from old.request_key
     or new.support_operation_id is distinct from old.support_operation_id
     or new.requested_at <> old.requested_at or new.input <> old.input
     or new.created_at <> old.created_at then
    raise exception 'case action %: the action, actor and request are immutable', old.id
      using errcode = 'check_violation', constraint = 'case_actions_immutable';
  end if;
  if old.status in ('succeeded', 'failed') then
    raise exception 'case action % already has its outcome (%)', old.id, old.status
      using errcode = 'check_violation', constraint = 'case_actions_machine';
  end if;
  if new.status <> old.status and not (
    (old.status = 'requested' and new.status in ('succeeded', 'failed', 'unknown'))
    or (old.status = 'unknown' and new.status in ('succeeded', 'failed'))
  ) then
    raise exception 'case action % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'case_actions_machine';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'case action %: every change bumps the revision by one', old.id
      using errcode = 'check_violation', constraint = 'case_actions_revision';
  end if;
  return new;
end
$$;
create trigger case_actions_guard before insert or update on case_actions
  for each row execute function case_actions_guard();

-- CaseMachine and SPK-SUPPORT-003 at the database: a case is created open; transitions follow the
-- machine; a closed case is final; provenance is immutable; resolving a case as `action_taken`
-- requires a succeeded case action (a note cannot stand in for a refund, permission change or
-- transfer).
create or replace function cases_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.revision <> 1 then
      raise exception 'case % must be created open at revision 1', new.id
        using errcode = 'check_violation', constraint = 'cases_machine';
    end if;
    if new.origin_exception_id is not null and not exists (
      select 1 from operational_exceptions e
      where e.id = new.origin_exception_id and e.organization_id = new.organization_id
    ) then
      raise exception 'case %: exception % belongs to another organization', new.id, new.origin_exception_id
        using errcode = 'foreign_key_violation', constraint = 'cases_exception_scope';
    end if;
    return new;
  end if;
  if old.status = 'closed' then
    raise exception 'case % is closed: open a new case', old.id
      using errcode = 'check_violation', constraint = 'cases_closed_final';
  end if;
  if new.organization_id <> old.organization_id or new.opened_by <> old.opened_by
     or new.opened_by_person_id is distinct from old.opened_by_person_id
     or new.origin_access_review_id is distinct from old.origin_access_review_id
     or new.origin_exception_id is distinct from old.origin_exception_id
     or new.created_at <> old.created_at then
    raise exception 'case %: provenance is immutable', old.id
      using errcode = 'check_violation', constraint = 'cases_provenance';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'case %: every change bumps the revision by one', old.id
      using errcode = 'check_violation', constraint = 'cases_revision';
  end if;
  if new.status <> old.status and not (
    (old.status = 'open' and new.status in ('waiting_customer', 'waiting_internal', 'resolved'))
    or (old.status = 'waiting_customer' and new.status in ('open', 'waiting_internal', 'resolved'))
    or (old.status = 'waiting_internal' and new.status in ('open', 'waiting_customer', 'resolved'))
    or (old.status = 'resolved' and new.status in ('open', 'closed'))
  ) then
    raise exception 'case % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'cases_machine';
  end if;
  if new.status = 'resolved' and new.resolution_kind = 'action_taken' and not exists (
    select 1 from case_actions a
    where a.organization_id = new.organization_id and a.case_id = new.id and a.status = 'succeeded'
  ) then
    raise exception 'case % cannot be resolved as action_taken without a succeeded authorized command', old.id
      using errcode = 'check_violation', constraint = 'cases_action_taken_requires_command';
  end if;
  return new;
end
$$;
create trigger cases_guard before insert or update on cases
  for each row execute function cases_guard();

-- ---------------------------------------------------------------------------------------------
-- Case history (append-only): who did what and when — notes, status changes (with the from/to
-- states), assignments, field updates and action links. Corrections are new rows.
-- ---------------------------------------------------------------------------------------------
create table case_events (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  case_id uuid not null,
  sequence integer not null check (sequence >= 1),
  kind text not null check (kind in ('note', 'status', 'assignment', 'update', 'action_link')),
  body text check (body is null or length(body) between 1 and 5000),
  from_status text check (from_status is null or from_status in
    ('open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed')),
  to_status text check (to_status is null or to_status in
    ('open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed')),
  case_action_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  actor jsonb not null,
  actor_person_id uuid,
  occurred_at timestamptz not null,
  unique (organization_id, id),
  unique (case_id, sequence),
  foreign key (organization_id, case_id) references cases (organization_id, id),
  foreign key (organization_id, case_action_id) references case_actions (organization_id, id),
  foreign key (organization_id, actor_person_id) references persons (organization_id, id),
  check (kind <> 'note' or body is not null),
  check ((kind = 'status') = (to_status is not null)),
  check (kind = 'status' or from_status is null),
  check ((kind = 'action_link') = (case_action_id is not null))
);
create index case_events_case_idx on case_events (organization_id, case_id, sequence);
create trigger case_events_append_only before update or delete on case_events
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Exception queues (SPK-UX-006 "owner or responsible queue", §5.11 "operational issues must have
-- owners"): the staff roles that own a queue and its service levels. Kernel operational
-- exceptions name their queue in `owner_queue`; a queue without a row here is owned by the staff
-- role of the same name (the convention every module follows) and has no service level.
-- ---------------------------------------------------------------------------------------------
create table exception_queues (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  description text check (description is null or length(description) between 1 and 500),
  owning_roles text[] not null
    check (cardinality(owning_roles) between 1 and 11
      and owning_roles <@ array['front_desk', 'league_manager', 'program_manager', 'scheduler',
        'finance_operator', 'facilities_operator', 'general_manager', 'system_administrator',
        'support_operator', 'coach', 'official']::text[]),
  acknowledge_within_minutes integer
    check (acknowledge_within_minutes is null or acknowledge_within_minutes between 1 and 43200),
  resolve_within_minutes integer
    check (resolve_within_minutes is null or resolve_within_minutes between 1 and 129600),
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, name),
  check (acknowledge_within_minutes is null or resolve_within_minutes is null
    or acknowledge_within_minutes <= resolve_within_minutes)
);
create trigger exception_queues_touch before update on exception_queues
  for each row execute function touch_updated_at();
create trigger exception_queues_no_delete before delete on exception_queues
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Timeline references (SPK-SUPPORT-001): an append-only index of which records of other modules
-- concern a person (payments and refunds as payer, messages as recipient or subject, schedule
-- changes as a committed party or roster member, orders as payer; support cases of a person merged
-- into this one). It is filled by outbox handlers from the owning modules' events; a person merge
-- appends copies for the surviving person. The timeline reads every record's current state
-- through the owning module's authorized service, never from this table. `summary` holds only
-- non-sensitive change facts (status names, amounts, instants) — never card data, message bodies
-- or child details (§4.14).
-- ---------------------------------------------------------------------------------------------
create table timeline_references (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  record_type text not null
    check (record_type in
      ('payment_attempt', 'refund_attempt', 'order', 'notification', 'scheduling_event', 'support_case')),
  record_id uuid not null,
  relation text not null
    check (relation in ('payer', 'recipient', 'subject', 'committed_party', 'team_member')),
  facility_id uuid,
  occurred_at timestamptz not null,
  source_event_id uuid not null,
  source_event_type text not null check (length(source_event_type) between 3 and 200),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  recorded_at timestamptz not null default now(),
  unique (organization_id, id),
  -- A replayed event never indexes the same record for the same person twice.
  unique (organization_id, source_event_id, person_id, record_type, record_id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create index timeline_references_person_idx
  on timeline_references (organization_id, person_id, occurred_at desc);
create trigger timeline_references_append_only before update or delete on timeline_references
  for each row execute function forbid_mutation();
