# Protected staging deployment

**Status (§6.7):** **Verified** to boot and answer locally through the Vercel entry
(`apps/api/api/index.js`), and the database half exists: the Supabase project
`las-vegas-sports-park` carries the migrations and the synthetic seed. The hosted API and staff
projects are **Proposed** until their first deployment is checked with the list in section 6.
Hosting (DEC-021) and identity (DEC-018) remain **Pending decision**: this is a demo environment
with synthetic data, not production. Production is described in [production.md](production.md).

## 1. Shape

| Piece           | Where                                                | Notes                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | Supabase project `las-vegas-sports-park` (us-west-1) | All migrations in `packages/db/migrations`, recorded in `schema_migrations` with the runner's checksums. Supabase's Data API roles (`anon`, `authenticated`) have no grants and every table has row level security on: only the API's own connection reads or writes. |
| API             | Vercel project with root `apps/api`                  | `api/index.js` boots the Nest application once per instance. `STAGING_INLINE_WORKER=true` runs the worker loops (`kernel/workers/inline-worker.ts`) inside warm instances, because a function host has no worker process.                                             |
| Staff dashboard | Vercel project with root `apps/staff`                | `VITE_STAGING=true` keeps the development sign-in in the bundle (the release-bundle check is skipped for that build only); `VITE_API_BASE_URL` points at the API. `vercel.json` sends the dashboard's security headers.                                               |

## 2. Database: migrations and seed

Use the **Session pooler** connection string (Supabase: Project → Connect → Session pooler). A
transaction pooler cannot hold the migration lock or a backup snapshot.

```bash
export DATABASE_URL='<session pooler connection string>'
export DATABASE_SSL=require
pnpm db:migrate --status     # applied, pending, changed, missing; exit 1 unless current
pnpm db:migrate --dry-run    # what would be applied
pnpm db:migrate              # applies pending files under the migration lock
```

Apply migrations **before** deploying an API build that contains them: `GET /v1/ready` answers
503 while the schema does not match the build (pending, changed or missing files). As of
2026-11-09 the staging database holds migrations 0001 to 1480; this branch adds
`0019_core_rate_limit_buckets.sql` and `1104_support_customer_replies.sql`, which must be applied
before the new API build serves.

The synthetic seed is already loaded. To load it into a fresh staging database (never one with
real data):

```bash
psql "$DATABASE_URL" -f docs/deploy/staging-seed.sql
```

## 3. API project (Vercel)

1. Vercel → Add New → Project → import `Backpacked333/LasVegasSportsPark`.
2. Root directory `apps/api`; framework preset **Other**. `apps/api/vercel.json` already sets the
   install command, the build, the output directory, the function (`maxDuration` 60 s) and the
   rewrite of every path to the function.
3. Environment variables (Production environment of the project; secrets marked \*):

| Variable                 | Value                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`               | `development`                                                                                                                       |
| `AUTH_MODE`              | `local`                                                                                                                             |
| `AUTH_LOCAL_SECRET` \*   | 64 random hex characters (`openssl rand -hex 32`)                                                                                   |
| `DEV_TOKENS_PASSCODE` \* | a passphrase of at least 16 characters, shared only with staging users (required: without it the route answers 404 on a named host) |
| `DATABASE_URL` \*        | Supabase **Session pooler** connection string                                                                                       |
| `DATABASE_SSL`           | `require`                                                                                                                           |
| `DB_AUTO_MIGRATE`        | `false` (migrations are applied ahead of deploys, section 2)                                                                        |
| `CORS_ALLOWED_ORIGINS`   | the staff project's https origin                                                                                                    |
| `STAGING_INLINE_WORKER`  | `true`                                                                                                                              |
| `TRUST_PROXY`            | `true` (Vercel terminates TLS; rate limits key on the client address)                                                               |
| `LOG_FORMAT`             | `json`                                                                                                                              |
| `RATE_LIMIT_STORE`       | `postgres` (instances share one count)                                                                                              |
| `METRICS_TOKEN` \*       | optional: at least 24 characters, enables `GET /v1/metrics` for a scraper                                                           |

4. Deploy. Note the API's https origin.

## 4. Staff project (Vercel)

1. Add another project from the same repository, root directory `apps/staff`, framework preset
   **Vite**. `apps/staff/vercel.json` sets the build, the single-page rewrite and the headers.
2. Environment variables: `VITE_STAGING=true`, `VITE_API_BASE_URL=https://<api host>/v1`.
3. Deploy, then set the API project's `CORS_ALLOWED_ORIGINS` to this project's https origin and
   redeploy the API.

## 5. Sign-in

The API runs `NODE_ENV=development` with the local identity provider. `DEV_TOKENS_PASSCODE` makes
`POST /v1/dev/tokens` mint a token only with the passcode, so an account id alone signs nobody in,
and the route is rate limited per client address. The staff sign-in page asks for the account id
and the staging passcode.

Demo accounts (synthetic, from `docs/deploy/staging-seed.sql`):

| Account                          | Account id                             |
| -------------------------------- | -------------------------------------- |
| dev-admin (system administrator) | `01a1b21d-60d9-7f51-b3f7-88b995319799` |
| dev-desk (front desk)            | `01a1b21d-60f7-7300-87e5-02264af5a396` |
| dev-league (league manager)      | `01a1b21d-610e-774b-9f00-056183cf2f64` |
| dev-coach (coach)                | `01a1b21d-6128-7381-8ac7-ae7f77b45590` |
| dev-official (official)          | `01a1b21d-613f-7b07-8d6d-f801ea4dacf4` |

## 6. Check the deployment

```bash
API=https://<api host>
curl -s "$API/v1/health"                  # {"status":"ok",...,"database":"ok"}
curl -s "$API/v1/ready"                   # 200 with "migrations":{"current":true,...}
curl -sI "$API/v1/health" | grep -i content-security-policy
curl -s -X POST "$API/v1/dev/tokens" -H 'Content-Type: application/json' \
  -d '{"accountId":"01a1b21d-60d9-7f51-b3f7-88b995319799","passcode":"<passcode>"}'
```

Then sign in to the staff dashboard as dev-admin, open Today, and open Administration →
Integrations (every provider gate shows "Waiting on a decision"). Record the deployment in the
release evidence ledger: commit, the two Vercel deployment URLs, the `GET /v1/ready` answer and the
date.

## 7. Limits

- Workers run only while an API instance is warm: notices and projections catch up on the next
  request after an idle period. Production runs the worker as its own process.
- The seed's demo day is fixed to the day it was generated; add activities on the Schedule screen.
- Payments, messaging and access hardware use the fake providers (`NODE_ENV=development`).
