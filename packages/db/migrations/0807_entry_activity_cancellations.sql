-- 0807_entry_activity_cancellations.sql
-- ENT-03 / SPK-AT-009 (a canceled session or event withdraws every held or admitted check-in),
-- §4.6 SessionCheckinMachine, §4.7 (integrity that matters is enforced in the database);
-- review finding R2-RACES-06.
--
-- A check-in decides "activity not canceled" from the owning module's state, which entry reads
-- through catalog's and scheduling's services before its transaction opens. The cancellation
-- follow-up withdrew only the check-ins that existed when it ran, so a check-in that committed
-- after the follow-up stayed admitted on a canceled activity, and nothing withdrew it later.
--
-- Entry now records each cancellation it has applied (activity_cancellations: append-only, one row
-- per activity, written by the follow-up) and serializes admission with the follow-up on a
-- transaction-scoped advisory lock per activity, keyed by entry_activity_lock_key():
--   - recording a cancellation takes the lock exclusively (trigger below; the follow-up takes it
--     before recording), then the follow-up withdraws the live check-ins it now sees;
--   - a check-in that becomes admitted (insert, or held → admitted) takes the lock shared, so
--     check-ins of one activity never wait for each other, then is refused when the activity's
--     cancellation is recorded (CheckinsService takes the same lock first and holds such a
--     check-in with the blocking `activity_canceled` issue instead).
-- Whichever commits first, the other sees it: under READ COMMITTED each statement after the lock
-- wait reads a fresh snapshot, so an admission that committed first is withdrawn by the
-- follow-up, and one that comes after is never admitted.

create or replace function entry_activity_lock_key(
  p_organization_id uuid,
  p_activity_type text,
  p_activity_id uuid
) returns bigint
language sql immutable as $$
  select hashtextextended(
    'entry.activity:' || p_organization_id::text || ':' || p_activity_type || ':' || p_activity_id::text,
    0
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- The cancellations entry has applied. The activity is named through its composite-keyed
-- offering session or scheduling event (§4.3: never another organization's activity).
-- ---------------------------------------------------------------------------------------------
create table activity_cancellations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  activity_type text not null check (activity_type in ('session', 'event')),
  activity_id uuid not null,
  offering_session_id uuid,
  scheduling_event_id uuid,
  recorded_at timestamptz not null,
  source text not null check (length(source) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint activity_cancellations_once unique (organization_id, activity_type, activity_id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  constraint activity_cancellations_session_activity check (
    activity_type <> 'session'
    or (offering_session_id is not null and offering_session_id = activity_id and scheduling_event_id is null)
  ),
  constraint activity_cancellations_event_activity check (
    activity_type <> 'event'
    or (scheduling_event_id is not null and scheduling_event_id = activity_id and offering_session_id is null)
  )
);
create trigger activity_cancellations_append_only before update or delete on activity_cancellations
  for each row execute function forbid_mutation();

create or replace function activity_cancellations_lock() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(
    entry_activity_lock_key(new.organization_id, new.activity_type, new.activity_id)
  );
  return new;
end
$$;
create trigger activity_cancellations_lock before insert on activity_cancellations
  for each row execute function activity_cancellations_lock();

-- A check-in is never admitted to an activity whose cancellation entry has recorded.
create or replace function session_checkins_canceled_activity_guard() returns trigger
language plpgsql as $$
begin
  if new.status <> 'admitted' or (tg_op = 'UPDATE' and old.status = 'admitted') then
    return new;
  end if;
  perform pg_advisory_xact_lock_shared(
    entry_activity_lock_key(new.organization_id, new.activity_type, new.activity_id)
  );
  if exists (
    select 1 from activity_cancellations c
    where c.organization_id = new.organization_id
      and c.activity_type = new.activity_type
      and c.activity_id = new.activity_id
  ) then
    raise exception 'session check-in % cannot be admitted: its activity % was canceled',
      new.id, new.activity_id
      using errcode = 'check_violation', constraint = 'session_checkins_activity_canceled';
  end if;
  return new;
end
$$;
create trigger session_checkins_canceled_activity_guard
  before insert or update of status on session_checkins
  for each row execute function session_checkins_canceled_activity_guard();
