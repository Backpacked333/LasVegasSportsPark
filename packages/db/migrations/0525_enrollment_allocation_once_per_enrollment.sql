-- 0525_enrollment_allocation_once_per_enrollment.sql
-- Enrollment module. Proposed amendment PA-03 (SPK-PAY-014); Proposed, open values Pending
-- decision (DEC-097). Capability price_tiers_addons. Quality review finding M-3.
--
-- Where an offering's days can be bought one by one, every live enrollment sits on the seat pool
-- of each session it attends, however it came to exist: an enrollment that attends a session and
-- has no place in its pool (bought before the offering had a tier of chosen days, or for a
-- session scheduled after the purchase) is committed to the pool by the enrollment module before
-- another seat of that session is reserved. The pool row stays the ledger and
-- capacity_pools_within_capacity (committed + held <= capacity) stays the guarantee.
--
-- Invariant enforced here: an enrollment holds at most one active allocation in a pool
-- (allocations_one_per_enrollment_idx). It is what makes that reconciliation safe when two
-- transactions run it at once: the second one can never count the same enrollment a second time,
-- so a pool never reports more seats taken than participants who attend.

create unique index allocations_one_per_enrollment_idx
  on allocations (organization_id, pool_id, enrollment_id)
  where status = 'active' and enrollment_id is not null;
