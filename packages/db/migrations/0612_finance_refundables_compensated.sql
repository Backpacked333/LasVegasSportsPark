-- 0612_finance_refundables_compensated.sql
-- MONEY-02 (SPK-PAY-008, SPK-PAY-009, §4.7 invariant 6: a refund never exceeds what was paid):
-- compensating an unfulfilled checkout by credit gave back the order's gross receipts without
-- consuming the payments' refundable funds, so money already refunded was credited again and a
-- credit-compensated payment could still be refunded in full. A payment's refundable funds now
-- also count what a compensation credit took from them: refunded + reserved + compensated never
-- exceeds what was captured, and the compensated amount only accumulates.

alter table payment_refundables
  add column compensated_minor bigint not null default 0 check (compensated_minor >= 0);

alter table payment_refundables drop constraint payment_refundables_within_captured;
alter table payment_refundables add constraint payment_refundables_within_captured
  check (refunded_minor + reserved_minor + compensated_minor <= captured_minor);

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
  return new;
end
$$;
