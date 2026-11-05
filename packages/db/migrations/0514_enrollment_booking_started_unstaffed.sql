-- 0514_enrollment_booking_started_unstaffed.sql
-- Enrollment module, ENR-13 (ASYNC-10): the lifecycle job raises the critical
-- enrollment.booking_started_unstaffed exception once per unstaffed episode (SPK-UX-006, §4.12).
--
-- The job relied on the exception's open-only deduplication, so once a scheduler resolved the
-- exception (cover arranged off-system) the next run raised a new critical one, every run until
-- the booking ended; and every such booking stayed in the job's due set from its first start to
-- its last end, so enough of them filled the batch and starved request expiries and completions.
-- started_unstaffed_at records that the exception was raised for the current awaiting_staff
-- episode; the due query leaves those bookings out, and the column is cleared when the booking is
-- covered again, so a later loss of staff is raised anew.

alter table bookings add column started_unstaffed_at timestamptz;
