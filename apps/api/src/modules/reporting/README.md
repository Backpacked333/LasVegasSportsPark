# reporting module

**Owns:** Metric definitions, derived operating reports, utilization, demand, retention cohorts, exports with independent permission checks

**Specification:** §3.20 (SPK-REPORT-001..007), §4.4 Reporting

**Migration range:** `packages/db/migrations/1300_reporting_*.sql` … `1399`

**Notes:** Reads other modules' records through read models; never writes them.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
