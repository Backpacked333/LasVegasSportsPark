-- 0303_scheduling_closure_transition_guard.sql
-- Scheduling module (§4.6 ClosureMachine, §4.7 "integrity that matters is enforced in the
-- database"). The 0302 guard protected only rows already lifted or withdrawn; the database still
-- accepted transitions ClosureMachine forbids out of the non-terminal states (pending -> lifted
-- with no application, active -> pending, active -> withdrawn with applied_at cleared), and a
-- terminal closure's actor snapshot (created_by) could still be rewritten. This file replaces the
-- guard function (0302 stays as applied) so that:
--
-- 1. a status change is one ClosureMachine allows: pending -> active (apply), pending ->
--    withdrawn (withdraw) or active -> lifted (lift);
-- 2. a lifted or withdrawn closure is never rewritten, created_by included;
-- 3. a lifted closure records both its application and its lift (a check).

create or replace function closures_terminal_guard() returns trigger
language plpgsql as $$
begin
  if new.status <> old.status
     and (old.status, new.status) not in (
       ('pending', 'active'),
       ('pending', 'withdrawn'),
       ('active', 'lifted')
     ) then
    raise exception 'closure % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('lifted', 'withdrawn')
     and (new.status <> old.status
          or new.organization_id <> old.organization_id
          or new.facility_id <> old.facility_id
          or new.resource_id is distinct from old.resource_id
          or new.during <> old.during
          or new.reason <> old.reason
          or new.source <> old.source
          or new.created_by <> old.created_by
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

alter table closures
  add constraint closures_lifted_facts
    check (status <> 'lifted' or (applied_at is not null and lifted_at is not null));
