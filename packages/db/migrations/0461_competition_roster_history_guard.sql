-- 0461_competition_roster_history_guard.sql
-- R4-DB-INVARIANTS-10 (SPK-COMP-005 "a player removed today is still part of the roster for an
-- instant last week", §4.7 invariant 9 no silent rewriting of history; same class as the
-- R2-SCHEMA-01 guards). 0400 states that roster memberships are effective-dated and never deleted,
-- and team roles (the captain and co-captain authority TEAM_AUTHORITY_PORT reads) are
-- effective-dated the same way, but both tables only carried their touch triggers: a closed row
-- could be deleted, re-dated or reopened, silently changing who played or who held authority at a
-- past instant. The database now enforces the history:
--
--   * no row is ever deleted;
--   * a closed row (effective_to set) never changes again;
--   * an open row keeps its identity (organization, entry, person), its start, its role or source
--     and who added it; it may only be closed: effective_to set together with its end facts
--     (a roster removal: status 'removed', the prior status, removed_at/by and reason; a team role:
--     ended_by and ended_reason). A roster row's jersey number may change while it is open.
--
-- Migration 0400 is applied and immutable, so the guards are added here.

create or replace function roster_memberships_guard_history() returns trigger
language plpgsql as $$
declare
  end_facts constant text[] := array[
    'effective_to', 'status', 'status_before_removal', 'removed_at', 'removed_by', 'removal_reason'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'roster memberships are history and are never deleted (SPK-COMP-005)'
      using errcode = 'restrict_violation', constraint = 'roster_memberships_no_delete';
  end if;
  if old.effective_to is not null then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'a closed roster membership is history and never changes (SPK-COMP-005)'
        using errcode = 'restrict_violation', constraint = 'roster_memberships_closed_immutable';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - end_facts - 'jersey_number' - 'updated_at')
     is distinct from (to_jsonb(old) - end_facts - 'jersey_number' - 'updated_at') then
    raise exception 'an open roster membership keeps its person, entry, start and source; it may only be closed'
      using errcode = 'restrict_violation', constraint = 'roster_memberships_open_immutable';
  end if;
  if new.effective_to is null then
    -- Still open: its status and end facts stay as they are (a removal closes the row). A removal
    -- that does not close the row, or a removed_at or prior status without one, is left to the
    -- check constraints of 0400, which refuse it.
    if (new.status <> old.status and new.status <> 'removed')
       or new.removed_by is distinct from old.removed_by
       or new.removal_reason is distinct from old.removal_reason then
      raise exception 'an open roster membership changes status only when it is closed'
        using errcode = 'restrict_violation', constraint = 'roster_memberships_open_immutable';
    end if;
  elsif new.status <> old.status and new.status <> 'removed' then
    -- Closing keeps the status the row conferred, or records its removal.
    raise exception 'a roster membership is closed as it was, or removed'
      using errcode = 'restrict_violation', constraint = 'roster_memberships_open_immutable';
  end if;
  return new;
end
$$;
create trigger roster_memberships_guard before update or delete on roster_memberships
  for each row execute function roster_memberships_guard_history();

create or replace function team_roles_guard_history() returns trigger
language plpgsql as $$
declare
  end_facts constant text[] := array['effective_to', 'ended_by', 'ended_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception 'team roles are authority history and are never deleted (SPK-IAM-001)'
      using errcode = 'restrict_violation', constraint = 'team_roles_no_delete';
  end if;
  if old.effective_to is not null then
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'an ended team role is history and never changes (SPK-IAM-001)'
        using errcode = 'restrict_violation', constraint = 'team_roles_closed_immutable';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - end_facts - 'updated_at') is distinct from (to_jsonb(old) - end_facts - 'updated_at') then
    raise exception 'an open team role keeps its person, entry, role and start; it may only be ended'
      using errcode = 'restrict_violation', constraint = 'team_roles_open_immutable';
  end if;
  if new.effective_to is null
     and (new.ended_by is distinct from old.ended_by or new.ended_reason is distinct from old.ended_reason) then
    raise exception 'a team role records how it ended only when it ends'
      using errcode = 'restrict_violation', constraint = 'team_roles_open_immutable';
  end if;
  return new;
end
$$;
create trigger team_roles_guard before update or delete on team_roles
  for each row execute function team_roles_guard_history();
