-- Catalog history guards (SPK-PAY-002 "historical purchases retain their price and policy basis";
-- §4.4 PolicyVersion immutability; CLAUDE.md "integrity that matters is enforced in the database").
--
-- Migration 0200 guarded price rules and policy versions against UPDATE only. This migration adds
-- the guards that do not depend on the current time:
--   * a price rule is never deleted (a superseded rule is closed by its successor, never removed);
--   * a policy version is never deleted once approved (only an unapproved draft may be discarded);
--   * an approved policy version's effective window can only be shortened, never extended or
--     reopened, and a retired version's window is final.
-- Checks against the current instant (a new price rule starting in the past, a retirement that
-- backdates the window) stay in the catalog services, which read the injected Clock: comparing
-- with now() here would disagree with the domain clock.

create trigger price_rules_no_delete before delete on price_rules
  for each row execute function forbid_mutation();

create or replace function policy_versions_no_delete() returns trigger
language plpgsql as $$
begin
  if old.approval_status <> 'draft' then
    raise exception 'policy version % is % and cannot be deleted', old.id, old.approval_status
      using errcode = 'restrict_violation';
  end if;
  return old;
end
$$;
create trigger policy_versions_no_delete before delete on policy_versions
  for each row execute function policy_versions_no_delete();

-- Same rules as 0200, plus the effective_to rules for approved and retired versions.
create or replace function policy_versions_guard() returns trigger
language plpgsql as $$
begin
  if old.approval_status in ('approved', 'retired') then
    if new.content is distinct from old.content
       or new.kind <> old.kind
       or new.key <> old.key
       or new.version <> old.version
       or new.title <> old.title
       or new.effective_from <> old.effective_from then
      raise exception 'policy version % is immutable once approved', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.approval_status = 'draft' then
      raise exception 'policy version % cannot return to draft', old.id
        using errcode = 'restrict_violation';
    end if;
    if old.effective_to is not null and new.effective_to is distinct from old.effective_to
       and (new.effective_to is null or new.effective_to > old.effective_to) then
      raise exception 'policy version % cannot extend its effective window', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  if old.approval_status = 'retired' then
    if new.approval_status <> 'retired' then
      raise exception 'policy version % is retired', old.id using errcode = 'restrict_violation';
    end if;
    if new.effective_to is distinct from old.effective_to then
      raise exception 'policy version % is retired; its effective window is final', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end
$$;
