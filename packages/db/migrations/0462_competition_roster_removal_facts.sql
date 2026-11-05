-- 0462_competition_roster_removal_facts.sql
-- R4-DB-INVARIANTS-10 follow-up (SPK-COMP-005, §4.7 invariant 9 no silent rewriting of history).
-- 0461 let an open roster row close with any status of 'removed' and any prior status, or close
-- with no removal at all. statusAt() reads status_before_removal for a removed row, so either
-- update silently rewrote the status the row conferred over its whole past window (guest and
-- multi-team limits, opposing roster, readiness and the reporting roster view all read it), and a
-- playing row could vanish from past rosters with no actor or reason. Closing an open row is now
-- tied to the row being closed:
--
--   * a playing row ('active', 'guest', 'substitute') closes only as a recorded removal: status
--     'removed', status_before_removal equal to the status it held, removed_at, removed_by and a
--     removal reason;
--   * a pending row ('invited', 'requested') confers nothing and closes as it was: its status is
--     unchanged and no removal fact is written.
--
-- The rest of 0461 is unchanged (no delete; a closed row never changes; an open row keeps its
-- identity, start, source and who added it; its jersey may change; a still-open row changes status
-- only when it closes). Migration 0461 is applied and immutable, so the function is replaced here.

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
  elsif old.status in ('active', 'guest', 'substitute') then
    -- A playing row closes only as a removal that records the status it held, when, by whom and why.
    if new.status <> 'removed'
       or new.status_before_removal is distinct from old.status
       or new.removed_at is null
       or new.removed_by is null or jsonb_typeof(new.removed_by) = 'null'
       or new.removal_reason is null or btrim(new.removal_reason) = '' then
      raise exception 'a playing roster membership is closed only by a removal of the status it held, with who removed it and why (SPK-COMP-005)'
        using errcode = 'restrict_violation', constraint = 'roster_memberships_open_immutable';
    end if;
  elsif new.status <> old.status
     or new.status_before_removal is not null
     or new.removed_at is not null
     or new.removed_by is not null
     or new.removal_reason is not null then
    -- A pending invitation or join request conferred no status; it closes as it was.
    raise exception 'a pending roster membership is closed as it was; it records no removal (SPK-COMP-005)'
      using errcode = 'restrict_violation', constraint = 'roster_memberships_open_immutable';
  end if;
  return new;
end
$$;
