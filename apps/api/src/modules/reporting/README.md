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

**Migrations:** `packages/db/migrations/1300_reporting_core.sql` (range 1300–1399);
`1301_reporting_actor_keys.sql` (the requester of a run and of an export and the approver of a
cost input are composite keys to accounts and persons of the row's organization; a cost input's
space belongs to its facility); `1302_reporting_space_status_and_order_totals.sql` (space status
history view, order total on the order-line view); `1303_reporting_requirement_retirement.sql`
(REP-03: the requirements view exposes `retired_at`, read from the whole row so it is right
whichever order it and workforce migration 0704 are applied in); `1304_reporting_event_changes.sql`
(R3-REPORTING-01: the scheduling module's `scheduling.event_changed` facts, read-only);
`1305_reporting_pos_money.sql` (R3-REPORTING-04: point-of-sale tenders, late card captures and
returns, read-only); `1306_reporting_team_entry_withdrawals.sql` (R3-REPORTING-08: the team-entry
view gains `withdrawn_at`); `1307_reporting_pos_return_refunds.sql` (R3-REPORTING-04 rework: the
point-of-sale money view gains a card return's `refund_attempt_id`);
`1308_reporting_refund_reversals.sql` (R4-PROVIDER-OUTCOMES-02: the refund view gains
`reversed_at`).

The module never writes another module's records. It reads them through the read-only
`reporting_*_v` views of migration 1300 (each refuses writes with an INSTEAD OF trigger and exposes
no names, contact details or dates of birth) and through exported query services and ports: the
competition module's `ReadinessService` (match readiness), the workforce module's
`ASSIGNMENT_COVERAGE_PORT` (uncovered assignments) and the enrollment module's
`BOOKING_QUERY_PORT` (IF-36, rental customer retention).

## Stage 3 (REP-01 to REP-03) at a glance (§6.7 labels)

| Item   | What                                                                                                                                                                                                                                                                     | Status                                                                                                                                                                       | Tests                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REP-01 | `GET /v1/reports/exports` lists the caller's own exports (keyset `requested_at desc, id desc`, `status` filter), an export past its expiry is marked expired by the timer's rule first; expected-arrival rows carry `offeringId` and, for a catalog session, `sessionId` | **Verified**                                                                                                                                                                 | `exports.spec.ts` ("§4.14: a requester lists their exports with expiry; another account's exports never appear", "§4.14: an expired export lists as expired"); `operating-reports.spec.ts` |
| REP-02 | Retention cohort `rental_customers` from bookings (BOOKING_QUERY_PORT): bookers of rental and party bookings confirmed or completed in the anchor period, returned when they hold one in the comparison period                                                           | **Verified** against a deterministic port implementation; enrollment's `BookingsService` registers the port (BOOKING_QUERY_IMPL, ENR-13), so the cohort counts real bookings | `rental-retention.spec.ts` ("SPK-REPORT-005: a booker who rebooks in the comparison period counts as retained"), `retention.spec.ts`                                                       |
| REP-03 | One read-only repeatable-read snapshot per report, handed to every port; policy values as module settings without defaults; retired requirements skipped                                                                                                                 | **Verified**; match readiness is the one report still read outside a snapshot (see Known gaps)                                                                               | `rental-retention.spec.ts` ("REP-03: a report computed while another transaction commits reflects one snapshot"), `settings.spec.ts`, `requirement-retirement.spec.ts`                     |

No reporting behaviour sits behind a capability switch: reads are never gated (DEC-016). The rental
customers cohort is computed whether or not the `rentals` and `parties` capabilities (DEC-076,
DEC-077) are enabled; with neither enabled there are simply no bookings to count.

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
Migration 1302 adds the space status changes (`reporting_resource_status_changes_v`: the scheduling
module's clock-stamped, append-only audit records of `scheduling.resource_updated` that set a
status) and the order total on each order line. Migration 1304 adds the event change facts
(`reporting_event_changes_v`: the scheduling module's durable, clock-stamped
`scheduling.event_changed` domain events, exposing only the event, change kind, revision, instant,
publication and closure ids; never the payload's details), 1305 point-of-sale money
(`reporting_pos_money_v`: settled tenders by settlement instant, card captures reported after a
failed tender by posting instant, returns by return instant; no customer, staff member or product),
1306 the withdrawal instant of a team entry, 1307 the refund attempt of a card return and 1308 a
refund's reversal instant.

## Review round 3 fixes (stage 7, §6.7 labels)

All **Verified** by the tests named, on PGlite and PostgreSQL (`TEST_DATABASE_URL`); every changed
metric text is a new definition version when the definitions are seeded.

| Finding                 | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tests                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-PERFORMANCE-03       | Match readiness evaluates at most `REPORTING_LIMITS.maxReadinessFixtures` fixtures, the competition module's own bound (`SEASON_READINESS_MAX_FIXTURES` = 100, CMP-01); more answers `VALIDATION_FAILED` `TOO_MANY_FIXTURES` (`limit`) before any evaluation, live or as a run                                                                                                                                                                                                                                       | `match-readiness-bound.spec.ts`                                                                                                                                                                                            |
| R3-REPORTING-01         | MET-002 counts a published event as changed only when a `scheduling.event_changed` fact of change `moved`, `resized`, `resource_changed` or `updated` was recorded by the as-of instant (1304), never from `published_revision > 1`; rows carry `changeTypes`                                                                                                                                                                                                                                                        | `schedule-and-checkin-facts.spec.ts` ("a draft published once by a schedule draft is not changed after publication")                                                                                                       |
| R3-REPORTING-02         | MET-049: one row per reconciliation (id, kind and scope, period, expected, reported, signed difference); totals per currency, kind and scope are shortages, overages and their absolute sum, never a signed sum                                                                                                                                                                                                                                                                                                      | `finance-reports.spec.ts` ("a shortage at one drawer and an overage at another … never netted")                                                                                                                            |
| R3-REPORTING-03         | MET-043 counts active credits not expired at the as-of instant; lapsed active credits are reported separately as expired                                                                                                                                                                                                                                                                                                                                                                                             | `finance-reports.spec.ts` ("an active credit past its expiry is not outstanding")                                                                                                                                          |
| R4-PROVIDER-OUTCOMES-02 | `reporting_refund_attempts_v` exposes `reversed_at` (migration 1308): a refund the provider reported failed after success is reported as `reversed` in the refund attempts and in the point-of-sale card returns, never as returned; economics refund adjustments (MET-074) and the retention "fully refunded" exclusion (MET-082) leave out a refund reversed by the as-of instant                                                                                                                                  | `finance-reports.spec.ts` ("point-of-sale card captures … a card return is paid only when its refund succeeds", reversal part); the economics and retention filters have no reversal test of their own yet                 |
| R3-REPORTING-04         | MET-050 gains point-of-sale series (card captures, drawer tenders, returns recorded) beside customer receipts (1305); a card return is recorded when its refund is only reserved, so card returns are shown by the current state of their refund attempt (1307) and an unknown refund stays unknown (SPK-PAY-007); cash and external returns are paid at the return. MET-045 shows its point-of-sale share; MET-047 shows refund attempts on point-of-sale payments (card returns and late card captures given back) | `finance-reports.spec.ts` ("point-of-sale card captures, drawer tenders and returns are reported beside customer receipts … a card return is paid only when its refund succeeds")                                          |
| R3-REPORTING-05         | MET-083 describes the REP-02 rule: bookers of rental and party bookings, confirmed or completed, by first occurrence and facility-local operating day                                                                                                                                                                                                                                                                                                                                                                | `rental-retention.spec.ts` ("the MET-083 definition … describes the booking rule it computes")                                                                                                                             |
| R3-REPORTING-06         | MET-008 (MET-007 over MET-004) has a rate only for activities with an attendance observation received by the as-of instant; others are counted separately with a null rate and a reason, never 0: not yet started, started with session check-ins only (a check-in is MET-009, not attendance), or started with nothing captured                                                                                                                                                                                     | `operating-reports.spec.ts` ("the attendance rate counts only activities with attendance captured"), `schedule-and-checkin-facts.spec.ts` ("a started session with check-ins and no attendance observation has no rate …") |
| R3-REPORTING-07         | MET-009 and the MET-069 observed-use overlay ignore check-ins withdrawn by the as-of instant; MET-009 counts them separately. Both MET-009 counts are one filtered aggregate in SQL, and the capture and observed-use reads return one row per activity, not per check-in                                                                                                                                                                                                                                            | `schedule-and-checkin-facts.spec.ts` ("a check-in withdrawn by the as-of instant …")                                                                                                                                       |
| R3-REPORTING-08         | Adult-team and player cohorts qualify entries accepted (approved) by the as-of instant, whatever their current status: the metric dictionary's MET-079 excludes only entries withdrawn before acceptance, so an accepted entry withdrawn later still qualifies and is counted apart per season (withdrawn by the as-of instant, 1306); a withdrawal after a stored run's as-of instant reproduces with `matched: true`                                                                                               | `retention.spec.ts` ("an accepted team entry withdrawn later still qualifies for its season …")                                                                                                                            |
| R3-REPORTING-09         | Every CSV preamble line is one RFC 4180 cell through `csvCell` (`csvPreambleLine`), so staff-entered text (space names in disclosures) never ends the cell or starts a formula cell                                                                                                                                                                                                                                                                                                                                  | `reporting.spec.ts`, `exports.spec.ts` ("a space name with a comma, a quote and a formula stays inside its preamble cell")                                                                                                 |

## Report envelope (every response)

`report` (key, title, requirement ids, view and export actions), `runId`, `asOf`, `producedAt`,
`scope`, validated `parameters` (with the resolved as-of instant), `freshness` (class F1 live / F3
stored run, point-in-time support and its explanation), `metrics` (the full definitions),
`disclosures`, `values` (a null value always carries its reason, rule G13), `columns`, `rows`
(aggregates only; no person-level rows, rule G9). Money is integer minor units with its currency
and is never summed across currencies. Since REP-03: `settings` names every module setting the
report used (environment variable, configured or not, value, pending decision, effect) and
`freshness.consistency` says how the figures were read (`snapshot`, or `owner_reads` for match
readiness). Runs stored before REP-03 carry neither and keep their digests.

## Endpoints

| Method and path                                                                                                                                           | Action (staff roles from permission matrix C.14, **Proposed**)                                                         | Notes                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /v1/reports/daily-schedule`                                                                                                                          | `reporting.view_operations_reports` (FD, LM, PM, SC, FA, GM, SA, SO)                                                   | MET-001..003                                                                                                |
| `GET /v1/reports/expected-arrivals`                                                                                                                       | operations                                                                                                             | MET-004, MET-006; rows carry `offeringId`, `sessionId`                                                      |
| `GET /v1/reports/attendance`                                                                                                                              | operations                                                                                                             | MET-004, MET-007..009, MET-011, MET-012                                                                     |
| `GET /v1/reports/match-readiness`                                                                                                                         | operations                                                                                                             | MET-013..015, live only; ≤ 100 fixtures else `VALIDATION_FAILED` `TOO_MANY_FIXTURES`                        |
| `GET /v1/reports/uncovered-assignments`                                                                                                                   | operations                                                                                                             | MET-017, MET-018, live only                                                                                 |
| `GET /v1/reports/maintenance-restrictions`                                                                                                                | operations                                                                                                             | MET-054, MET-056, MET-057, live only                                                                        |
| `GET /v1/reports/communication-failures`                                                                                                                  | operations (organization-wide)                                                                                         | MET-059..062, live only                                                                                     |
| `GET /v1/reports/waitlist-demand`                                                                                                                         | `reporting.view_demand_reports` (LM, PM, GM, SA)                                                                       | MET-021..023, live only                                                                                     |
| `GET /v1/reports/registration-funnel`                                                                                                                     | demand                                                                                                                 | MET-025, MET-026, MET-028                                                                                   |
| `GET /v1/reports/enrollment-completeness`                                                                                                                 | demand                                                                                                                 | MET-033, MET-034, MET-037, live only                                                                        |
| `GET /v1/reports/demand`                                                                                                                                  | demand                                                                                                                 | MET-086 observed; MET-089 forecast in its own series                                                        |
| `GET /v1/reports/outstanding-obligations`                                                                                                                 | `reporting.view_financial_reports` (FO, GM), organization-wide                                                         | MET-039, MET-040, MET-043, live only                                                                        |
| `GET /v1/reports/payment-reconciliation`                                                                                                                  | financial, organization-wide                                                                                           | MET-045..050, live only                                                                                     |
| `GET /v1/reports/economics`                                                                                                                               | financial                                                                                                              | MET-067, MET-074..077; `allocationMethod` required                                                          |
| `GET /v1/reports/utilization`                                                                                                                             | `reporting.view_utilization` (SC, FO, FA, GM)                                                                          | MET-064..073                                                                                                |
| `GET /v1/reports/retention`                                                                                                                               | `reporting.view_retention` (LM, PM, GM), organization-wide                                                             | MET-079..083, one cohort per request                                                                        |
| `GET /v1/reports/metric-definitions[/{key}]`                                                                                                              | `reporting.read_metric_definitions`                                                                                    | active definitions; a metric's version history                                                              |
| `POST /v1/reports/runs` (idempotent)                                                                                                                      | the report's view action                                                                                               | evaluate and store a run                                                                                    |
| `GET /v1/reports/runs`, `GET /v1/reports/runs/{id}`                                                                                                       | the report's view action, re-checked on every read (protected: NOT_FOUND)                                              | stored run exactly as produced                                                                              |
| `POST /v1/reports/runs/{id}/reproduce` (idempotent)                                                                                                       | the report's view action                                                                                               | re-evaluate at the stored as-of instant; digest comparison                                                  |
| `POST /v1/reports/exports` (idempotent)                                                                                                                   | the run's view action AND `reporting.export_operational` (LM, PM, SC, GM, SA) or `reporting.export_financial` (FO, GM) | audited; returns the one-time token; refused without a configured lifetime (`EXPORT_LIFETIME_UNCONFIGURED`) |
| `GET /v1/reports/exports` (`status`, `cursor`, `limit`)                                                                                                   | `reporting.read_exports` (LM, PM, SC, FO, GM, SA), re-checked per request; the caller's own exports only               | REP-01; never a token or download path                                                                      |
| `GET /v1/reports/exports/{id}`                                                                                                                            | `reporting.read_exports`; requester only                                                                               | an export past its expiry reads as expired                                                                  |
| `GET /v1/reports/exports/{id}/download`                                                                                                                   | requester, `X-Export-Token`, view and export actions re-checked                                                        | single use; refused after expiry; audited                                                                   |
| `POST /v1/reports/exports/{id}/revoke` (idempotent)                                                                                                       | requester; `expectedRevision`                                                                                          |                                                                                                             |
| `POST /v1/reports/cost-inputs` (idempotent), `GET /v1/reports/cost-inputs`, `POST /v1/reports/cost-inputs/{id}/withdraw` (idempotent, `expectedRevision`) | `reporting.manage_cost_inputs` / `reporting.read_cost_inputs` (FO, GM)                                                 |                                                                                                             |

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
  conflict unit weighs one, U3) and lists its weights in the disclosures. A unit counts as closure
  hours, not available hours, while every space holding it has status `closed` (MET-064; a closed
  whole pitch with open halves still books the halves), from the status changes recorded by the
  as-of instant (test "a closed space counts as closure hours, not available hours").
- **SPK-REPORT-004** — no per-field-hour figure without a named allocation method (`direct` or
  `pro_rata`, largest-remainder splits, no default, DEC-085); coverage and unallocated sales are
  shown; margin is refused unless agreed cost inputs cover every space and event day, and uses the
  inputs in force at the as-of instant. A refund of an order is split over the order's lines by
  their totals and only the share of the lines reported counts (E2, G2).
- **SPK-REPORT-005** — one cohort per request; households (purchases) and participants are
  separate metrics; persons resolve merges to the survivor; not-offered members are counted
  separately and leave the denominator only when asked (K4). An order refunded in full by the
  as-of instant is not a household purchase (MET-082). Rental customers (REP-02) are the bookers
  of rental and party bookings read through `BOOKING_QUERY_PORT` (IF-36) whose first occurrence
  falls in the period by each facility's local operating day and whose status is `confirmed` or
  `completed`; a customer returned when they hold such a booking in the comparison period (a
  request never confirmed is not a return). Booking status is read as it stands now. An enrollment
  line of a rental offering (the pre-booking path) is not a booking and does not count; the MET-083
  definition says so (R3-REPORTING-05). A team entry qualifies for the adult-team and player
  cohorts when it was accepted (approved) by the as-of instant; as the metric dictionary's MET-079
  excludes only entries withdrawn before acceptance, one withdrawn later still qualifies and is
  counted apart (R3-REPORTING-08).
- **SPK-REPORT-006** — observed signals and any forecast are separate columns; the only forecast
  method offered (`trailing_mean`) is an engineering baseline named in the response.
- **SPK-REPORT-007** — a stored run is the reproducible record (append-only, digest); reports whose
  inputs are append-only and clock-stamped (attendance observations and corrections, releases,
  closure applications and lifts, space status changes, event change facts, approvals, team-entry
  withdrawals, check-in withdrawals, confirmations, fulfilments, refunds, cost inputs recorded and
  withdrawn) honour the as-of instant,
  so a rerun at the same instant after a correction reproduces the figures (test "reports are
  reproducible after a correction"). Live-only reports refuse a past as-of instant. Exports need
  their own action, are requester-bound, single use, audited at creation, download, revocation and
  expiry, and expire through the `reporting.export_expiry_due` timer; a read of an export past its
  expiry (list or single) marks it expired through the timer's own rule (REP-01). The requester
  lists their own exports only: another account's never appear, administrators included.
- **One snapshot (REP-03, rule K-00 (i))** — `ReportsService.evaluate` seeds the metric
  definitions (a write) first, then reads the definitions and computes the whole report inside one
  `UnitOfWork.run` at `repeatable read`, made `read only` by its first statement; the transaction is
  passed to every port (`ASSIGNMENT_COVERAGE_PORT.coverage(…, trx)`,
  `BOOKING_QUERY_PORT.bookingsOfPeriod(…, trx)`). Inside an idempotent request the commit fence
  sees no write and leaves the key alone. Called inside an active transaction, a report reads
  through it. Test "REP-03: a report computed while another transaction commits reflects one
  snapshot" merges two persons in another transaction that commits mid-report (PostgreSQL) and
  proves the report does not see it; it fails at `read committed`.
- **Retired requirements (WRK-02, migration 1303)** — the uncovered-assignments report lists only
  requirements whose `retired_at` is null and skips any role of the coverage port that is not one
  of them.
- **View state types (§4.6)** — none of the views with a literal-typed column filters its rows:
  each has no `where` clause and its inner joins follow not-null foreign keys (its left joins never
  drop a row), so it passes every base row through. Each such column in `packages/db/src/schema/reporting.ts` therefore lists exactly the
  states its base table's check constraint allows; the restriction status is the facilities
  `RestrictionStatus` itself, `withdrawn` (migration 0903) included. Three views do filter:
  `reporting_resource_status_changes_v` (migration 1302) keeps only audited status changes,
  `reporting_event_changes_v` (1304) only `scheduling.event_changed` facts and
  `reporting_pos_money_v` (1305) only settled tenders, late captures and returns; their `status`,
  `change` and `tender_kind` are untyped text (the POS `movement` is produced by the view itself). Test "§4.6 / SPK-FAC-003: every state a reporting view passes through
  is typed exactly as its base check lists it (a withdrawn restriction included)" proves that each
  of the 32 typed columns' views has no `where` clause and compares each typed union with the
  database (the compiler rejects a listed state the type lacks).
  The maintenance restrictions report counts `approved` and `active` restrictions
  (`COUNTED_RESTRICTION_STATES`), and MET-054 lists every other state, `withdrawn` included, as an
  exclusion (test "SPK-REPORT-001 / SPK-FAC-003: MET-054 lists every restriction state it does not
  count as an exclusion, withdrawn included"). **Verified**.

## Ports, events and handlers

- Consumed: `ReadinessService` (competition), `ASSIGNMENT_COVERAGE_PORT` (workforce),
  `BOOKING_QUERY_PORT` (enrollment, IF-36; implemented by ENR-13, until then no bookings); pure
  helpers `currentHeads` / `effectiveState` / `attended` (entry) for attendance after corrections;
  module settings (kernel K-15, IF-43).
- Provided: none of the declared stage-3 interfaces names reporting as a provider.
- Exported: `ReportsService`, `ReportRunsService`, `ExportsService`, `CostInputsService`,
  `MetricDefinitionsService`, `REPORTING_POLICY`, `reportingPolicyFrom`, `REPORTING_LIMITS`,
  `ReportingSettings`, `REPORTING_SETTING_NAMES`, the calculators (`computeUtilization`,
  `allocateSales`, `cohortOutcome`), output helpers, actions, events, machines, and fixtures
  (`testing/reporting-fixtures.ts`: `createReportRunFixture`, `createExportFixture`,
  `createCostInputFixture`).
- Events (`reporting.events.ts`): `reporting.report_run_recorded`, `reporting.export_created`,
  `reporting.export_expiry_due` (timer), `reporting.export_downloaded`, `reporting.export_expired`,
  `reporting.export_revoked`, `reporting.metric_definition_versioned`,
  `reporting.cost_input_recorded`, `reporting.cost_input_withdrawn`.
- Handler: `reporting.expire_export` on `reporting.export_expiry_due` (idempotent under replay).

## Module settings (`reporting.settings.ts`, REP-03; K-15, IF-43)

Policy values are module settings with **no default** (rule K-00 (i)); each is validated at boot (a
malformed value refuses boot) and every report response names the ones it used. The values are
**Pending decision**; the behaviour without a value is **Verified** (`settings.spec.ts`).

| Setting                              | Decision                         | Without a value (verified)                                                                               | With a value (verified)                                                          |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `REPORTING_EXPORT_LIFETIME_MINUTES`  | DEC-060 (Operator/privacy owner) | `POST /v1/reports/exports` answers `VALIDATION_FAILED` `EXPORT_LIFETIME_UNCONFIGURED`; nothing stored    | the export expires that many minutes after creation (audited `lifetimeMinutes`)  |
| `REPORTING_AGING_BANDS_DAYS`         | DEC-007 (Finance)                | outstanding balances are unbanded totals per currency and mode (`agingBand` `unbanded`)                  | upper bounds such as `30,60,90` → `0-30`, `31-60`, `61-90`, `over_90`, `not_due` |
| `REPORTING_UNKNOWN_DELIVERY_MINUTES` | DEC-015                          | every unknown delivery counts as unresolved at once (MET-062 dimension `thresholdMinutes: unconfigured`) | counted once unknown for longer than the threshold                               |
| `REPORTING_OPERATING_DAY_START`      | DEC-001 (Operations)             | a reported day is the facility-local calendar day, and the response says so                              | `HH:MM`: a reported day runs from that local time to the same time the next day  |

Technical bounds stay constants (`REPORTING_LIMITS`): at most 366 days per request; hourly
start-time bands; at most 100 fixtures per match-readiness request (the competition module's
`SEASON_READINESS_MAX_FIXTURES`, R3-PERFORMANCE-03).

## Park UI redesign gaps — verified 2026-11-06

Verified by `__tests__/redesign-reports.spec.ts`:

- `utilization_heatmap` (`GET /v1/reports/utilization-heatmap`, MET-106 to MET-108): the
  utilization report's unit-hours split at facility-local clock hours (`hourCells`, DST-safe) and
  summed per weekday and hour.
- `sales_by_product_line` (`GET /v1/reports/sales-by-product-line`, MET-109, MET-110): fulfilled
  registration order lines by offering kind and POS lines in effect by product kind (views of
  migration 1309), per currency; POS returns shown apart; sales, not revenue (SPK-PAY-011).
  Registration refunds are not split by product line (proposed follow-up).
- `GET /v1/me/attention` (`AttentionService`): per navigation area, the first page (cap 99) of each
  owning module's exported list read with the viewer's principal: open exceptions (support),
  applications awaiting review (enrollment), unknown payment and refund outcomes (finance),
  composed unsent notices (communications), open cases the viewer owns (support). An area whose
  list the viewer may not read is omitted. Facilities, schedule, competition and workforce areas
  have no count yet (their modules export no suitable list here).

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
- The daily schedule selects events by their current scheduled start and shows their current
  times, spaces, title and publication; only cancellations and the MET-002 change facts honour the
  as-of instant. A move recorded after the as-of instant therefore still shows in a rerun at that
  instant (an event moved to another day leaves that day's rerun); the stored run is the
  reproducible record, and the response's freshness note says so (R3-REPORTING-01).
- The payment reconciliation report is live only: a card return's refund state is the attempt's
  current state.
- Space status history comes from the scheduling module's audit records of status changes
  (spaces are created active; every status change is audited in its transaction). A status
  written outside the scheduling module would have no history and is not counted as closed.
- Payment reconciliation counts attempts never submitted to a provider over all time at the
  request instant (labelled so, by state): payment attempts carry no clock-stamped creation
  instant to place them in the period (MET-045).
- **Pending (cross-module):** match readiness is read outside a snapshot (consistency
  `owner_reads`, disclosed in the response): the competition module's `ReadinessService` reads the
  season, rule set, proposed suspensions and disputes through its own database handle
  (`this.db`), which cannot join a transaction (under PGlite it would wait for the report's own
  connection). Once those reads go through `executorFor(this.db)`, the definition's
  `consistency` can be dropped and the report joins the snapshot.
- Verified: retired requirements (workforce 0704 `assignment_requirements.retired_at`) are
  skipped and rental customers come from BOOKING_QUERY_IMPL (enrollment BookingsService,
  enrollment.module.ts); docs/api/openapi.json and the client are regenerated.
- Retention does not detect children who aged out (age bands are DEC-003) and does not compute
  "not offered" for teams, players, households or rental customers (DEC-076, DEC-077).
- Rental customer status is read as it stands now: the booking port exposes no confirmation
  instant, so that cohort is not reconstructed as of an earlier instant.
- Not a gap, for the record: the one-time export token is withheld from the kernel's idempotency
  store (`withhold: ['downloadToken']`); a replay answers `IDEMPOTENCY_SECRET_WITHHELD`.
- Operators cannot edit metric definitions (`reporting.manage_metric_definition` is not
  registered): the code registry is the source and every change is a new version.
- The proposed `reporting.*` actions (including `reporting.read_exports`, REP-01) are not yet
  reflected in `docs/package-a/permission-matrix.md` as implemented.
