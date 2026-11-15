-- 1014_communications_team_waiting_kinds.sql
-- Communications module (SPK-COMP-006, SPK-COMMS-002): the notices a team's captain and
-- co-captains receive about the team waiting list. Adds two operational notification kinds:
--   'team_place_offer'  a division place was offered to the waiting team (answered in the app);
--   'team_waiting_list' the team was moved onto the waiting list, left it, or its place offer
--                       was accepted, declined, withdrawn or expired.
-- The kind check is replaced with the same list plus the new kinds, and NotificationKindSchema
-- lists exactly these.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'registration_outcome', 'team_invitation', 'placement', 'waitlist_offer',
  'schedule_published', 'schedule_changed', 'cancellation', 'payment_attention',
  'assignment_offer', 'result_published', 'renewal_opportunity', 'youth_feedback',
  'staff_broadcast', 'availability_request', 'activity_reminder', 'result_reminder',
  'team_place_offer', 'team_waiting_list'
));
