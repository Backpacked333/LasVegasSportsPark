# Production deployment

**Status (§6.7):** the production path in code is **Verified**: the API and worker boot with
`NODE_ENV=production` behind managed identity and with every provider gate set explicitly
(`apps/api/src/__tests__/production-boot.spec.ts`; the CI job "Container image" builds the image,
migrates, serves and drains it). Where it runs is **Pending decision** DEC-021 (Technical
lead/account owners), as are the identity provider DEC-018, payments DEC-019, messaging DEC-020,
accounting DEC-022 and hardware DEC-023. Nothing has run in production. The proposed provider set
is in [the launch decision packet](../package-a/launch-decision-packet.md).

## 1. Topology (Proposed)

| Process  | Command                                           | Scale                     | Probes                                                    |
| -------- | ------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| api      | image default (`node dist/main.js`)               | 2 or more, behind TLS     | readiness `GET /v1/ready`, liveness `GET /v1/health`      |
| worker   | `node dist/worker.js`                             | 1 or more (leases)        | process alive; `GET /v1/ready` of the API reports its age |
| migrate  | `node /app/packages/db/dist/cli/migrate.js`       | one-shot before each roll | exit code                                                 |
| database | managed PostgreSQL 17 with point-in-time recovery | primary + backups         | provider monitoring                                       |

The worker must run continuously: the §5.9 targets (notice dispatch p95 within 60 s, recovery
point within 5 minutes) cannot be met by a function host that sleeps. The staff dashboard is a
static site (`apps/staff`, `pnpm build:staff`) on any static host or CDN.

## 2. Build and release

- Image: `Dockerfile` at the repository root (Node 22, non-root, production dependencies only,
  migrations included because `GET /v1/ready` and the migration CLI read them).
- `.github/workflows/deploy.yml` (manual): builds and pushes `ghcr.io/<owner>/sportspark-api`,
  migrates the chosen environment's database (dry run, apply under the lock, status), then a
  placeholder deploy step until DEC-021 names the host, then a job summary with the commit, image
  digest and run URL for the release evidence ledger (§6.8 item 11).
- Order of a release: migrate, then roll the API (readiness gates traffic per instance), then
  roll the worker. A migration must stay compatible with the previous build while it rolls
  (expand, then contract in a later release).

## 3. Environment

Required in production (the configuration refuses to boot otherwise):

| Variable                                                                        | Value                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `NODE_ENV`                                                                      | `production`                                                              |
| `DATABASE_URL` \*                                                               | managed PostgreSQL (direct or session pooler)                             |
| `AUTH_MODE`                                                                     | `oidc`                                                                    |
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`                                 | the identity provider's key set (https), issuer and access-token audience |
| `PROVIDER_DECISIONS`                                                            | e.g. `identity=DEC-018`; one entry per gate whose provider adapter runs   |
| `PAYMENT_PROVIDER`, `ACCOUNTING_PROVIDER`, `ACCESS_DEVICE_PROVIDER`             | `none` until the gate's adapter exists (production refuses `fake`)        |
| `MESSAGING_PUSH_PROVIDER`, `MESSAGING_EMAIL_PROVIDER`, `MESSAGING_SMS_PROVIDER` | `none` until the gate's adapter exists                                    |

Recommended:

| Variable                                           | Value                                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_SSL`                                     | `require` or `verify-full` (+ `DATABASE_SSL_CA_PATH`); `disable` is refused, and unset is refused for a database on another host unless `DATABASE_URL` sets `sslmode=require`, `verify-ca` or `verify-full` |
| `DATABASE_STATEMENT_TIMEOUT_MS`                    | e.g. `30000`                                                                                                                                                                                                |
| `DATABASE_POOL_MAX`                                | per process; the sum over processes under the database's connection limit                                                                                                                                   |
| `TRUST_PROXY`                                      | the load balancer (hop count or subnet), so rate limits and HSTS see the client                                                                                                                             |
| `CORS_ALLOWED_ORIGINS`                             | the staff dashboard's https origin (if not same-origin)                                                                                                                                                     |
| `RATE_LIMIT_STORE`                                 | `postgres` (the production default)                                                                                                                                                                         |
| `LOG_FORMAT`                                       | `json` (the production default)                                                                                                                                                                             |
| `METRICS_TOKEN` \*                                 | enables `GET /v1/metrics` (Prometheus text) for the monitoring scraper                                                                                                                                      |
| `API_SHUTDOWN_DELAY_MS`, `API_SHUTDOWN_TIMEOUT_MS` | the timeout under the host's termination grace period; the delay is part of it and must be smaller                                                                                                          |
| `CLIENT_MIN_VERSIONS`                              | when DEC-061 sets minimum app versions                                                                                                                                                                      |

Never set in production: `AUTH_LOCAL_SECRET`, `DEV_TOKENS_PASSCODE`, `PGLITE_DATA_DIR`,
`STAGING_INLINE_WORKER`. Every option is documented in `apps/api/src/kernel/config.ts`.

Client builds name the identity provider with public identifiers, not secrets (**Verified**:
`apps/staff/src/config/config.ts`, `apps/mobile/app.config.ts`): the staff site reads
`VITE_AUTH_ISSUER`, `VITE_AUTH_CLIENT_ID` and `VITE_ORGANIZATION_SLUG`; the customer app reads
`SPORTSPARK_AUTH_ISSUER`, `SPORTSPARK_AUTH_CLIENT_ID` and `SPORTSPARK_ORGANIZATION_SLUG`. The
issuer must equal the API's `AUTH_ISSUER`. The provider needs two return addresses registered,
`<staff origin>/sign-in/callback` and `sportspark://sign-in`, and must allow the staff origin on
its token endpoint. A build without these shows sign-in as pending (DEC-018).

## 4. Observability (§5.11)

- Logs: one JSON object per line on stdout/stderr with `correlationId` (also returned to clients
  as `X-Correlation-Id`), plus one access line per request (path ids masked, no query strings).
- Readiness: `GET /v1/ready` reports the schema against the build, queue backlog and worker
  activity; `degraded` (200) is an operator signal, `not_ready` (503) removes the instance.
- Signals: `GET /v1/admin/metrics` (general manager, system administrator) and `GET /v1/metrics`
  (Prometheus text with `X-Metrics-Token`). Alert on: dead events above 0, oldest due event above
  `READY_QUEUE_LAG_SECONDS`, a periodic job with consecutive failures, and open exceptions in the
  finance and reliability categories. Owners per signal are **Pending decision** DEC-015.

## 4a. Workload validation (§5.10)

`apps/api/load/workload.manifest.json` holds the §5.10 envelope (25,000 people, 250 customer and
20 staff sessions, 50 contenders for a final place) with arrival rates, workflow mix, duration,
contention, infrastructure and dependency failures. `pnpm --filter @sportspark/api load` creates
the scaled synthetic people through the API and runs the read mix against a running API, then
writes a report with p50, p95 and p99 per workflow against the §5.9 targets, the commit and the
environment (**Verified** harness: `apps/api/src/dev/load/load.spec.ts`; a one-percent rehearsal
against `dev:all` on 2026-11-09 ran without errors). The final-place race is asserted by the
concurrency journeys under PostgreSQL (SPK-AT-005, CI job `test-postgres`). Capacity numbers come
only from a run against the production-shaped environment; the targets themselves are **Pending
decision** DEC-035 to DEC-044.

## 5. Backups and recovery (§5.8)

- Primary: the managed database's point-in-time recovery (DEC-021; RPO and RTO targets DEC-042,
  DEC-043).
- Portable copy and rehearsal: `pnpm db:backup --out <file>` (dump and manifest from one snapshot)
  and `pnpm db:restore --in <file>` into an empty database (verifies migrations, every table's row
  count and the schema). Rehearsed locally against PostgreSQL 16 on 2026-11-09; a rehearsal on the
  production provider is part of the cutover gate (`docs/runbooks/recovery.md`).
- After a restore that follows live transactions, start the processes with
  `RECOVERY_RESTORE_REFERENCE=<backup id>`: financial commands stay refused until provider facts
  are reconciled and a general manager resumes operation.

## 6. Security (§4.14)

- Transport: TLS at the load balancer, HSTS on https answers, `DATABASE_SSL`.
- Identity: managed provider tokens only; multifactor authentication for the roles DEC-091 names
  is configured at the provider.
- Rate limits on token minting, claim and invitation acceptance and account relink.
- CI: dependency advisories (`scripts/audit-gate.mjs`), Dependabot, secret scanning (gitleaks).
  Turn on GitHub secret scanning with push protection in the repository settings.
- Row level security is on for every table with no policy, so only the tables' owner (the role the
  API, the worker and the migration runner connect as) reads or writes; any other role is refused
  by the database. **Verified**: the migration runner turns it on for the tables each file creates
  and for any table an earlier build left without it, and `pnpm db:migrate --status` exits 1 while
  a table lacks it (`packages/db/src/migrate.ts`, `packages/db/src/migrate.spec.ts`). The
  application role must therefore own the tables; a separate least-privilege application role
  needs explicit policies first (**Proposed**, not built).
- Database advisors (Supabase, 2026-11-09): the Data API roles have no grants.
  Accepted warnings: 120 trigger functions without a fixed `search_path`, and `btree_gist` in the
  `public` schema; both need a role that can create objects in the schema to exploit, and only the
  API's own role connects. 428 foreign keys without a covering index are reported for review
  against measured query plans (§5.10 workload), not indexed blindly.
