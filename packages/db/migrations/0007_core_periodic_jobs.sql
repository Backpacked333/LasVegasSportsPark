-- §4.12 durable, interruption-tolerant background work with a failure owner (K-06, IF-24).
--
-- One lease row per periodic job (a time-based sweep such as an expiry job). A runner claims a job
-- with one statement (insert ... on conflict do update ... where the lease is free or expired and
-- the job's interval has elapsed ... returning), so two runners racing one job run it once, and a
-- lease whose worker died is taken over once it expires (SPK-AT-023).
--
-- Documented exception to "every operational table has organization_id" (CLAUDE.md): this is
-- shared scheduling infrastructure, not an organization's record. A job sweeps rows of every
-- organization and changes each one in its own small transaction under the system principal of
-- that row's organization; the failure owner's exceptions are raised per organization.
create table periodic_job_leases (
  job_name text primary key check (job_name ~ '^[a-z]+\.[a-z0-9_]+$'),
  locked_by text check (locked_by is null or length(locked_by) between 1 and 400),
  locked_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 4000),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  run_count integer not null default 0 check (run_count >= 0),
  check ((locked_by is null) = (locked_until is null))
);
