-- 0608_finance_accounting_export.sql
-- FIN-07: accounting export batches (§3.16 Accounting row "approved mappings, export or
-- integration batches, reconciliation, correction handling"; SPK-PAY-010, SPK-PAY-011; §5.2
-- accounting gate). Behind the per-organization capability `accounting` (DEC-016, DEC-081); the
-- accounting connection itself is pending DEC-022 (only the deterministic fake exists).
--
-- Integrity enforced here:
--   * four eyes: the person who approves a mapping is never the person who proposed it;
--   * one approved mapping per ledger account; no default mapping exists;
--   * at-most-once export: a journal entry has at most one live export line (partial unique
--     index); export lines are never deleted, and the only change is live true -> false while
--     their batch is rejected or canceled (so the entry can be exported again);
--   * batch facts follow the AccountingExportBatchMachine and their status (submitted_at present
--     exactly when the batch was handed over, a provider reference on every accepted batch).
-- Corrections are later journals (SPK-PAY-010) exported in a later batch; an exported batch never
-- changes. Revenue recognition is not done here (DEC-022).

create table accounting_mappings (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  ledger_account text not null check (ledger_account in (
    'customer_receivable', 'cash_processor', 'deferred_revenue', 'credits_payable',
    'processor_fees', 'refunds', 'cash_on_hand', 'overpayment_liability',
    'pos_revenue', 'taxes_payable', 'fees_payable'
  )),
  external_account_ref text not null check (length(btrim(external_account_ref)) between 1 and 200),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  proposed_by jsonb not null,
  proposed_by_person_id uuid not null,
  approved_by jsonb,
  approved_by_person_id uuid,
  approved_at timestamptz,
  retired_at timestamptz,
  retire_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, proposed_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  constraint accounting_mappings_four_eyes check (
    approved_by_person_id is null or approved_by_person_id <> proposed_by_person_id
  ),
  constraint accounting_mappings_approved_fact check (
    (approved_at is null) = (approved_by_person_id is null)
    and (status <> 'approved' or approved_at is not null)
  ),
  constraint accounting_mappings_retired_fact check (
    (status = 'retired') = (retired_at is not null) and (retired_at is null) = (retire_reason is null)
  )
);
create unique index accounting_mappings_one_approved_idx on accounting_mappings (organization_id, ledger_account)
  where status = 'approved';
create index accounting_mappings_status_idx on accounting_mappings (organization_id, status, created_at desc, id desc);
create trigger accounting_mappings_touch before update on accounting_mappings
  for each row execute function touch_updated_at();

-- AccountingMappingMachine: proposed { approve: approved, withdraw: retired }, approved
-- { retire: retired }; the mapped account, its external reference and the proposer never change.
create or replace function accounting_mappings_guard() returns trigger
language plpgsql as $$
begin
  if new.ledger_account <> old.ledger_account or new.external_account_ref <> old.external_account_ref
     or new.proposed_by_person_id <> old.proposed_by_person_id
     or new.organization_id <> old.organization_id then
    raise exception 'accounting mapping % keeps its account, reference and proposer', old.id
      using errcode = 'check_violation', constraint = 'accounting_mappings_basis_immutable';
  end if;
  if new.status = old.status then
    if old.status <> 'proposed' and (new.approved_by_person_id is distinct from old.approved_by_person_id
       or new.approved_at is distinct from old.approved_at) then
      raise exception 'accounting mapping % approval is final', old.id
        using errcode = 'check_violation', constraint = 'accounting_mappings_machine';
    end if;
    return new;
  end if;
  if (old.status = 'proposed' and new.status in ('approved', 'retired'))
     or (old.status = 'approved' and new.status = 'retired') then
    return new;
  end if;
  raise exception 'accounting mapping % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'accounting_mappings_machine';
end
$$;
create trigger accounting_mappings_guard before update on accounting_mappings
  for each row execute function accounting_mappings_guard();

create table accounting_export_batches (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'submitted', 'accepted', 'rejected', 'unknown', 'canceled')),
  -- The key the accounting connection deduplicates on: a resubmission reuses it.
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  checksum text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  line_count integer not null check (line_count >= 1),
  provider_reference text,
  last_error text,
  prepared_by jsonb not null,
  prepared_by_person_id uuid,
  prepared_at timestamptz not null,
  submitted_at timestamptz,
  decided_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, prepared_by_person_id) references persons (organization_id, id),
  constraint accounting_export_batches_period check (period_start < period_end),
  constraint accounting_export_batches_submitted_fact check (
    (status in ('submitted', 'accepted', 'rejected', 'unknown')) = (submitted_at is not null)
  ),
  constraint accounting_export_batches_accepted_reference check (
    status <> 'accepted' or provider_reference is not null
  ),
  constraint accounting_export_batches_decided_fact check (
    (status in ('accepted', 'rejected')) = (decided_at is not null)
  ),
  constraint accounting_export_batches_canceled_fact check (
    (status = 'canceled') = (canceled_at is not null) and (canceled_at is null) = (cancel_reason is null)
  )
);
create index accounting_export_batches_status_idx
  on accounting_export_batches (organization_id, status, submitted_at);
create index accounting_export_batches_created_idx
  on accounting_export_batches (organization_id, created_at desc, id desc);
create trigger accounting_export_batches_touch before update on accounting_export_batches
  for each row execute function touch_updated_at();

-- AccountingExportBatchMachine: prepared { submit: submitted, cancel: canceled }, submitted
-- { accept: accepted, reject: rejected, lose: unknown }, unknown { accept: accepted, reject:
-- rejected }. The period, key and checksum never change.
create or replace function accounting_export_batches_guard() returns trigger
language plpgsql as $$
begin
  if new.period_start <> old.period_start or new.period_end <> old.period_end
     or new.idempotency_key <> old.idempotency_key or new.checksum <> old.checksum
     or new.line_count <> old.line_count or new.organization_id <> old.organization_id then
    raise exception 'accounting batch % keeps its period, key and content', old.id
      using errcode = 'check_violation', constraint = 'accounting_export_batches_basis_immutable';
  end if;
  if old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference then
    raise exception 'accounting batch % provider reference is final', old.id
      using errcode = 'check_violation', constraint = 'accounting_export_batches_reference_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'prepared' and new.status in ('submitted', 'canceled'))
     or (old.status = 'submitted' and new.status in ('accepted', 'rejected', 'unknown'))
     or (old.status = 'unknown' and new.status in ('accepted', 'rejected')) then
    return new;
  end if;
  raise exception 'accounting batch % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'accounting_export_batches_machine';
end
$$;
create trigger accounting_export_batches_guard before update on accounting_export_batches
  for each row execute function accounting_export_batches_guard();

create table accounting_export_lines (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  batch_id uuid not null,
  journal_entry_id uuid not null,
  line_number integer not null check (line_number >= 1),
  ledger_account text not null,
  external_account_ref text not null check (length(btrim(external_account_ref)) between 1 and 200),
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  posted_at timestamptz not null,
  memo text not null,
  -- The status-carrying column of at-most-once export: true while the batch may still be (or
  -- was) accepted; false once the batch was rejected or canceled.
  live boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, batch_id, line_number),
  foreign key (organization_id, batch_id) references accounting_export_batches (organization_id, id),
  foreign key (organization_id, journal_entry_id) references journal_entries (organization_id, id),
  constraint accounting_export_lines_one_side check ((debit_minor > 0) <> (credit_minor > 0))
);
-- §4.7 invariant 5 at the accounting boundary: a journal entry is exported at most once.
create unique index accounting_export_lines_live_entry_idx
  on accounting_export_lines (organization_id, journal_entry_id) where live;

create or replace function accounting_export_lines_guard() returns trigger
language plpgsql as $$
declare
  batch_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'accounting export line % is never deleted', old.id
      using errcode = 'restrict_violation', constraint = 'accounting_export_lines_guard';
  end if;
  select status into batch_status from accounting_export_batches
   where organization_id = old.organization_id and id = old.batch_id;
  if not (old.live and not new.live)
     or batch_status not in ('rejected', 'canceled')
     or (to_jsonb(new) - 'live') <> (to_jsonb(old) - 'live') then
    raise exception 'accounting export line % only stops being live when its batch is rejected or canceled', old.id
      using errcode = 'restrict_violation', constraint = 'accounting_export_lines_guard';
  end if;
  return new;
end
$$;
create trigger accounting_export_lines_guard before update or delete on accounting_export_lines
  for each row execute function accounting_export_lines_guard();
