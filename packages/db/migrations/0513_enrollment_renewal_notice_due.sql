-- 0513_enrollment_renewal_notice_due.sql
-- Enrollment module, ENR-12 (ASYNC-03): when a membership's renewal notice is next worth checking
-- (SPK-COMMS-002 "renewal opportunity", §4.12 durable background work that cannot starve).
--
-- enrollment.membership_lifecycle read confirmed memberships without a notice in term-end order
-- and re-read every one that was not due yet (no lead on its definition, lead not reached, a
-- renewal already pending) at the head of every run, so enough of them could keep a due
-- membership from ever being read. The job now records on each membership the instant its notice
-- becomes due (term end minus the lead), the term end when its definition asks for no notice, or a
-- re-check time while a renewal is pending; candidates are only the never-evaluated and the due.
-- A null value means "not evaluated yet".

alter table enrollments add column renewal_notice_due_at timestamptz;
alter table enrollments add constraint enrollments_renewal_notice_due_only_memberships
  check (renewal_notice_due_at is null or intent = 'membership');
create index enrollments_renewal_candidates_idx
  on enrollments (renewal_notice_due_at, membership_ends_at, id)
  where intent = 'membership' and status = 'confirmed' and renewal_notice_at is null;
