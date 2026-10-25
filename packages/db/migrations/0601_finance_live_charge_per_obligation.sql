-- §4.7 invariant 5, SPK-PAY-007 (review2 finance-01): at most one live checkout or installment
-- charge per obligation. A checkout attempt names the obligation it pays (the due-now installment
-- or the order obligation), so the installment worker can never charge the same debt while the
-- checkout's own payment is still in flight, processing, awaiting a challenge or unknown.
-- Obligation and contribution payments stay under payment_attempts_live_payer_idx: several payers
-- may legitimately pay one team obligation at the same time.
create unique index payment_attempts_live_obligation_idx on payment_attempts (organization_id, obligation_id)
  where obligation_id is not null
    and purpose in ('checkout', 'installment')
    and status in ('created', 'action_required', 'processing', 'unknown');
