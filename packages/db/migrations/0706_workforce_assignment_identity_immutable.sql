-- 0706_workforce_assignment_identity_immutable.sql
-- WRK-02 / SPK-STAFF-001/002 / SPK-STAFF-004, §4.7 (CLAUDE.md "integrity that matters is enforced
-- in the database"). An assignment's identity is fixed when it is inserted: whom it assigns
-- (person, kind), to what (target type and id, the fixture / offering session / offering it names),
-- in which role and slot, and which assignment it replaces. A different person, target, role or slot
-- is a new assignment (the replacement workflow records it with `replaces_assignment_id`); no
-- service ever rewrites these columns, and workforce never rewrites a person id after a merge
-- (WRK-05, reads resolve merges instead).
--
-- Why the database refuses it: `assignments_requirement_not_retired` (0704) picks the requirement it
-- checks by (target_type, target_id, role) and runs when the status moves into
-- proposed/offered/accepted. An UPDATE that kept the status and moved an accepted or offered row
-- onto another target or role (for example one whose requirement is retired) passed every check,
-- and so did one that swapped the person on an accepted assignment past the qualification and
-- commitment checks. With these columns immutable, the retirement check made at insert and at each
-- status change stays true for the row's lifetime.
--
-- Still mutable: status and the facts each state carries, times (`scheduled_start`,
-- `scheduled_end`, `committed_end`) and `scheduling_event_id` (a retime follows the activity; an
-- event target's id stays pinned to it by `assignments_event_target`), `facility_id`, `target_title`,
-- access facts and the revision.
--
-- The trigger fires on every UPDATE (no column list), so a column changed by another BEFORE trigger
-- is compared too.

create or replace function assignments_identity_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.person_id is distinct from old.person_id
     or new.kind is distinct from old.kind
     or new.target_type is distinct from old.target_type
     or new.target_id is distinct from old.target_id
     or new.fixture_id is distinct from old.fixture_id
     or new.offering_session_id is distinct from old.offering_session_id
     or new.offering_id is distinct from old.offering_id
     or new.role is distinct from old.role
     or new.slot is distinct from old.slot
     or new.replaces_assignment_id is distinct from old.replaces_assignment_id then
    raise exception 'assignment % cannot change its person, target, role or slot; record a replacement instead', old.id
      using errcode = 'check_violation', constraint = 'assignments_identity_immutable';
  end if;
  return new;
end
$$;

create trigger assignments_identity_immutable before update on assignments
  for each row execute function assignments_identity_guard();
