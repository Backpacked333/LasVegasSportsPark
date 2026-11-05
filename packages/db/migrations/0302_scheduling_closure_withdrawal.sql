-- 0302_scheduling_closure_withdrawal.sql
-- Scheduling module: withdrawal of a pending closure (SCH-01; SPK-FAC-003, SPK-SCHED-009, §4.6
-- ClosureMachine `withdraw`, §4.7 "integrity that matters is enforced in the database").
--
-- A pending closure that is no longer needed is withdrawn before it ever applies: it never
-- affected availability, and it can never be applied afterwards. Migration 0300 listed the
-- `withdrawn` state but recorded nothing about who withdrew a closure, when, or why, and nothing
-- stopped a later UPDATE from reopening a finished closure. This file adds:
--
-- 1. The withdrawal facts: `withdrawn_at`, `withdrawn_by` (actor snapshot, like `created_by`) and
--    `withdrawal_reason` (1 to 2000 characters, the command reason).
-- 2. Checks: a closure is `withdrawn` exactly when it has a withdrawal instant; a withdrawn closure
--    names its actor and reason; a withdrawn closure was never applied.
-- 3. A guard trigger: `lifted` and `withdrawn` are terminal (ClosureMachine), so a closure in
--    either state is never rewritten (no status change out of it, no change to its interval,
--    area, facts, impact or resolution). Corrections are new closures.

alter table closures
  add column withdrawn_at timestamptz,
  add column withdrawn_by jsonb,
  add column withdrawal_reason text;

alter table closures
  add constraint closures_withdrawal_reason_length
    check (withdrawal_reason is null or char_length(withdrawal_reason) between 1 and 2000),
  add constraint closures_withdrawn_iff_withdrawn_at
    check ((status = 'withdrawn') = (withdrawn_at is not null)),
  add constraint closures_withdrawal_facts
    check (status <> 'withdrawn' or (withdrawn_by is not null and withdrawal_reason is not null)),
  add constraint closures_withdrawn_never_applied
    check (status <> 'withdrawn' or applied_at is null);

create or replace function closures_terminal_guard() returns trigger
language plpgsql as $$
begin
  if old.status in ('lifted', 'withdrawn')
     and (new.status <> old.status
          or new.organization_id <> old.organization_id
          or new.facility_id <> old.facility_id
          or new.resource_id is distinct from old.resource_id
          or new.during <> old.during
          or new.reason <> old.reason
          or new.source <> old.source
          or new.impact is distinct from old.impact
          or new.resolution is distinct from old.resolution
          or new.applied_at is distinct from old.applied_at
          or new.lifted_at is distinct from old.lifted_at
          or new.withdrawn_at is distinct from old.withdrawn_at
          or new.withdrawn_by is distinct from old.withdrawn_by
          or new.withdrawal_reason is distinct from old.withdrawal_reason
          or new.revision <> old.revision) then
    raise exception 'closure % is % and final', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger closures_terminal_guard before update on closures
  for each row execute function closures_terminal_guard();
