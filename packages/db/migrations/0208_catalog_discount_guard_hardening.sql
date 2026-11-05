-- 0208_catalog_discount_guard_hardening.sql
-- Catalog module (SPK-PAY-003 per-person redemption limit; §4.7 "integrity that matters is
-- enforced in the database"). Replaces the 0207 guard function; 0207 stays as applied.
--
-- 1. Lock mode. The guard locked the definition row FOR UPDATE. A release inserts a ledger row
--    whose foreign key takes FOR KEY SHARE on the same definition, and FOR KEY SHARE conflicts
--    with FOR UPDATE, so a redeem holding the definition and waiting for the counter deadlocked
--    with a release holding the counter and waiting on its foreign-key check. The guard (and the
--    service) now take FOR NO KEY UPDATE, which still serializes redemptions of one discount but
--    does not block foreign-key checks; every service path takes the definition before the counter.
-- 2. Releases. A release must reverse a redemption of the same discount, reference and person;
--    an orphan release (or one naming another person) would lower that person's count and let
--    them redeem past the limit. Refused with check_violation
--    discount_redemption_entries_release_matches_redeem.
-- 3. Redemptions without a person. A discount with a per-person limit cannot be counted for a
--    redemption that names no one, so the conservative behaviour applies: refused with
--    check_violation discount_redemption_entries_person_required.

create or replace function discount_redemption_entries_per_person_guard() returns trigger
language plpgsql as $$
declare
  person_limit integer;
  used integer;
begin
  if new.kind = 'release' then
    if not exists (
      select 1
        from discount_redemption_entries r
       where r.organization_id = new.organization_id
         and r.discount_definition_id = new.discount_definition_id
         and r.reference_type = new.reference_type
         and r.reference_id = new.reference_id
         and r.kind = 'redeem'
         and r.person_id is not distinct from new.person_id
    ) then
      raise exception 'release of discount % for % % reverses no redemption of that person',
          new.discount_definition_id, new.reference_type, new.reference_id
        using errcode = 'check_violation',
              constraint = 'discount_redemption_entries_release_matches_redeem',
              table = 'discount_redemption_entries';
    end if;
    return new;
  end if;
  if new.kind <> 'redeem' then
    return new;
  end if;
  select per_person_limit into person_limit
    from discount_definitions
   where organization_id = new.organization_id
     and id = new.discount_definition_id
     for no key update;
  if person_limit is null then
    return new;
  end if;
  if new.person_id is null then
    raise exception 'discount % has a per-person limit; a redemption must name the person',
        new.discount_definition_id
      using errcode = 'check_violation',
            constraint = 'discount_redemption_entries_person_required',
            table = 'discount_redemption_entries';
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
