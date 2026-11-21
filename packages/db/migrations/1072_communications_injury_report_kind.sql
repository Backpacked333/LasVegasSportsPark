-- 1072_communications_injury_report_kind.sql
-- Communications module (staff S 4d "Coach · report an injury"; SPK-DISC-001, SPK-COMMS-002): when
-- a coach or official reports an injury to a child, the child's guardians (holders of
-- `receive_messages` over the child, re-checked at dispatch) receive an operational notice. Adds
-- the 'injury_report' notification kind. The kind check is replaced with the same list plus the
-- new kind, and NotificationKindSchema lists exactly these.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'registration_outcome', 'team_invitation', 'placement', 'waitlist_offer',
  'schedule_published', 'schedule_changed', 'cancellation', 'payment_attention',
  'assignment_offer', 'result_published', 'renewal_opportunity', 'youth_feedback',
  'staff_broadcast', 'availability_request', 'activity_reminder', 'result_reminder',
  'team_place_offer', 'team_waiting_list', 'injury_report'
));
