-- 0602_finance_receipt_allocation_guard.sql
-- SPK-PAY-004/005, §4.7 invariant 5 (no duplicate financial effect), CLAUDE.md "integrity that
-- matters is enforced in the database" (review2 data-and-contracts-2-04).
--
-- A receipt's allocations always equal its allocated part and carry its currency, whichever
-- transaction adds them. 0600's receipts_allocations_consistent runs only when the receipt itself
-- is inserted, and receipts are append-only, so without this a later transaction could allocate
-- the same received money to further obligations (or allocate it in another currency). This
-- checks every allocation that names a receipt, deferred to commit like 0600's checks, and reports
-- the same constraint name.
create or replace function payment_allocation_receipt_consistent() returns trigger
language plpgsql as $$
declare
  rallocated bigint;
  rcurrency text;
  summed bigint;
  foreign_currency integer;
begin
  select allocated_minor, currency into rallocated, rcurrency
    from receipts where organization_id = new.organization_id and id = new.receipt_id;
  select coalesce(sum(amount_minor), 0)::bigint, count(*) filter (where currency <> rcurrency)
    into summed, foreign_currency
    from payment_allocations
   where organization_id = new.organization_id and receipt_id = new.receipt_id;
  if summed <> rallocated or foreign_currency > 0 then
    raise exception 'receipt % allocated % (%) does not match its allocations % (% in another currency)',
      new.receipt_id, rallocated, rcurrency, summed, foreign_currency
      using errcode = 'check_violation', constraint = 'receipts_allocations_consistent';
  end if;
  return null;
end
$$;
create constraint trigger payment_allocations_receipt_consistent after insert on payment_allocations
  deferrable initially deferred for each row when (new.receipt_id is not null)
  execute function payment_allocation_receipt_consistent();
