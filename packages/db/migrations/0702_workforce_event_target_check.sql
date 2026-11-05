-- 0702_workforce_event_target_check.sql
-- §4.3, §4.7, CLAUDE.md "references between org-scoped tables use composite foreign keys so a row
-- can never point at another organization's record" (review2 data-and-contracts-2-05).
--
-- 0700's `check (target_type <> 'event' or scheduling_event_id = target_id)` passes when
-- scheduling_event_id is null (a null comparison satisfies a check), so an event-type requirement
-- or assignment could name any target id, including another organization's event, with no foreign
-- key behind it. An event target now always carries the composite-keyed scheduling_event_id. The
-- 0700 checks stay: these imply them.
alter table assignment_requirements
  add constraint assignment_requirements_event_target
    check (target_type <> 'event' or (scheduling_event_id is not null and scheduling_event_id = target_id));
alter table assignments
  add constraint assignments_event_target
    check (target_type <> 'event' or (scheduling_event_id is not null and scheduling_event_id = target_id));
