-- 0905_facilities_restriction_delete_guard.sql
-- Facilities module, R2-SCHEMA-01 (§4.7 invariant 9 no silent rewriting of history, §4.6
-- RestrictionMachine, SPK-FAC-003, SPK-FAC-004; the facilities half of the finding whose
-- enrollment half is 0517).
--
-- 0903 and 0904 freeze what an approved, active, released or withdrawn restriction says, but they
-- are BEFORE UPDATE triggers: any writer could still DELETE such a restriction, and the record of
-- who approved closing an area, when and why (and of its release or withdrawal) would vanish while
-- scheduling's closure kept pointing at nothing. A proposed restriction was never approved and may
-- still be deleted; every later state is history and never is (the service deletes nothing: a
-- restriction is withdrawn or released, which keeps it). Same shape as policy_versions_no_delete
-- (0201) and progression_recommendations_no_delete (0517).

create or replace function restrictions_no_delete() returns trigger
language plpgsql as $$
begin
  if old.status <> 'proposed' then
    raise exception 'restriction % is % and cannot be deleted', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  return old;
end
$$;
create trigger restrictions_no_delete before delete on restrictions
  for each row execute function restrictions_no_delete();
