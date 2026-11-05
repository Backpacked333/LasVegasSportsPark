-- 0802_entry_departure_visit_person.sql
-- §4.7 (integrity enforced in the database), SPK-ENTRY-007, SPK-ENTRY-001.
--
-- A departure records the person of the visit it closes. The release foreign key ties a
-- departure's release to `departures.person_id`; this guard ties `departures.person_id` to the
-- visit's person, so a departure can never close child X's visit by naming child Y's release.
-- Visit persons are immutable (visits_guard), so the check made at insert holds for good.
create or replace function departures_visit_person_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from visits v
     where v.organization_id = new.organization_id
       and v.id = new.visit_id
       and v.person_id is not distinct from new.person_id
  ) then
    raise exception 'departure % does not record the person of visit %', new.id, new.visit_id
      using errcode = 'check_violation', constraint = 'departures_visit_person';
  end if;
  return new;
end
$$;
create trigger departures_visit_person_guard before insert on departures
  for each row execute function departures_visit_person_guard();
