-- 0611_finance_one_live_charge_per_debt.sql
-- MONEY-07 (SPK-PAY-007, §4.7 invariant 5; CLAUDE.md "integrity that matters is enforced in the
-- database"): 0601 allows one live checkout or installment charge per obligation, and 0600 one live
-- obligation or contribution payment per payer and obligation, but no index spanned an installment
-- collection and a direct payment of the same debt, so under READ COMMITTED both could commit and
-- both charge. This index allows at most one live charge per obligation across the checkout,
-- installment and direct-payment purposes (several payers paying the same debt at once included).
-- Contribution payments are left out: several players may pay one team obligation at the same time
-- (SPK-PAY-005, their excess stays visible), as 0601 intends.
create unique index payment_attempts_live_charge_idx on payment_attempts (organization_id, obligation_id)
  where obligation_id is not null
    and purpose in ('checkout', 'installment', 'obligation')
    and status in ('created', 'action_required', 'processing', 'unknown');
