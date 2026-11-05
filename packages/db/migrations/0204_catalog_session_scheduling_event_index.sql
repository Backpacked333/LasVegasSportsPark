-- 0204_catalog_session_scheduling_event_index.sql
-- SPK-AT-009, SPK-SCHED-009: catalog follows the scheduling event that reserves a session's space
-- (a canceled event cancels its linked sessions) and a closure preview resolves the sessions, and
-- through them the enrolled customers, of the events it affects. Both look sessions up by
-- scheduling event.
create index offering_sessions_scheduling_event_idx
  on offering_sessions (organization_id, scheduling_event_id)
  where scheduling_event_id is not null;
