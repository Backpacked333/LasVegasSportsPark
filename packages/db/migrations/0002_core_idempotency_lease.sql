-- §4.9, §4.7 invariant 5: a claimed idempotency key is held by a lease (claim_token, locked_until),
-- and the business transaction records on the key that it committed (committed_at, written in the
-- same transaction as the business change). A retry may take over a lapsed claim only when nothing
-- committed, and a request that committed is never executed a second time under the same key.
alter table idempotency_keys
  add column claim_token uuid,
  add column locked_until timestamptz,
  add column committed_at timestamptz;

-- Keys claimed before this migration keep their earlier behaviour: held until they expire.
update idempotency_keys set locked_until = expires_at where status = 'in_progress';
