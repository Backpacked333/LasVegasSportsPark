-- 0463_competition_team_role_end_facts.sql
-- R4-DB-INVARIANTS-10 follow-up (SPK-IAM-001 team role, SPK-CAP-001, §4.7 invariant 9). 0461
-- refused ended_by and ended_reason only while a team role stayed open and accepted any close, so
-- an open captain or co-captain role could be ended, even back to its own start so that it covers
-- no instant, with no record of who ended it or why: the authority TEAM_AUTHORITY_PORT reads for
-- past instants was erased silently. A role now ends only together with its end facts: ended_by
-- (the actor) and a non-blank ended_reason, as the handover command already writes them.
--
-- The rest of 0461 is unchanged (no delete; an ended role never changes; an open role keeps its
-- person, entry, role, start and who assigned it). Migration 0461 is applied and immutable, so the
-- function is replaced here.

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
  if new.effective_to is null then
    if new.ended_by is distinct from old.ended_by or new.ended_reason is distinct from old.ended_reason then
      raise exception 'a team role records how it ended only when it ends'
        using errcode = 'restrict_violation', constraint = 'team_roles_open_immutable';
    end if;
  elsif new.ended_by is null or jsonb_typeof(new.ended_by) = 'null'
     or new.ended_reason is null or btrim(new.ended_reason) = '' then
    raise exception 'a team role ends only with who ended it and why (SPK-IAM-001)'
      using errcode = 'restrict_violation', constraint = 'team_roles_open_immutable';
  end if;
  return new;
end
$$;
