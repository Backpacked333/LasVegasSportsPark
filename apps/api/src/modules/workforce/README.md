# workforce module

**Owns:** Availability, qualifications, assignments (proposed→completed), fee submissions, replacement workflow, time-bounded access

**Specification:** §3.10 (SPK-STAFF-001..006), §4.4 Workforce

**Migration range:** `packages/db/migrations/0700_workforce_*.sql` … `0799`

**Notes:** Exposes AssignmentCoveragePort for match readiness.

Status: scaffold. A module must not alter another module's authoritative records (§4.2); it
calls the other module's exported service (its public API in `index.ts`) instead.
