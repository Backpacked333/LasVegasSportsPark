-- §4.14 protected secret storage, §4.9: one-time secrets (invitation, claim, team invitation,
-- export download and calendar feed tokens, and the feed path that embeds its token) are no longer
-- stored with idempotency keys (IdempotentOptions.withhold in
-- apps/api/src/kernel/http/idempotency.interceptor.ts). Strip them from responses stored before
-- that change, so a replay answers IDEMPOTENCY_SECRET_WITHHELD, and drop records past their expiry,
-- which the worker's sweep now removes continuously (IdempotencySweeper).
delete from idempotency_keys where expires_at < now();

update idempotency_keys
set response_body = response_body - 'token' - 'downloadToken' - 'path'
where jsonb_typeof(response_body) = 'object'
  and response_body ?| array['token', 'downloadToken'];
