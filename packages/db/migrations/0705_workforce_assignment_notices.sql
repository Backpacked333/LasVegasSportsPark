-- 0705_workforce_assignment_notices.sql
-- WRK-04 (SPK-COMMS-002 assignment offer, schedule change and cancellation; SPK-COMMS-005
-- "Schedule messages must show old and new practical details", "Suppress obsolete unsent
-- reminders"): what this module told an assignee about an assignment. One row per notice the
-- module composed: the communications notification it became and the activity time it stated.
--
-- A later notice names as "previously" the time the assignee was last told: the newest row whose
-- notification was delivered, or is still to be delivered and is not made obsolete by the notice
-- being composed. Never a time from a notice that was suppressed unsent, and never a time the
-- assignee was not told at all (§4.12: deliveries arrive late and out of order).
--
-- Append-only (a notice told is a fact); `sequence` orders the rows of one assignment, and the
-- handler that appends holds the assignment row lock, so two deliveries cannot take one number.
-- `notification_id` has no foreign key: `notifications` is created by a later migration (1000)
-- and owned by communications, which this module reads only through NotificationsService.
create table assignment_notices (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  assignment_id uuid not null,
  sequence integer not null check (sequence >= 1),
  notice_kind text not null check (notice_kind in ('assignment_offer', 'schedule_changed', 'cancellation')),
  notification_id uuid not null,
  source_event_id uuid not null,
  stated_start timestamptz not null,
  stated_end timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, assignment_id, sequence),
  unique (organization_id, notification_id),
  unique (organization_id, source_event_id),
  foreign key (organization_id, assignment_id) references assignments (organization_id, id),
  check (stated_start < stated_end)
);
create trigger assignment_notices_append_only before update or delete on assignment_notices
  for each row execute function forbid_mutation();
