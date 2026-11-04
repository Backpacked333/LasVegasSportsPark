-- 0906_facilities_restriction_follow_on.sql
-- Facilities module, R4-OPS-MODULES-02 (SPK-FAC-004 "returning a space to service requires an
-- authorized release", SPK-AT-021 "authorized reopening", SPK-FAC-002 the record's operating
-- restriction, §4.7 integrity in the database).
--
-- A restriction is approved for a bounded interval, and its scheduling closure ends with it. When a
-- repair overruns while the task's inspection is still outstanding, the facilities operator keeps
-- the area closed with a follow-on restriction for the same task that starts where the open one
-- ends, so the inspection gate of the task still decides the release. restrictions_open_task_idx
-- (0900, 0903) allowed one unreleased restriction per task at all, which made that impossible: the
-- only way to keep the area closed was a restriction without the task, which no inspection gates.
--
-- The rule becomes: the unreleased (proposed, approved, active) restrictions of one task never
-- overlap in time. Two restrictions of a task covering the same instant are still refused by the
-- database (exclusion_violation), and released or withdrawn ones still do not count; a follow-on
-- restriction whose interval starts at the end of the open one ([start, end) ranges are adjacent,
-- not overlapping) is accepted.

drop index restrictions_open_task_idx;

alter table restrictions
  add constraint restrictions_open_task_no_overlap
    exclude using gist (organization_id with =, task_id with =, during with &&)
    where (task_id is not null and status not in ('released', 'withdrawn'));
