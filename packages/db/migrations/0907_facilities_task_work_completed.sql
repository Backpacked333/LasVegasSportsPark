-- 0907_facilities_task_work_completed.sql
-- Facilities module, R4-OPS-MODULES-03 follow-up (SPK-FAC-004 "closing a maintenance task must not
-- silently reopen a field if a separate inspection remains required", SPK-FAC-002 "resolution and
-- inspection").
--
-- The release gate needs a passed inspection that speaks for the work as it now stands. It compared
-- the pass with the task's resolved_at, which closing or resolving an open or assigned task also
-- stamps. A pass that found the area fit therefore went stale the moment the operator closed the
-- task, although no work had happened after it. work_completed_at records the instant the task's
-- work last ended: it is set when the task leaves in_progress (resolved or closed from in_progress)
-- and kept otherwise, and the gate compares the pass with the later of the restriction's approval
-- and work_completed_at.
--
-- The column belongs to a task that has been at work: an open or assigned task never carries it
-- (a task that has left in_progress is resolved, closed, or back in_progress).
--
-- Existing resolved and closed tasks take their resolved_at, the instant the gate used until now,
-- so no stored pass counts for more than it did before this migration.

alter table maintenance_tasks
  add column work_completed_at timestamptz,
  add constraint maintenance_tasks_work_completed_state
    check (work_completed_at is null or status in ('in_progress', 'resolved', 'closed'));

update maintenance_tasks
   set work_completed_at = resolved_at
 where status in ('resolved', 'closed');
