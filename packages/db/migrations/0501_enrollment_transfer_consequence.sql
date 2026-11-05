-- 0501_enrollment_transfer_consequence.sql
-- Enrollment module: the financial consequence of a committed transfer is recorded as a fact on
-- the transferred-from enrollment (SPK-REG-010 "refund, credit or additional charge", §4.7
-- invariant 12 "no lost required follow-up after a committed operation", §4.11 steps 7-9).
-- Migration 0500 is applied and immutable; this file adds the column.
--
-- A cancellation already keeps its consequence (`cancellation_consequence`); a transfer kept only
-- the consequence's kind in its audit details and event, so an accepted charge or credit was
-- recorded nowhere. The fact belongs to the row that was transferred, so it is only allowed there.
-- How the charge or credit is executed (automatic obligation or credit, or keeping the new place
-- pending until paid) is DEC-009 (pending); until then a finance follow-up is raised for it.

alter table enrollments add column transfer_consequence jsonb;

alter table enrollments
  add constraint enrollments_transfer_consequence_fact
    check (transfer_consequence is null or status = 'transferred');
