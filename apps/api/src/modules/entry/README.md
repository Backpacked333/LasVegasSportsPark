# entry module

**Owns:** Visits, session check-ins, attendance observations and corrections, departures, release records (supervised pickup), passes with opaque references, offline observation sync

**Specification:** §3.14 (SPK-ENTRY-001..008), §4.15, §4.4 Arrival

**Migration range:** `packages/db/migrations/0800_entry_*.sql` … `0899`

**Notes:** Pickup authority is verified live through the identity relationship authority (SPK-ENTRY-007).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
