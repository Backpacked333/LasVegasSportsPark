-- 0519_enrollment_session_booking_cancel_cause.sql
-- Enrollment module, stage-6 rework of R2-JOURNEYS-01 (SPK-AT-009 families are told of a canceled
-- session, SPK-COMMS-002 cancellation notices, §4.12 no follow-up depends on delivery order).
--
-- Since enrollment.follow_session_canceled cancels the bookings of a session the facility canceled,
-- whether a booked participant was still in the audience of communications' "Canceled:" notice
-- depended on which follow-up ran first (the audience read only live bookings), and on the catalog
-- path nobody told the booked family at all. A canceled booking now records who ended it:
-- `customer` (the family, or staff acting for them) or `session_canceled` (the facility canceled
-- the session, directly in the catalog or through a closure). The session audience includes the
-- bookings canceled with the session, and enrollment tells each such family itself. Bookings
-- canceled before this migration keep a null cause (not recorded); only a canceled booking has one.

alter table session_bookings add column cancel_cause text;
alter table session_bookings add constraint session_bookings_cancel_cause_check
  check (cancel_cause is null or cancel_cause in ('customer', 'session_canceled'));
alter table session_bookings add constraint session_bookings_cancel_cause_fact
  check (cancel_cause is null or status = 'canceled');
create index session_bookings_session_canceled_idx on session_bookings (organization_id, session_id)
  where cancel_cause = 'session_canceled';
