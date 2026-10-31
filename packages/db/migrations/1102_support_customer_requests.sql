-- 1102_support_customer_requests.sql
-- SUP-01 (SPK-SUPPORT-002, SPK-CAP-001 "contact the operating team", SCR-C-22, SCR-C-38, §4.14;
-- support coverage and routing pending DEC-015): customers open support requests themselves, so
-- a case records how it was opened.
--
--   staff    : opened by a staff member with their own principal (POST /v1/cases)
--   customer : a customer's own request (POST /v1/me/support-requests); the opener is a person of
--              the organization, and the customer reads only the case status (GET /v1/me/cases)
--   hook     : opened to coordinate an origin record (an escalated disputed-access review from the
--              identity hook, or an operational exception)
--
-- How a case was opened is provenance: it never changes (cases_guard below).
alter table cases
  add column opened_via text not null default 'staff'
    check (opened_via in ('staff', 'customer', 'hook'));

-- Existing cases that coordinate an origin record were opened for it. cases_guard refuses any
-- update that does not bump the revision (and every change of a closed case), so this one-time
-- backfill of a new provenance column runs with the module's own row triggers disabled; no other
-- column changes.
alter table cases disable trigger cases_guard;
alter table cases disable trigger cases_touch;
update cases set opened_via = 'hook'
  where num_nonnulls(origin_access_review_id, origin_exception_id) = 1;
alter table cases enable trigger cases_touch;
alter table cases enable trigger cases_guard;

alter table cases
  -- A case opened for an origin record names exactly one origin, and only such a case does.
  add constraint cases_opened_via_origin
    check ((opened_via = 'hook') = (num_nonnulls(origin_access_review_id, origin_exception_id) = 1)),
  -- A customer's request always names the customer who opened it (GET /v1/me/cases reads by it).
  add constraint cases_customer_has_opener
    check (opened_via <> 'customer' or opened_by_person_id is not null);

-- GET /v1/me/cases: the caller's own requests, newest first.
create index cases_opener_idx on cases (organization_id, opened_by_person_id, created_at desc, id desc)
  where opened_by_person_id is not null;
-- GET /v1/cases?origin=staff|customer
create index cases_opened_via_idx on cases (organization_id, opened_via, created_at desc, id desc);

-- cases_guard: the rules of 1101_support_close_requires_settled_actions.sql, with `opened_via`
-- added to the immutable provenance.
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
     or new.opened_via <> old.opened_via
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
