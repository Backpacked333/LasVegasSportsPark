-- 0012_core_idempotency_pass_reference_purge.sql
-- §4.14 protected secret storage, §4.9 (R2-CLIENTS-2-02, completing R2-TENANCY-INPUT-01): a pass
-- reference is a one-time secret, and POST /v1/passes now withholds it from the stored answer
-- (`@Idempotent({ withhold: ['reference'] })`, entry arrival.controller.ts), so a same-key replay
-- answers IDEMPOTENCY_SECRET_WITHHELD naming the pass. Answers stored before that change still hold
-- the plain reference until their 24-hour expiry; strip it from them now, the way
-- 0004_core_idempotency_secret_purge stripped the other one-time secrets. Only stored pass-issue
-- answers carry both `pass` and `reference`; nothing else is touched.
update idempotency_keys
set response_body = response_body - 'reference'
where jsonb_typeof(response_body) = 'object'
  and response_body ? 'pass'
  and response_body ? 'reference';
