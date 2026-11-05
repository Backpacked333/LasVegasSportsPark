-- 0684_finance_refund_reversal_inserts.sql
-- R4-PROVIDER-OUTCOMES-02 follow-up (§4.7 invariant 6, SPK-PAY-008; CLAUDE.md "integrity that
-- matters is enforced in the database"): 0681 checks that payment_refundables.reversed_minor equals
-- the sum of the payment's reversed refunds only when either column is UPDATEd. A refund_attempts
-- row INSERTed already reversed, a payment_refundables row INSERTed with reversed_minor > 0, or a
-- DELETE of either side was never checked. The same commit-time check now also runs on those
-- writes, so the equality holds for every write path, not only the one the service uses.

-- The check reads the payment from the written row: NEW for INSERT and UPDATE, OLD for DELETE.
create or replace function payment_refundables_reversal_consistent() returns trigger
language plpgsql as $$
declare
  v_organization_id uuid;
  v_payment_attempt_id uuid;
  v_recorded bigint;
  v_reversed bigint;
begin
  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
    v_payment_attempt_id := old.payment_attempt_id;
  else
    v_organization_id := new.organization_id;
    v_payment_attempt_id := new.payment_attempt_id;
  end if;
  select reversed_minor into v_recorded
    from payment_refundables
   where organization_id = v_organization_id and payment_attempt_id = v_payment_attempt_id;
  select coalesce(sum(amount_minor), 0) into v_reversed
    from refund_attempts
   where organization_id = v_organization_id and payment_attempt_id = v_payment_attempt_id
     and reversed_at is not null;
  if coalesce(v_recorded, 0) <> v_reversed then
    raise exception 'reversed refunds of payment % (%) do not match its refundable funds (%)',
      v_payment_attempt_id, v_reversed, coalesce(v_recorded, 0)
      using errcode = 'check_violation', constraint = 'payment_refundables_reversal_consistent';
  end if;
  return null;
end
$$;

-- An INSERT trigger's WHEN cannot read OLD (and a DELETE trigger's cannot read NEW), so each write
-- gets its own constraint trigger beside 0681's UPDATE ones.
create constraint trigger refund_attempts_reversal_consistent_insert
  after insert on refund_attempts
  deferrable initially deferred
  for each row when (new.reversed_at is not null)
  execute function payment_refundables_reversal_consistent();

create constraint trigger refund_attempts_reversal_consistent_delete
  after delete on refund_attempts
  deferrable initially deferred
  for each row when (old.reversed_at is not null)
  execute function payment_refundables_reversal_consistent();

create constraint trigger payment_refundables_reversal_consistent_insert
  after insert on payment_refundables
  deferrable initially deferred
  for each row when (new.reversed_minor <> 0)
  execute function payment_refundables_reversal_consistent();

create constraint trigger payment_refundables_reversal_consistent_delete
  after delete on payment_refundables
  deferrable initially deferred
  for each row when (old.reversed_minor <> 0)
  execute function payment_refundables_reversal_consistent();
