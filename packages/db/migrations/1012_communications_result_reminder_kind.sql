-- 1012_communications_result_reminder_kind.sql
-- Communications module (SPK-RESULT-001, SPK-COMMS-002): delivery of the result reminders league
-- staff send to a fixture's captains (`competition.result_reminder_requested`, migration 0466).
-- Adds the operational notification kind 'result_reminder'; the kind check is replaced with the
-- same list plus the new kind, and NotificationKindSchema lists exactly these.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'registration_outcome', 'team_invitation', 'placement', 'waitlist_offer',
  'schedule_published', 'schedule_changed', 'cancellation', 'payment_attention',
  'assignment_offer', 'result_published', 'renewal_opportunity', 'youth_feedback',
  'staff_broadcast', 'availability_request', 'activity_reminder', 'result_reminder'
));
