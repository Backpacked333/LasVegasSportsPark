# DevOps: glass, demo mode and the ten amendments

Feature: `glass-demo-amendments` · Pull request 21 (draft).

## What CI checks on every push (`.github/workflows/ci.yml`, unchanged in shape)

Format, lint, typecheck, the whole test suite on PGlite, the same suite on PostgreSQL (true
concurrency), that the API description and client types are current, the staff release build and
both customer app exports with their release-bundle checks (no development sign-in, no demo
code), the container image (builds, refuses fakes in production, migrates, serves, drains), the
staff browser smoke test, secret scanning and dependency advisories.

Changed by this work: the two production container steps set `TRUST_PROXY=false`, because
production now refuses to start without an explicit proxy trust setting.

## Before deploying this branch anywhere

1. **Set `TRUST_PROXY`** on the API and the worker (a hop count or the proxies' addresses; never
   `true`). Without it production does not start. `docs/deploy/staging.md` and
   `docs/deploy/production.md` say what to use; the readiness checklist has the check to do once
   on the host.
2. **Migrations**: 26 new files across core, catalog, scheduling, competition, enrollment,
   finance, communications and reporting (list in `decisions/dba`). They are additive. One can
   refuse on existing data: `0525_enrollment_allocation_once_per_enrollment.sql` creates a unique
   index over active allocations and fails if a database already holds two active allocations for
   one enrollment in one pool. Check before migrating a database with real registrations.
3. **Nothing new is on.** All ten features are capability switches that are off until a system
   administrator turns one on, naming its decision record. Deploying changes no behaviour for an
   organization that has turned nothing on, with one exception stated next.
4. **Existing public competitions**: there are none before this branch (the feature is new), so
   the adult-only rule takes nothing down.

## Rollback

- Code: redeploy the previous image. The new migrations are additive, so the previous code runs
  against the migrated schema, with two cautions: `team_entries.status` may hold `waiting` and
  `pos_sale_lines.product_id` may be null once the features have been used. Turn the capability
  off and resolve those rows (place or withdraw waiting teams; no action needed for finalized
  sales, which old code only reads in reports) before rolling back past this branch.
- A capability can be turned off at any time; the tracks' notes say what stays readable and what
  stops (each has a capability-off test).

## New dependencies

Customer app: `expo-glass-effect` 57.0.5 and `expo-blur` 57.0.3 (both first-party to the SDK in
use). They add native code, so the customer app needs a new native build; an over-the-air update
is not enough. No other dependency was added.

## Demo

`pnpm demo` (development only): seeds a separate database, starts the API with the worker loops
on this machine only, and the dashboard in demo mode. `--mobile` also opens the API to the local
network for a phone. Real builds contain no demo code (checked by the release-bundle scripts in
CI).

## Not done

- No deployment was made or attempted in this work.
- The customer app was not built natively; only its JavaScript bundles were exported.
