-- 0903_facilities_restriction_withdrawal.sql
-- Facilities module: withdrawal of a restriction before it takes effect (FAC-01; SPK-FAC-003,
-- SPK-FAC-004, §4.6 RestrictionMachine `withdraw`, §4.7 "integrity that matters is enforced in the
-- database"). Migration 0900 is applied and immutable.
--
-- A proposed restriction, or an approved one whose scheduling closure is still pending, that is no
-- longer needed is withdrawn: it never affected availability and can never be approved, activated
-- or released afterwards. The pending closure is withdrawn through the scheduling closure port in
-- the same unit of work (facilities never writes scheduling tables, §4.2). An active restriction is
-- returned to service through the authorized release instead (SPK-FAC-004). This file adds:
--
-- 1. The `withdrawn` state in the status check and the withdrawal facts: `withdrawn_at`,
--    `withdrawn_by` (actor snapshot, like `approved_by` / `released_by`) and `withdrawal_reason`
--    (1 to 2000 characters, the command reason).
-- 2. The approval-fact check of 0900, `(status = 'proposed') = (approved_at is null)`, would refuse
--    a withdrawn proposal (no approval, not proposed). It is replaced by its two halves: a proposed
--    restriction carries no approval, and approved, active and released ones always do. A
--    withdrawn restriction carries approval facts exactly when it was withdrawn after approval.
-- 3. Checks: a restriction is `withdrawn` exactly when it has a withdrawal instant; a withdrawn
--    restriction names its actor and reason; a withdrawn restriction never took effect (no conflict
--    units derived at activation; 0900 already keeps release facts off every non-released row).
-- 4. One unreleased restriction per task now ignores withdrawn ones too, so a task whose proposal
--    was withdrawn may carry a new restriction.
-- 5. A guard trigger: `released` and `withdrawn` are terminal (RestrictionMachine), so a row in
--    either state is never rewritten. Corrections are new restrictions.

alter table restrictions
  add column withdrawn_at timestamptz,
  add column withdrawn_by jsonb,
  add column withdrawal_reason text;

-- The column check of 0900 (named by PostgreSQL after the column) and the generated table check
-- `(status = 'proposed') = (approved_at is null)`, whose name depends on its position in 0900, are
-- found in pg_constraint by their definition. Exactly one of each must exist: anything else means
-- the schema is not the one 0900 created, and the migration stops instead of guessing.
do $$
declare
  found_status integer := 0;
  found_approval integer := 0;
  c record;
begin
  for c in
    select conname, regexp_replace(pg_get_constraintdef(oid), '[[:space:]()]', '', 'g') as def
    from pg_constraint
    where conrelid = 'restrictions'::regclass and contype = 'c'
  loop
    if c.def = 'CHECKstatus=ANYARRAY[''proposed''::text,''approved''::text,''active''::text,''released''::text]' then
      found_status := found_status + 1;
      execute format('alter table restrictions drop constraint %I', c.conname);
    elsif c.def = 'CHECKstatus=''proposed''::text=approved_atISNULL' then
      found_approval := found_approval + 1;
      execute format('alter table restrictions drop constraint %I', c.conname);
    end if;
  end loop;
  if found_status <> 1 or found_approval <> 1 then
    raise exception 'restrictions: expected the 0900 status and approval checks once each, found % and %',
      found_status, found_approval;
  end if;
end
$$;

alter table restrictions
  add constraint restrictions_status_check
    check (status in ('proposed', 'approved', 'active', 'released', 'withdrawn')),
  add constraint restrictions_proposed_unapproved
    check (status <> 'proposed' or approved_at is null),
  add constraint restrictions_approval_facts
    check (status not in ('approved', 'active', 'released') or approved_at is not null),
  add constraint restrictions_withdrawal_reason_length
    check (withdrawal_reason is null or char_length(withdrawal_reason) between 1 and 2000),
  add constraint restrictions_withdrawn_iff_withdrawn_at
    check ((status = 'withdrawn') = (withdrawn_at is not null)),
  add constraint restrictions_withdrawal_facts
    check (status <> 'withdrawn' or (withdrawn_by is not null and withdrawal_reason is not null)),
  add constraint restrictions_withdrawn_never_active
    check (status <> 'withdrawn' or cardinality(affected_conflict_unit_ids) = 0);

-- SPK-FAC-002: a maintenance record carries at most one unreleased operating restriction; a
-- withdrawn restriction no longer counts.
drop index restrictions_open_task_idx;
create unique index restrictions_open_task_idx on restrictions (organization_id, task_id)
  where task_id is not null and status not in ('released', 'withdrawn');

create or replace function restrictions_terminal_guard() returns trigger
language plpgsql as $$
begin
  if old.status in ('released', 'withdrawn')
     and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'restriction % is % and final', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger restrictions_terminal_guard before update on restrictions
  for each row execute function restrictions_terminal_guard();
