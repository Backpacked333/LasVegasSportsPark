-- 1007_communications_reminder_kinds.sql
-- Communications module (COM-06): availability request notices and activity reminders
-- (SPK-CAP-001 "request availability, remind", SPK-COMMS-002, SPK-COMMS-005).
--
-- 1. Two operational notification kinds: 'availability_request' (a captain or league staff asked
--    players for their availability) and 'activity_reminder' (an upcoming activity). The kind
--    check of migration 1000 (named notifications_kind_check) is replaced with the same list plus
--    the two kinds; NotificationKindSchema lists exactly these.
-- 2. reminder_marks: one row per (scheduling event, event revision) reminded. The reminder job
--    inserts it in the same transaction as the notice, so a replayed pass or a second worker
--    composes nothing for a revision already reminded; a moved event (a new revision) is reminded
--    again with its new details. Append-only.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'registration_outcome', 'team_invitation', 'placement', 'waitlist_offer',
  'schedule_published', 'schedule_changed', 'cancellation', 'payment_attention',
  'assignment_offer', 'result_published', 'renewal_opportunity', 'youth_feedback',
  'staff_broadcast', 'availability_request', 'activity_reminder'
));

create table reminder_marks (
  organization_id uuid not null references organizations(id),
  scheduling_event_id uuid not null,
  event_revision integer not null check (event_revision >= 1),
  composed_at timestamptz not null,
  primary key (organization_id, scheduling_event_id, event_revision)
);
create trigger reminder_marks_append_only before update or delete on reminder_marks
  for each row execute function forbid_mutation();
