# reporting module

**Status: implemented** — verified by `apps/api/src/modules/reporting/__tests__` (PGlite and
PostgreSQL through `TEST_DATABASE_URL`) and the unit specs `reporting.spec.ts` and
`calculators/calculators.spec.ts`. Every metric definition, weighting, allocation method,
threshold and period below is **Proposed** (engineering proposal or specification default) until
the named operator decision is answered (`docs/package-a/decision-register.md`).

**Owns:** metric definitions, report runs, exports, agreed cost inputs (§4.2 "Reporting: derived
metrics and exports").

**Specification:** §3.20 SPK-REPORT-001..007, §4.4 Reporting, §4.14 "Expiring exports", §1.2
success measures; metric keys and wording from `docs/package-a/metric-dictionary.md` (MET-###).

**Migration:** `packages/db/migrations/1300_reporting_core.sql` (range 1300–1399).

The module never writes another module's records. It reads them through the read-only
`reporting_*_v` views of migration 1300 (each refuses writes with an INSTEAD OF trigger and exposes
no names, contact details or dates of birth) and through two exported query services: the
competition module's `ReadinessService` (match readiness) and the workforce module's
`ASSIGNMENT_COVERAGE_PORT` (uncovered assignments).

## Tables

| Table                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metric_definitions` | One row per (organization, metric, version) with every SPK-REPORT-001 field as a column: business question, grain, numerator, denominator, time basis, exclusions, dimensions, currency, freshness, access scope (plus unit, requirement ids, pending decisions, definition hash). Seeded from `reporting.metrics.ts`. Exactly one active version per metric (partial unique index); a version is immutable (guard trigger) and never deleted; MetricDefinitionMachine `active → superseded`. |
| `report_runs`        | Append-only (`forbid_mutation`) stored evaluations: report, facility, validated parameters, `reproducible_as_of`, `produced_at`, point-in-time support, access action, actor snapshot, row count (checked against the stored rows), full result, SHA-256 result digest, and for a reproduction the run it reproduces and whether the digests matched.                                                                                                                                         |
| `report_run_metrics` | Append-only links from a run to the exact metric definition versions it cites (composite foreign keys).                                                                                                                                                                                                                                                                                                                                                                                       |
| `exports`            | Requester-bound, single-use, expiring downloads of a run: format `csv/json`, the export action that authorized it, requester account, `requested_at`, `expires_at`, SHA-256 of the one-time token (unique), content digest, row count. ExportMachine `ready → downloaded / expired / revoked` (guard trigger; terminal states final). The database refuses a download recorded at or after `expires_at`.                                                                                      |
| `cost_inputs`        | Agreed direct cost per activity hour for a facility or one space, currency, `effective_from/to`, approval reference and approving actor. GiST exclusion: active inputs never overlap for one scope, basis and currency. Amounts and dates immutable; CostInputMachine `active → withdrawn`.                                                                                                                                                                                                   |

Read-only views (migration 1300): persons (kind, merge survivor), household members, events,
conflict units, resource-to-unit mapping, operating hours, closures, reserved units, offerings,
sessions, required forms, acknowledgments, enrollments, session bookings, applications, capacity
pools, holds, waitlist entries and offers, seasons, team entries, roster memberships, fixtures,
assignment requirements, attendance observations, session check-ins, visits, obligations,
installments, credits, payment and refund attempts, receipts, settlements, order lines,
restrictions, maintenance tasks, notifications, delivery attempts, notification recipients.

## Report envelope (every response)

`report` (key, title, requirement ids, view and export actions), `runId`, `asOf`, `producedAt`,
`scope`, validated `parameters` (with the resolved as-of instant), `freshness` (class F1 live / F3
stored run, point-in-time support and its explanation), `metrics` (the full definitions),
`disclosures`, `values` (a null value always carries its reason, rule G13), `columns`, `rows`
(aggregates only; no person-level rows, rule G9). Money is integer minor units with its currency
and is never summed across currencies.

## Endpoints

| Method and path                                                                                                                                           | Action (staff roles from permission matrix C.14, **Proposed**)                                                         | Notes                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /v1/reports/daily-schedule`                                                                                                                          | `reporting.view_operations_reports` (FD, LM, PM, SC, FA, GM, SA, SO)                                                   | MET-001..003                                               |
| `GET /v1/reports/expected-arrivals`                                                                                                                       | operations                                                                                                             | MET-004, MET-006                                           |
| `GET /v1/reports/attendance`                                                                                                                              | operations                                                                                                             | MET-004, MET-007..009, MET-011, MET-012                    |
| `GET /v1/reports/match-readiness`                                                                                                                         | operations                                                                                                             | MET-013..015, live only                                    |
| `GET /v1/reports/uncovered-assignments`                                                                                                                   | operations                                                                                                             | MET-017, MET-018, live only                                |
| `GET /v1/reports/maintenance-restrictions`                                                                                                                | operations                                                                                                             | MET-054, MET-056, MET-057, live only                       |
| `GET /v1/reports/communication-failures`                                                                                                                  | operations (organization-wide)                                                                                         | MET-059..062, live only                                    |
| `GET /v1/reports/waitlist-demand`                                                                                                                         | `reporting.view_demand_reports` (LM, PM, GM, SA)                                                                       | MET-021..023, live only                                    |
| `GET /v1/reports/registration-funnel`                                                                                                                     | demand                                                                                                                 | MET-025, MET-026, MET-028                                  |
| `GET /v1/reports/enrollment-completeness`                                                                                                                 | demand                                                                                                                 | MET-033, MET-034, MET-037, live only                       |
| `GET /v1/reports/demand`                                                                                                                                  | demand                                                                                                                 | MET-086 observed; MET-089 forecast in its own series       |
| `GET /v1/reports/outstanding-obligations`                                                                                                                 | `reporting.view_financial_reports` (FO, GM), organization-wide                                                         | MET-039, MET-040, MET-043, live only                       |
| `GET /v1/reports/payment-reconciliation`                                                                                                                  | financial, organization-wide                                                                                           | MET-045..050, live only                                    |
| `GET /v1/reports/economics`                                                                                                                               | financial                                                                                                              | MET-067, MET-074..077; `allocationMethod` required         |
| `GET /v1/reports/utilization`                                                                                                                             | `reporting.view_utilization` (SC, FO, FA, GM)                                                                          | MET-064..073                                               |
| `GET /v1/reports/retention`                                                                                                                               | `reporting.view_retention` (LM, PM, GM), organization-wide                                                             | MET-079..083, one cohort per request                       |
| `GET /v1/reports/metric-definitions[/{key}]`                                                                                                              | `reporting.read_metric_definitions`                                                                                    | active definitions; a metric's version history             |
| `POST /v1/reports/runs` (idempotent)                                                                                                                      | the report's view action                                                                                               | evaluate and store a run                                   |
| `GET /v1/reports/runs`, `GET /v1/reports/runs/{id}`                                                                                                       | the report's view action, re-checked on every read (protected: NOT_FOUND)                                              | stored run exactly as produced                             |
| `POST /v1/reports/runs/{id}/reproduce` (idempotent)                                                                                                       | the report's view action                                                                                               | re-evaluate at the stored as-of instant; digest comparison |
| `POST /v1/reports/exports` (idempotent)                                                                                                                   | the run's view action AND `reporting.export_operational` (LM, PM, SC, GM, SA) or `reporting.export_financial` (FO, GM) | audited; returns the one-time token                        |
| `GET /v1/reports/exports/{id}`                                                                                                                            | requester only                                                                                                         |                                                            |
| `GET /v1/reports/exports/{id}/download`                                                                                                                   | requester, `X-Export-Token`, view and export actions re-checked                                                        | single use; refused after expiry; audited                  |
| `POST /v1/reports/exports/{id}/revoke` (idempotent)                                                                                                       | requester; `expectedRevision`                                                                                          |                                                            |
| `POST /v1/reports/cost-inputs` (idempotent), `GET /v1/reports/cost-inputs`, `POST /v1/reports/cost-inputs/{id}/withdraw` (idempotent, `expectedRevision`) | `reporting.manage_cost_inputs` / `reporting.read_cost_inputs` (FO, GM)                                                 |                                                            |

Organization scope always comes from the principal; a facility of another organization is not
found. Facility-scoped staff see only their facilities and cannot read organization-wide reports.

## Guarantees and how they are met

- **SPK-REPORT-001** — every report response carries the full definitions of its metrics; a
  stored run links the exact versions (`report_run_metrics`).
- **SPK-REPORT-003** — utilization is measured per conflict unit: a space sums its own units, the
  facility total sums each unit once, so a whole pitch and its halves are never added (rule U1,
  test "whole-field and subdivision reporting count the same physical time once"). Reserved,
  available, observed (overlay, never a denominator) and closure hours are separate; maintenance
  and block events count as unavailability; reserved time outside hours and during closures is
  reported separately. Resource-equivalent utilization weighs whole spaces only (default: one
  conflict unit weighs one, U3) and lists its weights in the disclosures.
- **SPK-REPORT-004** — no per-field-hour figure without a named allocation method (`direct` or
  `pro_rata`, largest-remainder splits, no default, DEC-085); coverage and unallocated sales are
  shown; margin is refused unless agreed cost inputs cover every space and event day.
- **SPK-REPORT-005** — one cohort per request; households (purchases) and participants are
  separate metrics; persons resolve merges to the survivor; not-offered members are counted
  separately and leave the denominator only when asked (K4).
- **SPK-REPORT-006** — observed signals and any forecast are separate columns; the only forecast
  method offered (`trailing_mean`) is an engineering baseline named in the response.
- **SPK-REPORT-007** — a stored run is the reproducible record (append-only, digest); reports whose
  inputs are append-only and clock-stamped (attendance observations and corrections, releases,
  closure applications and lifts, approvals, confirmations, fulfilments) honour the as-of instant,
  so a rerun at the same instant after a correction reproduces the figures (test "reports are
  reproducible after a correction"). Live-only reports refuse a past as-of instant. Exports need
  their own action, are requester-bound, single use, audited at creation, download, revocation and
  expiry, and expire through the `reporting.export_expiry_due` timer.

## Ports, events and handlers

- Consumed: `ReadinessService` (competition), `ASSIGNMENT_COVERAGE_PORT` (workforce); pure
  helpers `currentHeads` / `effectiveState` / `attended` (entry) for attendance after corrections.
- Exported: `ReportsService`, `ReportRunsService`, `ExportsService`, `CostInputsService`,
  `MetricDefinitionsService`, `REPORTING_POLICY`, the calculators (`computeUtilization`,
  `allocateSales`, `cohortOutcome`), output helpers, actions, events, machines, and fixtures
  (`testing/reporting-fixtures.ts`: `createReportRunFixture`, `createExportFixture`,
  `createCostInputFixture`).
- Events (`reporting.events.ts`): `reporting.report_run_recorded`, `reporting.export_created`,
  `reporting.export_expiry_due` (timer), `reporting.export_downloaded`, `reporting.export_expired`,
  `reporting.export_revoked`, `reporting.metric_definition_versioned`,
  `reporting.cost_input_recorded`, `reporting.cost_input_withdrawn`.
- Handler: `reporting.expire_export` on `reporting.export_expiry_due` (idempotent under replay).

## Policy values (`reporting.policy.ts`, **Proposed**)

Export lifetime 24 hours (DEC-060, Operator/privacy owner); operating day from local midnight
(G4, DEC-001); aging bands at 0/30/60/90 days past due (DEC-007); unknown-delivery threshold 60
minutes (DEC-015); at most 366 days per request; hourly start-time bands.

## Known gaps

- §1.2 success measures MET-091..MET-105 (benchmark task metrics, staff exception resolution,
  background work health) are not reports here: benchmark runs belong to the measurement protocol
  (`docs/package-a/competitive-proof-plan.md`) and operational health to the kernel's tables.
- Metrics of the dictionary not computed: MET-005 (arrival issues are evaluated live at check-in),
  MET-010 (reconciled occupancy), MET-016, MET-019, MET-020, MET-024, MET-027, MET-029 to MET-032,
  MET-035, MET-036, MET-038, MET-041, MET-042, MET-044, MET-051 to MET-053, MET-055, MET-058,
  MET-063, MET-078, MET-084, MET-085, MET-087, MET-088, MET-090.
- Reservation creation is not clock-stamped by the scheduling module, so utilization as of an
  earlier instant still includes reservations created later (disclosed in every response);
  roster membership status and session schedules are read as they stand now.
- Report reads do not run in one snapshot transaction (the readiness service reads through its own
  connection); the stored run is the consistent record.
- Retention does not detect children who aged out (age bands are DEC-003) and does not compute
  "not offered" for teams, players, households or rentals.
- The one-time export token is returned by an idempotent command, so the kernel's idempotency store
  keeps that response (server side, until the key expires); a download still needs the
  requester's authenticated session and a re-checked export action.
- Operators cannot edit metric definitions (`reporting.manage_metric_definition` is not
  registered): the code registry is the source and every change is a new version.
- The proposed `reporting.*` actions are not yet reflected in `docs/package-a/permission-matrix.md`
  as implemented.
