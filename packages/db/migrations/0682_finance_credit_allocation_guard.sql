-- 0682_finance_credit_allocation_guard.sql
-- R4-DB-INVARIANTS-01 (§4.7 invariants 5 and 7: no duplicate financial effect, no double credit;
-- SPK-PAY-004/009; CLAUDE.md "integrity that matters is enforced in the database").
--
-- An allocation funded by a credit redemption was tied to that redemption only by its foreign key:
-- it could name a `reversal` row or a redemption that was already given back, carry another
-- currency than the redemption, and the redemption's allocations could sum to more than it
-- consumed (unique (credit_redemption_id, obligation_id) let one redemption of 100 settle any
-- number of obligations in full). 0602 closed the same hole for receipts only. Every allocation
-- that names a credit redemption is now checked when it is inserted, under a lock on the
-- redemption (FOR UPDATE conflicts with the key-share lock a concurrent allocation's or
-- reversal's foreign key takes, so they are serialized and each sees the other once committed):
--   * the redemption is a `redeem` row that has not been reversed;
--   * the allocation carries the redemption's currency;
--   * the redemption's allocations never sum to more than what it consumed.
-- The redemption exists before its allocation (the foreign key is not deferrable) and both are
-- append-only, so the check at insert holds for good. Reported under one named constraint.

create or replace function payment_allocation_credit_consistent() returns trigger
language plpgsql as $$
declare
  v_kind text;
  v_amount bigint;
  v_currency text;
  v_reversed boolean;
  v_summed bigint;
begin
  select kind, amount_minor, currency into v_kind, v_amount, v_currency
    from credit_redemptions
   where organization_id = new.organization_id and id = new.credit_redemption_id
     for update;
  select exists (
           select 1 from credit_redemptions
            where organization_id = new.organization_id
              and reverses_redemption_id = new.credit_redemption_id
         )
    into v_reversed;
  select coalesce(sum(amount_minor), 0)::bigint into v_summed
    from payment_allocations
   where organization_id = new.organization_id and credit_redemption_id = new.credit_redemption_id;
  if v_kind is distinct from 'redeem' or v_reversed or new.currency <> v_currency
     or v_summed > v_amount then
    raise exception 'allocation % from credit redemption % (% %, % %, reversed %) exceeds or contradicts it (allocated %)',
      new.id, new.credit_redemption_id, v_kind, v_amount, v_currency, new.currency, v_reversed, v_summed
      using errcode = 'check_violation', constraint = 'payment_allocations_credit_redemption_consistent';
  end if;
  return null;
end
$$;

create trigger payment_allocations_credit_redemption_consistent after insert on payment_allocations
  for each row when (new.credit_redemption_id is not null)
  execute function payment_allocation_credit_consistent();
