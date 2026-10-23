# enrollment module

**Owns:** Applications, enrollments, placement requests, session bookings, capacity pools, holds, allocations, waitlist entries and offers, eligibility evaluation, transfers, pickup sessions, makeups, trials

**Specification:** §3.3 (SPK-REG-001..010), §3.6 (SPK-PLACE-001..005), §3.13 (SPK-YOUTH-001..007), §4.4 Participation/Capacity, §4.7 invariants 2, 3, 7

**Migration range:** `packages/db/migrations/0500_enrollment_*.sql` … `0599`

**Notes:** Capacity is enforced by database constraints; holds expire server-side (SPK-REG-006).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
