-- §4.12: inbox events carry a retry policy (next attempt time with backoff, max attempts) and a
-- failure owner like outbox events, and are claimed with a lease (locked_by, locked_until) so that
-- concurrent workers never process the same event at the same time.
alter table inbox_events
  add column available_at timestamptz not null default now(),
  add column max_attempts integer not null default 10 check (max_attempts > 0),
  add column failure_owner text,
  add column locked_by text,
  add column locked_until timestamptz;
