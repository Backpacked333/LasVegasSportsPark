# Protected staging deployment

**Status (§6.7):** verified to boot and answer locally through the Vercel entry
(`apps/api/api/index.js`); the hosted staging is **proposed** until its first deployment is checked.
Hosting (DEC-021) and identity (DEC-018) remain **pending decisions**: this is a demo environment
with synthetic data, not production.

## Shape

| Piece           | Where                                                | Notes                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | Supabase project `las-vegas-sports-park` (us-west-1) | All migrations in `packages/db/migrations`, recorded in `schema_migrations` with the runner's checksums. Supabase's Data API roles (`anon`, `authenticated`) have no grants and every table has row level security on: only the API's own connection reads or writes. |
| API             | Vercel project with root `apps/api`                  | `api/index.js` boots the Nest application once per instance. `STAGING_INLINE_WORKER=true` runs the worker loops (outbox, inbox, background workers, idempotency sweep) inside warm instances, because a function host has no worker process.                          |
| Staff dashboard | Vercel project with root `apps/staff`                | `VITE_STAGING=true` keeps the development sign-in in the bundle (the release-bundle check is skipped for that build only); `VITE_API_BASE_URL` points at the API.                                                                                                     |

## Sign-in

The API runs `NODE_ENV=development` with the local identity provider. `DEV_TOKENS_PASSCODE` makes
`POST /v1/dev/tokens` mint a token only with the passcode, so an account id alone signs nobody in.
The staff sign-in page asks for the account id and the staging passcode.

Demo accounts (synthetic, from `docs/deploy/staging-seed.sql`):

| Account                          | Account id                             |
| -------------------------------- | -------------------------------------- |
| dev-admin (system administrator) | `01a1b21d-60d9-7f51-b3f7-88b995319799` |
| dev-desk (front desk)            | `01a1b21d-60f7-7300-87e5-02264af5a396` |
| dev-league (league manager)      | `01a1b21d-610e-774b-9f00-056183cf2f64` |
| dev-coach (coach)                | `01a1b21d-6128-7381-8ac7-ae7f77b45590` |
| dev-official (official)          | `01a1b21d-613f-7b07-8d6d-f801ea4dacf4` |

## Environment

API project (secrets marked *):

| Variable                | Value                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`              | `development`                                                                      |
| `AUTH_MODE`             | `local`                                                                            |
| `AUTH_LOCAL_SECRET` *   | 64 random hex characters (`openssl rand -hex 32`)                                  |
| `DEV_TOKENS_PASSCODE` * | a passphrase of at least 16 characters, shared only with staging users             |
| `DATABASE_URL` *        | Supabase **Session pooler** connection string (Project → Connect → Session pooler) |
| `DB_AUTO_MIGRATE`       | `false` (migrations are applied ahead of deploys)                                  |
| `CORS_ALLOWED_ORIGINS`  | the staff project's https origin                                                   |
| `STAGING_INLINE_WORKER` | `true`                                                                             |

Staff project: `VITE_STAGING=true`, `VITE_API_BASE_URL=https://<api host>/v1`.

## Limits

- Workers run only while an API instance is warm: notices and projections catch up on the next
  request after an idle period.
- The seed's demo day is fixed to the day it was generated; add activities on the Schedule screen.
- Payments, messaging and access hardware use the fake providers.
