-- 0521_enrollment_registration_selections.sql
-- Enrollment module. Proposed amendment PA-03 (SPK-PAY-014); Proposed, open values Pending
-- decision (DEC-097). Capability price_tiers_addons.
--
-- A basket line, and the enrollment it becomes, may name the price tier it was bought under
-- (catalog 0215) and, where the tier lets the customer choose, the sessions the participant
-- attends. selected_session_ids null means "every session of the offering", which is every line
-- and enrollment written before this migration and every tier of all sessions; an array is the
-- day selection of a tier of chosen sessions. Attendance lists, notices and capacity read it:
-- a participant counts only on the sessions they selected.
--
-- Invariants enforced here (the enrollment service checks the same first):
--   * the tier is a tier of the line's own offering and organization (composite foreign key over
--     organization, offering and tier: basket_lines_price_tier_fk, enrollments_price_tier_fk);
--   * a day selection needs a tier (…_selection_needs_tier);
--   * a selection is not empty, lists each session once, and every session is a session of the
--     line's offering in the same organization (trigger registration_selection_guard; an array
--     cannot carry a foreign key);
--   * the tier and selection of a basket line and of an enrollment never change after they are
--     written (basket_lines_selection_immutable, enrollments_selection_immutable): a line is
--     removed and added again, and what was bought is what is attended.

alter table basket_lines
  add column price_tier_id uuid,
  add column selected_session_ids uuid[],
  add constraint basket_lines_price_tier_fk
    foreign key (organization_id, offering_id, price_tier_id)
    references price_rule_tiers (organization_id, offering_id, id),
  add constraint basket_lines_selection_needs_tier
    check (selected_session_ids is null or price_tier_id is not null);

alter table enrollments
  add column price_tier_id uuid,
  add column selected_session_ids uuid[],
  add constraint enrollments_price_tier_fk
    foreign key (organization_id, offering_id, price_tier_id)
    references price_rule_tiers (organization_id, offering_id, id),
  add constraint enrollments_selection_needs_tier
    check (selected_session_ids is null or price_tier_id is not null);

create or replace function registration_selection_guard() returns trigger
language plpgsql as $$
begin
  if new.selected_session_ids is null then
    return new;
  end if;
  if cardinality(new.selected_session_ids) = 0 then
    raise exception 'a day selection lists at least one session'
      using errcode = 'check_violation', constraint = 'registration_selection_not_empty';
  end if;
  if (select count(distinct s) from unnest(new.selected_session_ids) as s)
     <> cardinality(new.selected_session_ids) then
    raise exception 'a day selection lists each session once'
      using errcode = 'check_violation', constraint = 'registration_selection_distinct';
  end if;
  if exists (
    select 1 from unnest(new.selected_session_ids) as s
     where not exists (
       select 1 from offering_sessions os
        where os.organization_id = new.organization_id
          and os.offering_id = new.offering_id
          and os.id = s
     )
  ) then
    raise exception 'a selected session is not a session of offering %', new.offering_id
      using errcode = 'check_violation', constraint = 'registration_selection_sessions_of_offering';
  end if;
  return new;
end
$$;

create trigger basket_lines_selection_guard
  before insert or update of selected_session_ids, offering_id on basket_lines
  for each row execute function registration_selection_guard();
create trigger enrollments_selection_guard
  before insert or update of selected_session_ids, offering_id on enrollments
  for each row execute function registration_selection_guard();

create or replace function registration_selection_immutable() returns trigger
language plpgsql as $$
begin
  if new.price_tier_id is distinct from old.price_tier_id
     or new.selected_session_ids is distinct from old.selected_session_ids then
    raise exception 'the tier and day selection of % % cannot be changed', tg_table_name, old.id
      using errcode = 'check_violation', constraint = tg_table_name || '_selection_immutable';
  end if;
  return new;
end
$$;
create trigger basket_lines_selection_immutable
  before update of price_tier_id, selected_session_ids on basket_lines
  for each row execute function registration_selection_immutable();
create trigger enrollments_selection_immutable
  before update of price_tier_id, selected_session_ids on enrollments
  for each row execute function registration_selection_immutable();
