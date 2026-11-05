-- support-migration-09 (§4.7 invariant 12, SPK-SUPPORT-003): a case cannot be closed while one of
-- its actions is still 'requested' or 'unknown', because the outcome could then never be recorded
-- on the case. Same rules as 1100_support_core.sql's cases_guard plus that one; the service refuses
-- first with RESOURCE_CONFLICT / ACTION_OUTCOME_UNKNOWN.
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
  if new.status = 'closed' and old.status <> 'closed' and exists (
    select 1 from case_actions a
    where a.organization_id = new.organization_id and a.case_id = new.id
      and a.status in ('requested', 'unknown')
  ) then
    raise exception 'case % has an action whose outcome is not recorded; settle it before closing', old.id
      using errcode = 'check_violation', constraint = 'cases_close_requires_settled_actions';
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
