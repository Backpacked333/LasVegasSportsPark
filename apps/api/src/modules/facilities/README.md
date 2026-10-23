# facilities module

**Owns:** Assets, maintenance tasks, inspections, operating restrictions, release-to-service

**Specification:** §3.17 (SPK-FAC-001..005), §4.4 Facilities

**Migration range:** `packages/db/migrations/0900_facilities_*.sql` … `0999`

**Notes:** Restrictions create scheduling closures through the scheduling authority (SPK-FAC-003/005).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
