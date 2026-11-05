-- SPK-IAM-005 (temporary restrictions, effective dates): a restriction recorded with an end time
-- stops suspending the grant at that time, without a sweeper. Null keeps the suspension until a
-- `lift` decision.
alter table access_grants
  add column suspended_until timestamptz,
  add constraint access_grants_suspension_window_check
    check (suspended_until is null or (suspended_at is not null and suspended_until > suspended_at));
