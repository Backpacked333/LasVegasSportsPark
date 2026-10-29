-- 1005_communications_delivery_retry.sql
-- Communications module (COM-02): retry of a single failed delivery (SPK-COMMS-004 "failed",
-- SPK-UX-006 failed communications, §4.7 invariant 10). A retry is a NEW attempt row that names the
-- failed attempt it retries; the failed fact itself is never rewritten (§4.6). The database
-- guarantees what the service checks first:
--   - a retry names an attempt of the same organization (composite foreign key) and not itself;
--   - each failed attempt is retried at most once (a retry that fails again is retried through
--     its own row);
--   - the retried attempt is `failed`, was not failed because the recipient lost authority
--     (RECIPIENT_REVOKED) or because a newer notice made it obsolete (SUPERSEDED), and is of the same
--     recipient and channel. An `unknown` outcome is never retried: it may have reached the person.
-- The live-attempt index of migration 1000 still allows at most one non-failed attempt per
-- recipient and channel.

alter table delivery_attempts add column retry_of_attempt_id uuid;
alter table delivery_attempts
  add constraint delivery_attempts_retry_of_attempt
    foreign key (organization_id, retry_of_attempt_id) references delivery_attempts (organization_id, id),
  add constraint delivery_attempts_retry_not_self
    check (retry_of_attempt_id is null or retry_of_attempt_id <> id);
create unique index delivery_attempts_retry_once_idx on delivery_attempts (organization_id, retry_of_attempt_id)
  where retry_of_attempt_id is not null;

create or replace function delivery_attempts_retry_guard() returns trigger
language plpgsql as $$
declare
  source record;
begin
  if new.retry_of_attempt_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.retry_of_attempt_id is not distinct from old.retry_of_attempt_id then
    return new;
  end if;
  select status, failure_code, recipient_id, channel into source
    from delivery_attempts
   where organization_id = new.organization_id and id = new.retry_of_attempt_id;
  if not found then
    raise exception 'delivery attempt % retries an attempt that does not exist', new.id
      using errcode = 'foreign_key_violation', constraint = 'delivery_attempts_retry_of_attempt';
  end if;
  if source.status <> 'failed' then
    raise exception 'delivery attempt % retries attempt % in state % (only failed attempts are retried)',
      new.id, new.retry_of_attempt_id, source.status
      using errcode = 'check_violation', constraint = 'delivery_attempts_retry_guard';
  end if;
  if source.failure_code in ('RECIPIENT_REVOKED', 'SUPERSEDED') then
    raise exception 'delivery attempt % retries attempt % that failed with %',
      new.id, new.retry_of_attempt_id, source.failure_code
      using errcode = 'check_violation', constraint = 'delivery_attempts_retry_guard';
  end if;
  if source.recipient_id <> new.recipient_id or source.channel <> new.channel then
    raise exception 'delivery attempt % retries attempt % of another recipient or channel',
      new.id, new.retry_of_attempt_id
      using errcode = 'check_violation', constraint = 'delivery_attempts_retry_guard';
  end if;
  return new;
end;
$$;

create trigger delivery_attempts_retry_guard
  before insert or update of retry_of_attempt_id on delivery_attempts
  for each row execute function delivery_attempts_retry_guard();
