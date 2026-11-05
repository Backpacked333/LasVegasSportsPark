-- 0681_finance_refund_reversal.sql
-- R4-PROVIDER-OUTCOMES-02 (§4.11: provider money facts stay visible even when they contradict a
-- recorded state; SPK-PAY-008 / §4.7 invariant 6: the refundable ceiling reflects money actually
-- returned; SPK-PAY-010: a correction is a reversing entry, never an edit): a refund recorded
-- `succeeded` that the provider later reports `failed` returned no money. The refund keeps its
-- state (the Refund machine and refund_attempts_guard forbid succeeded -> failed), but the
-- reversal is now a recorded fact:
--   * refund_attempts.reversed_at: when the contradicting failure was booked; set once, only on a
--     succeeded refund;
--   * payment_refundables.reversed_minor: the refunded money that came back, so the refundable
--     funds are captured - (refunded - reversed) - reserved - compensated. It only accumulates,
--     never exceeds what was refunded, and always equals the sum of the payment's reversed
--     refunds (deferred check, so the two rows can be written in either order);
--   * the reversing journal is the ledger's (purpose `refund_reversed`, one per refund: journals
--     are unique per source and purpose, and a journal is reversed at most once).

alter table refund_attempts add column reversed_at timestamptz;
alter table refund_attempts add constraint refund_attempts_reversal_fact
  check (reversed_at is null or status = 'succeeded');

alter table payment_refundables
  add column reversed_minor bigint not null default 0 check (reversed_minor >= 0);
alter table payment_refundables drop constraint payment_refundables_within_captured;
alter table payment_refundables add constraint payment_refundables_within_captured
  check (refunded_minor - reversed_minor + reserved_minor + compensated_minor <= captured_minor);
alter table payment_refundables add constraint payment_refundables_reversal_within_refunded
  check (reversed_minor <= refunded_minor);

create or replace function payment_refundables_guard() returns trigger
language plpgsql as $$
begin
  if new.captured_minor <> old.captured_minor or new.currency <> old.currency
     or new.receipt_id is distinct from old.receipt_id
     or new.pos_tender_id is distinct from old.pos_tender_id
     or new.organization_id <> old.organization_id then
    raise exception 'refundable funds of % are fixed at capture', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_immutable';
  end if;
  if new.refunded_minor < old.refunded_minor then
    raise exception 'refunded amount of % only accumulates', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_accumulate';
  end if;
  if new.compensated_minor < old.compensated_minor then
    raise exception 'compensated amount of % only accumulates', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_compensated_accumulate';
  end if;
  if new.reversed_minor < old.reversed_minor then
    raise exception 'reversed refund amount of % only accumulates', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_reversed_accumulate';
  end if;
  return new;
end
$$;

create or replace function refund_attempts_guard() returns trigger
language plpgsql as $$
begin
  if new.amount_minor <> old.amount_minor or new.currency <> old.currency
     or new.payment_attempt_id <> old.payment_attempt_id then
    raise exception 'refund % amount is immutable', old.id
      using errcode = 'check_violation', constraint = 'refund_attempts_basis_immutable';
  end if;
  if old.reversed_at is not null and new.reversed_at is distinct from old.reversed_at then
    raise exception 'the reversal of refund % is recorded once', old.id
      using errcode = 'check_violation', constraint = 'refund_attempts_reversal_once';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'requested' and new.status in ('processing', 'canceled', 'failed', 'unknown'))
     or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'unknown'))
     or (old.status = 'unknown' and new.status in ('succeeded', 'failed')) then
    return new;
  end if;
  raise exception 'refund % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'refund_attempts_machine';
end
$$;

-- reversed_minor equals the payment's reversed refunds, checked at commit. Both tables carry the
-- payment as (organization_id, payment_attempt_id).
create or replace function payment_refundables_reversal_consistent() returns trigger
language plpgsql as $$
declare
  v_recorded bigint;
  v_reversed bigint;
begin
  select reversed_minor into v_recorded
    from payment_refundables
   where organization_id = new.organization_id and payment_attempt_id = new.payment_attempt_id;
  select coalesce(sum(amount_minor), 0) into v_reversed
    from refund_attempts
   where organization_id = new.organization_id and payment_attempt_id = new.payment_attempt_id
     and reversed_at is not null;
  if coalesce(v_recorded, 0) <> v_reversed then
    raise exception 'reversed refunds of payment % (%) do not match its refundable funds (%)',
      new.payment_attempt_id, v_reversed, coalesce(v_recorded, 0)
      using errcode = 'check_violation', constraint = 'payment_refundables_reversal_consistent';
  end if;
  return null;
end
$$;

create constraint trigger refund_attempts_reversal_consistent
  after update of reversed_at on refund_attempts
  deferrable initially deferred
  for each row when (new.reversed_at is not null)
  execute function payment_refundables_reversal_consistent();

create constraint trigger payment_refundables_reversal_consistent
  after update of reversed_minor on payment_refundables
  deferrable initially deferred
  for each row when (new.reversed_minor <> old.reversed_minor)
  execute function payment_refundables_reversal_consistent();
