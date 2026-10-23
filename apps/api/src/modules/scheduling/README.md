# scheduling module

**Owns:** Resources, configurations, conflict units, events, reservations, schedule drafts, publication, closures, recurrence

**Specification:** §3.7 (SPK-SCHED-001..009), §3.8 fixture generation inputs (SPK-FIX-001..005), §4.4 Scheduling, §4.7 invariant 4

**Migration range:** `packages/db/migrations/0300_scheduling_*.sql` … `0399`

**Notes:** Exclusion constraints on (organization, conflict unit, occupied interval). Exposes ReservationPort to competition, facilities, enrollment.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
