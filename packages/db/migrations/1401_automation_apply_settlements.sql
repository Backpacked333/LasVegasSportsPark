-- 1401_automation_apply_settlements.sql
-- Automation stage 3 (AUT-03; specification §4.11 "unknown kept explicit until reconciled",
-- §4.12 durable background work, §4.7 invariant 5, SPK-AUTO-003).
--
-- 1. Stalled requests: `automation.fail_stalled_requests` reads the requests still `processing`
--    oldest first; this partial index keeps that sweep cheap.
-- 2. Apply settlements: when the owning module did not report the outcome of an apply, the
--    recommendation keeps its claim (operation `recovery_required`, exception
--    `automation.apply_outcome_unknown`) until a person records the reconciled outcome from the
--    owning module's records. A settlement is that fact: append-only, one per apply operation, and
--    the only way such a claim ends (applied, or released as not applied).

create index assistant_requests_processing_idx
  on assistant_requests (received_at, id) where status = 'processing';

-- ---------------------------------------------------------------------------------------------
-- Settlements of applies whose outcome was unknown (append-only).
--   outcome `applied`:     the command took effect; the recommendation becomes applied (by the
--                          approving reviewer who ran it), with the settlement's audit record.
--   outcome `not_applied`: it did not; the claim is released and the recommendation may be
--                          applied again or expire.
-- ---------------------------------------------------------------------------------------------
create table recommendation_apply_settlements (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  recommendation_id uuid not null,
  apply_operation_id uuid not null,
  outcome text not null check (outcome in ('applied', 'not_applied')),
  evidence text not null check (length(evidence) between 1 and 2000),
  reason text not null check (length(reason) between 1 and 2000),
  policy_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(policy_references) = 'array'),
  -- A staff person settles (automation.settle_apply); never a system principal (SPK-AUTO-004).
  settled_by jsonb not null
    check (jsonb_typeof(settled_by) = 'object' and settled_by ? 'actorLabel'
      and coalesce(settled_by->>'kind', '') = 'staff'),
  settled_by_account_id uuid not null,
  settled_by_person_id uuid not null,
  settled_at timestamptz not null,
  audit_record_id uuid not null,
  correlation_id text,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  -- One reconciled outcome per apply (§4.7 invariant 5): an unknown apply is settled once.
  constraint recommendation_apply_settlements_one_per_apply unique (apply_operation_id),
  foreign key (organization_id, recommendation_id) references recommendations (organization_id, id),
  foreign key (organization_id, apply_operation_id) references operations (organization_id, id),
  foreign key (organization_id, audit_record_id) references audit_records (organization_id, id),
  foreign key (organization_id, settled_by_account_id) references accounts (organization_id, id),
  foreign key (organization_id, settled_by_person_id) references persons (organization_id, id)
);
create index recommendation_apply_settlements_recommendation_idx
  on recommendation_apply_settlements (organization_id, recommendation_id, settled_at);
create trigger recommendation_apply_settlements_append_only
  before update or delete on recommendation_apply_settlements
  for each row execute function forbid_mutation();

-- A settlement names the apply that holds the recommendation's claim and whose outcome the module
-- recorded as unknown (`last_apply_error.details` of that operation): nothing else can be settled.
create or replace function recommendation_apply_settlements_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from recommendations r
    where r.organization_id = new.organization_id and r.id = new.recommendation_id
      and r.status = 'approved' and r.apply_operation_id = new.apply_operation_id
      and r.last_apply_error->'details'->>'outcome' = 'unknown'
      and r.last_apply_error->'details'->>'operationId' = new.apply_operation_id::text
  ) then
    raise exception 'settlement %: recommendation % holds no apply with an unknown outcome under operation %',
      new.id, new.recommendation_id, new.apply_operation_id
      using errcode = 'check_violation', constraint = 'recommendation_apply_settlements_unknown_apply';
  end if;
  return new;
end
$$;
create trigger recommendation_apply_settlements_guard
  before insert on recommendation_apply_settlements
  for each row execute function recommendation_apply_settlements_guard();

-- On the recommendation: a claim whose outcome is recorded as unknown ends only through its
-- settlement — applied with an `applied` settlement, released with a `not_applied` one — so an
-- unknown apply is never marked applied, retried or dropped on a guess (§4.11).
create or replace function recommendations_unknown_apply_guard() returns trigger
language plpgsql as $$
begin
  if old.apply_operation_id is null
     or coalesce(old.last_apply_error->'details'->>'outcome', '') <> 'unknown'
     or coalesce(old.last_apply_error->'details'->>'operationId', '') <> old.apply_operation_id::text then
    return new;
  end if;
  if new.status = 'applied' and not exists (
    select 1 from recommendation_apply_settlements s
    where s.organization_id = old.organization_id and s.apply_operation_id = old.apply_operation_id
      and s.recommendation_id = old.id and s.outcome = 'applied'
  ) then
    raise exception 'recommendation %: an apply with an unknown outcome becomes applied only through its settlement', old.id
      using errcode = 'check_violation', constraint = 'recommendations_unknown_apply_settled';
  end if;
  if new.apply_operation_id is null and not exists (
    select 1 from recommendation_apply_settlements s
    where s.organization_id = old.organization_id and s.apply_operation_id = old.apply_operation_id
      and s.recommendation_id = old.id and s.outcome = 'not_applied'
  ) then
    raise exception 'recommendation %: the claim of an apply with an unknown outcome is released only through its settlement', old.id
      using errcode = 'check_violation', constraint = 'recommendations_unknown_apply_settled';
  end if;
  -- While the claim is held the recorded unknown outcome stands as written.
  if new.status = old.status and new.apply_operation_id is not distinct from old.apply_operation_id
     and new.last_apply_error is distinct from old.last_apply_error then
    raise exception 'recommendation %: the unknown outcome of a held apply is changed only by its settlement', old.id
      using errcode = 'check_violation', constraint = 'recommendations_unknown_apply_settled';
  end if;
  return new;
end
$$;
create trigger recommendations_unknown_apply_guard
  before update on recommendations
  for each row execute function recommendations_unknown_apply_guard();
