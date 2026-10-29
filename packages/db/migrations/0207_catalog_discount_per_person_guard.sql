-- 0207_catalog_discount_per_person_guard.sql
-- Catalog module, CAT-04 (SPK-PAY-003 per-person redemption limit; §4.7 "integrity that matters
-- is enforced in the database"). Until now the per-person limit was enforced by the pricing
-- service from the append-only ledger; the organization-wide limit already had a check on
-- discount_redemptions. This trigger makes the database refuse a redemption beyond the
-- participant's limit, whoever inserts it.
--
-- Before a 'redeem' entry naming a person is inserted, the definition row is locked (so
-- concurrent redemptions of one discount serialize here), the person's redemptions minus their
-- releases are counted, and the insert is refused with check_violation naming
-- discount_redemption_entries_per_person_limit when the count has reached per_person_limit
-- (null: no limit). Releases and redemptions without a person are not limited per person. Under
-- READ COMMITTED each statement of the function takes a fresh snapshot, so the count that follows
-- the lock sees every redemption committed before the lock was granted.

create or replace function discount_redemption_entries_per_person_guard() returns trigger
language plpgsql as $$
declare
  person_limit integer;
  used integer;
begin
  if new.kind <> 'redeem' or new.person_id is null then
    return new;
  end if;
  select per_person_limit into person_limit
    from discount_definitions
   where organization_id = new.organization_id
     and id = new.discount_definition_id
     for update;
  if person_limit is null then
    return new;
  end if;
  select coalesce(sum(case when kind = 'redeem' then 1 else -1 end), 0) into used
    from discount_redemption_entries
   where organization_id = new.organization_id
     and discount_definition_id = new.discount_definition_id
     and person_id = new.person_id;
  if used >= person_limit then
    raise exception 'person % has reached the per-person limit (%) of discount %',
        new.person_id, person_limit, new.discount_definition_id
      using errcode = 'check_violation',
            constraint = 'discount_redemption_entries_per_person_limit',
            table = 'discount_redemption_entries';
  end if;
  return new;
end
$$;

create trigger discount_redemption_entries_per_person_guard
  before insert on discount_redemption_entries
  for each row execute function discount_redemption_entries_per_person_guard();
