# Production readiness checklist

Status legend: **Verified** = implemented and tested in this repository today (file cited); **Proposed** = engineering proposal awaiting an operator; **Pending decision** = needs the owner's answer (owner from spec §6.6).

Checked 2026-11-09 against branch `claude/clever-darwin-40w6dj` (pull request Backpacked333/LasVegasSportsPark#4). This is the §6.8 definition of done applied to the Package F pilot scope (DEC-046), with the evidence each item has today and what is still missing. A capability is released only when all twelve items are met for its scope (§6.8); none is today. Per-build evidence goes in [../package-a/release-evidence-ledger.md](../package-a/release-evidence-ledger.md).

## 1. The twelve §6.8 items

| #   | §6.8 item                                                 | State today   | Evidence                                                                                                                                                                   | Still missing                                                                                                    |
| --- | --------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Applicable policies are approved                          | not met       | Policy store **Verified** (`policy_versions`, approvals); [launch decision packet](../package-a/launch-decision-packet.md) lists what the pilot needs                      | Answers to DEC-001 to DEC-009, DEC-012, DEC-062 and approved policy versions (**Pending decision**)              |
| 2   | Customer and staff paths work together                    | partially met | 31 cross-module journeys on the assembled application (`apps/api/src/__tests__/journeys/`); both clients on one typed API client                                           | One acceptance run with the customer app and the staff dashboard on the same records in staging                  |
| 3   | Permissions are enforced server-side                      | met (code)    | `AuthorizationService` with the action registry (325 actions, [permission-matrix.generated.md](../package-a/permission-matrix.generated.md)); denial tests per module      | Operator review of the role matrix (Proposed role assignments)                                                   |
| 4   | Consequential writes are safe under concurrency and retry | met (code)    | Idempotency keys, revisions, database constraints; CI `test-postgres` job (true concurrency); migration lock and rate limits tested on PostgreSQL                          | A green `test-postgres` run linked in the ledger for the release build                                           |
| 5   | Error and recovery states are understandable              | met (code)    | Error contract with next actions (§4.10); `recovery_required` and `unknown` outcomes visible to staff; readiness reasons in `GET /v1/ready`                                | Operator acceptance of the screens (§6.3)                                                                        |
| 6   | Financial and operational records reconcile               | partially met | Reconciliation reports and sign-offs (finance module, SCR-S-48)                                                                                                            | A reconciliation run against a real processor sandbox (DEC-019)                                                  |
| 7   | Required follow-up survives interruption                  | met (code)    | Outbox and inbox with leases and dead letters; worker stop within budget; API drain on SIGTERM (`apps/api/src/main.ts`); CI image job drains the API and starts the worker | The worker running continuously on the chosen host (DEC-021)                                                     |
| 8   | Native and staff-device behavior is verified              | not met       | jest and jsdom suites; Expo export and staff release-bundle checks in CI                                                                                                   | Signed builds on physical iOS and Android devices (§6.2); staff tasks on the actual workstations (§6.3); DEC-061 |
| 9   | Monitoring and support actions exist                      | partially met | JSON logs with correlation ids; `GET /v1/ready`; `GET /v1/admin/metrics` and `GET /v1/metrics` (§5.11 signals); owned operational exceptions                               | A monitoring service scraping and alerting; a named owner per signal (DEC-015)                                   |
| 10  | Operators complete representative acceptance tasks        | not met       | Staging environment described end to end ([staging.md](staging.md))                                                                                                        | §6.1 journeys and §6.3 tasks performed by operators with completion, errors, time and assistance measured        |
| 11  | Evidence identifies the build and environment             | met (process) | Ledger rows carry commit and environment; the deploy workflow's summary records commit, image digest and run URL                                                           | Rows for the pilot build in staging and production                                                               |
| 12  | Release ownership is explicit                             | not met       | —                                                                                                                                                                          | A named holder of release authority (DEC-017)                                                                    |

## 2. Environment checklist (before the first production deploy)

- [ ] DEC-021 answered: container host chosen; managed PostgreSQL with point-in-time recovery enabled.
- [ ] DEC-018 answered: identity provider project configured (asymmetric signing keys, redirect URLs, multifactor for the DEC-091 roles); `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` and `PROVIDER_DECISIONS=identity=DEC-018` set.
- [ ] Every provider selector set: `none` until its adapter exists ([production.md](production.md) section 3).
- [ ] `DATABASE_SSL=require` (or `verify-full`), `TRUST_PROXY`, `CORS_ALLOWED_ORIGINS`, `METRICS_TOKEN`, `DATABASE_STATEMENT_TIMEOUT_MS` set.
- [ ] GitHub environments `staging` and `production` created with `DATABASE_URL`; production requires a reviewer.
- [ ] GitHub secret scanning with push protection turned on in the repository settings.
- [ ] Migrations applied with the deploy workflow; `GET /v1/ready` is 200 with `"current":true`.
- [ ] A backup taken with `pnpm db:backup` and restored with `pnpm db:restore` on the production provider; recorded in the ledger (SPK-AT-028).
- [ ] Monitoring scrapes `GET /v1/metrics` and alerts on dead events, queue age and failing periodic jobs, with owners (DEC-015).
- [ ] Staff dashboard deployed with its security headers; customer app signed builds pointing at the production API (DEC-061).

## 3. Verified in this repository on 2026-11-09

- The assembled application boots with `NODE_ENV=production`, managed identity with its decision recorded and every provider gate `none` (`apps/api/src/__tests__/production-boot.spec.ts`).
- Production refuses an unset or fake provider gate, the local identity provider, PGlite and `DATABASE_SSL=disable` (`kernel/__tests__/config.spec.ts`, `production-boot.spec.ts`).
- The image layout runs in production mode against PostgreSQL: readiness refuses traffic while a migration is pending, answers 200 once migrated, sends the security headers, answers 404 for development tokens and drains on SIGTERM (exercised on the host, and with the built image in the CI job "Container image", ledger row L-022).
- The staging database's 171 applied migrations match the repository files exactly (same SHA-256 digest over version and checksum); `0019_core_rate_limit_buckets.sql` and `1104_support_customer_replies.sql` are pending there.
- Backup and restore rehearsed against PostgreSQL 16: 203 tables, 171 migrations, verified against the manifest.
