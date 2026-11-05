-- R4-OPS-MODULES-04 (SPK-ENTRY-001 separate, consistent arrival and check-in records;
-- SPK-ENTRY-007; §4.7). Voiding a visit says the arrival never happened. A live (held or admitted)
-- session check-in that names the visit says the person is in a session through that arrival, so
-- the two may not both stand:
--   - a visit is voided only while no live check-in names it (staff withdraw the check-in first,
--     with its own reason, POST /v1/session-checkins/{id}/withdraw);
--   - a live check-in is never written, or linked to a visit, naming a voided visit.
-- Each side locks what the other reads: the check-in guard takes a share lock on the visit row,
-- which conflicts with the void's row update, so a concurrent check-in and void serialize and the
-- second one sees the first (READ COMMITTED re-reads the visit once the lock is granted; each
-- statement of the void guard reads a fresh snapshot). Rows written before this migration are
-- left as they are; only new writes are checked.

create or replace function visits_void_live_checkins_guard() returns trigger
language plpgsql as $$
begin
  if new.status = 'voided' and old.status <> 'voided' and exists (
    select 1 from session_checkins c
    where c.organization_id = new.organization_id
      and c.visit_id = new.id
      and c.status in ('held', 'admitted')
  ) then
    raise exception 'visit % has live session check-ins; withdraw them before voiding the visit', old.id
      using errcode = 'check_violation', constraint = 'visits_void_live_checkins';
  end if;
  return new;
end
$$;
create trigger visits_void_live_checkins_guard before update of status on visits
  for each row execute function visits_void_live_checkins_guard();

create or replace function session_checkins_visit_open_guard() returns trigger
language plpgsql as $$
declare
  visit_status text;
begin
  if new.visit_id is null or new.status not in ('held', 'admitted') then
    return new;
  end if;
  -- A check-in only becomes live when it is written (held → admitted keeps it live), so an update
  -- is checked when it links a visit.
  if tg_op = 'UPDATE' and new.visit_id is not distinct from old.visit_id then
    return new;
  end if;
  select v.status into visit_status from visits v
  where v.organization_id = new.organization_id and v.id = new.visit_id
  for share;
  if visit_status = 'voided' then
    raise exception 'session check-in % cannot name voided visit %', new.id, new.visit_id
      using errcode = 'check_violation', constraint = 'session_checkins_visit_not_voided';
  end if;
  return new;
end
$$;
create trigger session_checkins_visit_open_guard before insert or update of visit_id on session_checkins
  for each row execute function session_checkins_visit_open_guard();
