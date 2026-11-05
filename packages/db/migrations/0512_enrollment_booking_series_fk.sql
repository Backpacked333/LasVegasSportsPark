-- 0512_enrollment_booking_series_fk.sql
-- Enrollment module, ENR-13 (INTEGRITY-07): a recurring rental's scheduling series is referenced
-- with the organization-scoped composite key (§4.3, CLAUDE.md data rules), so a booking can never
-- name a series that does not exist or belongs to another organization. Cancellation and change
-- follow-ups look the series up by this id. Scheduling never deletes a series, and the id comes
-- from the scheduling port's createEventSeries result.
--
-- scheduling_event_ids is a uuid[] and cannot carry a foreign key; each element is a scheduling
-- event the port created for this booking.

alter table bookings
  add constraint bookings_scheduling_series_fk
    foreign key (organization_id, scheduling_series_id) references event_series (organization_id, id);
