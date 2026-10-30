-- 0904_facilities_restriction_transition_guard.sql
-- Facilities module (INTEGRITY-05; §4.6 RestrictionMachine "each command must define allowed
-- source state", §4.7 "integrity that matters is enforced in the database", SPK-FAC-003,
-- SPK-FAC-004). Migration 0903 is applied and immutable.
--
-- The 0903 guard froze only rows already released or withdrawn. The database still accepted
-- transitions RestrictionMachine forbids out of the non-terminal states (active -> approved,
-- active -> proposed, approved -> proposed with the approval facts cleared, proposed -> active):
-- an area could stay closed in scheduling while facilities showed an unapproved proposal, and the
-- record of who approved it was erased without a trace. Scheduling closed the same gap for
-- closures in 0303. This file replaces the guard function (the 0903 trigger keeps calling it) so
-- that:
--
-- 1. a status change is one RestrictionMachine allows: proposed -> approved (approve),
--    proposed -> withdrawn (withdraw), approved -> active (activate), approved -> withdrawn
--    (withdraw) or active -> released (release);
-- 2. a released or withdrawn restriction is never rewritten (unchanged from 0903);
-- 3. once approved, what was approved is final: the approval facts (approved_at, approved_by) are
--    never changed or cleared, and neither are the area, interval, kind, reason, links (asset,
--    task, preventive schedule occurrence) or the organization and facility. Only the lifecycle
--    moves on: the status, the closure link, the conflict units derived at activation, the
--    release or withdrawal facts and the operation bookkeeping (operation_id, revision);
-- 4. the scheduling closure link, once recorded, never changes or is cleared (the approval path
--    links its closure only where none is linked yet, and a withdrawal keeps the link);
-- 5. the conflict units derived at activation are final while the restriction is active.
--
-- An update that changes nothing in the status is still allowed in every non-terminal state: the
-- approve, resume and release paths record operation_id and revision without a status change,
-- and the approval links its closure while the restriction is approved.

create or replace function restrictions_terminal_guard() returns trigger
language plpgsql as $$
declare
  lifecycle constant text[] := array[
    'status',
    'scheduling_closure_id',
    'affected_conflict_unit_ids',
    'released_by',
    'released_at',
    'release_reason',
    'withdrawn_at',
    'withdrawn_by',
    'withdrawal_reason',
    'operation_id',
    'revision',
    'updated_at'
  ];
begin
  if new.status <> old.status
     and (old.status, new.status) not in (
       ('proposed', 'approved'),
       ('proposed', 'withdrawn'),
       ('approved', 'active'),
       ('approved', 'withdrawn'),
       ('active', 'released')
     ) then
    raise exception 'restriction % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('released', 'withdrawn')
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'restriction % is % and final', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  if old.approved_at is not null
     and (to_jsonb(new) - lifecycle) is distinct from (to_jsonb(old) - lifecycle) then
    raise exception 'restriction % was approved: its approval and what was approved are final', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.scheduling_closure_id is not null
     and new.scheduling_closure_id is distinct from old.scheduling_closure_id then
    raise exception 'restriction % is linked to closure % and the link is final',
      old.id, old.scheduling_closure_id
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'active'
     and new.affected_conflict_unit_ids is distinct from old.affected_conflict_unit_ids then
    raise exception 'restriction % is active: its conflict units are final', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
