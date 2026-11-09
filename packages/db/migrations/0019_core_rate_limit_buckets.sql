-- §4.14 "rate-limited recovery": fixed-window request counters for the routes a stranger can
-- call repeatedly (development token minting, claim and invitation acceptance, account relink).
-- One row per (bucket key, window start); a request increments its window's row with one upsert,
-- so concurrent API instances share one count. Rows are pruned once their window is a day old.
--
-- Documented exception to "every operational table has organization_id" (CLAUDE.md): the key is a
-- route name and a network address, counted before anyone is authenticated, so no organization is
-- known; nothing here is an organization's record. Like periodic_job_leases it is shared
-- infrastructure.
create table rate_limit_buckets (
  bucket_key text not null check (length(bucket_key) between 1 and 400),
  window_start timestamptz not null,
  count integer not null check (count >= 1),
  primary key (bucket_key, window_start)
);
create index rate_limit_buckets_window_idx on rate_limit_buckets (window_start);
