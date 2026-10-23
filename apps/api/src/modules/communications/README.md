# communications module

**Owns:** Notifications, delivery attempts, preferences, acknowledgments, audiences, calendar feed authorizations

**Specification:** §3.18 (SPK-COMMS-001..008), §4.4 Communications, §4.7 invariant 10

**Migration range:** `packages/db/migrations/1000_communications_*.sql` … `1099`

**Notes:** Rechecks recipient authority before external dispatch (SPK-COMMS-003).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
