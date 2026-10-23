# automation module

**Owns:** Reviewable recommendations and assistant actions that use the same commands and permissions as other clients

**Specification:** §3.21 (SPK-AUTO-001..005), §4.4 Automation

**Migration range:** `packages/db/migrations/1400_automation_*.sql` … `1499`

**Notes:** Core operations remain usable when this module is disabled (SPK-AUTO-005).

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
