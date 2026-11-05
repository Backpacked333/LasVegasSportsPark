-- 0803_entry_activity_reference_checks.sql
-- §4.3, §4.5 (attendance observations), §4.7, CLAUDE.md "references between org-scoped tables use
-- composite foreign keys so a row can never point at another organization's record"
-- (review2 data-and-contracts-2-05).
--
-- 0800's `check (activity_type <> 'event' or scheduling_event_id = activity_id)` passes when
-- scheduling_event_id is null (a null comparison satisfies a check), so an event-type check-in,
-- observation or release could name any activity id, including another organization's event,
-- with no foreign key behind it. Observations and releases are append-only, so such a row could
-- never be corrected. An event activity now always carries the composite-keyed
-- scheduling_event_id; a session release always carries its composite-keyed offering session
-- (0800's release check had the same null hole). The 0800 checks stay: these imply them.
alter table attendance_observations
  add constraint attendance_observations_event_activity
    check (activity_type <> 'event' or (scheduling_event_id is not null and scheduling_event_id = activity_id));
alter table session_checkins
  add constraint session_checkins_event_activity
    check (activity_type <> 'event' or (scheduling_event_id is not null and scheduling_event_id = activity_id));
alter table release_records
  add constraint release_records_event_activity
    check (activity_type is distinct from 'event' or (scheduling_event_id is not null and scheduling_event_id = activity_id)),
  add constraint release_records_session_activity
    check (activity_type is distinct from 'session' or (offering_session_id is not null and offering_session_id = activity_id and offering_id is not null));
