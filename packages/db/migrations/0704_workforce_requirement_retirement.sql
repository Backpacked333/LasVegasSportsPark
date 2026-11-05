-- 0704_workforce_requirement_retirement.sql
-- WRK-02 (SPK-COND-003, SPK-STAFF-001/002, §4.7, CLAUDE.md "integrity that matters is enforced in
-- the database"): a requirement that no longer applies (a booking event withdrawn by enrollment
-- through WORKFORCE_STAFFING_PORT, IF-32) is retired, never deleted (the 0700 delete guard stays).
-- Retirement is a recorded fact: when, why and by whom, all three together. A retired requirement
-- is final: it cannot be un-retired or changed, and no assignment can be proposed, offered or
-- accepted against it. Coverage, exceptions, Today and reporting skip retired requirements.

alter table assignment_requirements
  add column retired_at timestamptz,
  add column retired_reason text,
  add column retired_by jsonb,
  add constraint assignment_requirements_retirement_facts check (
    (retired_at is null and retired_reason is null and retired_by is null)
    or (retired_at is not null and retired_reason is not null and retired_by is not null)
  ),
  add constraint assignment_requirements_retired_reason_length check (
    retired_reason is null or length(retired_reason) between 1 and 2000
  );

create index assignment_requirements_active_target_idx
  on assignment_requirements (organization_id, target_type, target_id)
  where retired_at is null;

-- A retired requirement is final: no update of any column (un-retiring included).
create or replace function assignment_requirements_retirement_guard() returns trigger
language plpgsql as $$
begin
  if old.retired_at is not null then
    raise exception 'assignment requirement % is retired and cannot change', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger assignment_requirements_retirement_guard before update on assignment_requirements
  for each row execute function assignment_requirements_retirement_guard();

-- No assignment is proposed, offered or accepted against a retired requirement of its target and
-- role. Withdrawing, declining and completing stay possible (they release the slot). The
-- requirement row is read FOR SHARE, so an assignment racing a retirement either waits for the
-- retirement to commit and is refused, or commits first and is seen (and withdrawn) by the
-- retirement, which locks the requirement before it reads the assignments.
create or replace function assignments_requirement_not_retired() returns trigger
language plpgsql as $$
declare
  retired timestamptz;
begin
  if new.status not in ('proposed', 'offered', 'accepted') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status = old.status then
    return new;
  end if;
  select r.retired_at into retired
    from assignment_requirements r
   where r.organization_id = new.organization_id
     and r.target_type = new.target_type
     and r.target_id = new.target_id
     and r.role = new.role
     for share;
  if found and retired is not null then
    raise exception 'assignment % names the retired % requirement of its target', new.id, new.role
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger assignments_requirement_not_retired
  before insert or update of status on assignments
  for each row execute function assignments_requirement_not_retired();
