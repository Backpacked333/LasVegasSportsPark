-- 0471_competition_public_adult_divisions.sql
-- Competition module: a competition is made public only when every division of its seasons states
-- that its players are adults (SPK-SCHED-010 "no child's name ... appears", §4.14; proposed
-- amendment PA-06, capability `public_schedule`; the rule is a proposed default pending DEC-100).
--
-- The service rule fails closed (publication-rule.ts): publishing is allowed only when every
-- division is positively known to be an adult division. The only structured fact that says so is
-- the division's age band with a minimum age of 18 or more (`criteria.ageBand.minAge`). This
-- trigger is the database's copy of that structured part: at the moment a competition becomes
-- public it must have at least one division, and no division without a numeric minimum age of 18
-- or more. The wording checks of the service (names that suggest players under 18) are a further
-- refusal on top and stay in the service.
--
-- What this does not do: a division added or changed after the competition is public is not
-- refused here. The public reads judge the competition again on every request and answer "not
-- available" as soon as a division is youth or unknown, so staff can still record the division.
-- Competitions that were public before this migration keep their state; the same re-check
-- decides on every read whether they are served.

create or replace function competitions_public_requires_adult_divisions() returns trigger
language plpgsql as $$
declare
  division_count integer;
  offending text;
begin
  if new.public_visibility <> 'public' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.public_visibility = 'public' then
    return new;
  end if;
  select count(*) into division_count
    from divisions d
    join seasons s on s.organization_id = d.organization_id and s.id = d.season_id
   where s.organization_id = new.organization_id and s.competition_id = new.id;
  if division_count = 0 then
    raise exception 'competition % has no division; nothing says its players are adults', new.id
      using errcode = 'check_violation', constraint = 'competitions_public_adult_divisions';
  end if;
  select d.name into offending
    from divisions d
    join seasons s on s.organization_id = d.organization_id and s.id = d.season_id
   where s.organization_id = new.organization_id
     and s.competition_id = new.id
     and not (
       case
         when jsonb_typeof(d.criteria #> '{ageBand,minAge}') = 'number'
           then (d.criteria #>> '{ageBand,minAge}')::numeric >= 18
         else false
       end
     )
   order by d.name, d.id
   limit 1;
  if found then
    raise exception 'competition % cannot be public: division "%" does not state a minimum age of 18 or more', new.id, offending
      using errcode = 'check_violation', constraint = 'competitions_public_adult_divisions';
  end if;
  return new;
end
$$;
create trigger competitions_public_requires_adult_divisions
  before insert or update of public_visibility on competitions
  for each row execute function competitions_public_requires_adult_divisions();
