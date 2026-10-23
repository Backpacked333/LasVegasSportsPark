# support module

**Owns:** Support cases, customer timeline (scoped), operational exception workflows and queues

**Specification:** §3.19 (SPK-SUPPORT-001..003), §2.3 SPK-UX-006, §4.4 Operations (Case, Exception)

**Migration range:** `packages/db/migrations/1100_support_*.sql` … `1199`

**Notes:** Support actions call the normal authorized commands of other modules (SPK-SUPPORT-003).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
