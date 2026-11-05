-- 0683_finance_credit_reversal_guard.sql
-- R4-DB-INVARIANTS-02 (§4.7 invariant 7: no double credit; §4.7 invariant 9; SPK-PAY-009 credit
-- redemption history; CLAUDE.md "integrity that matters is enforced in the database").
--
-- A credit `reversal` row could name any redemption of the organization: the foreign key
-- (organization_id, reverses_redemption_id) left out the credit, and nothing checked that the
-- target was a `redeem` row of the same reference and amount. credits_history_consistent only sums
-- each credit's own rows, so a stray reversal returned money to one credit while the redemption of
-- another still stood, and (credit_redemptions_one_reversal_idx being one per target) it took the
-- slot of that redemption's genuine reversal. Package and makeup redemptions already refuse this
-- (0518). Now:
--   * the reversal names its target together with its own credit (composite foreign key onto the
--     new (organization_id, credit_id, id) key), so it can only give back a redemption of the
--     same credit;
--   * a before-insert trigger requires the target to be a `redeem` row with the same reference,
--     currency and amount (the service always reverses a redemption in full).
-- The earlier (organization_id, reverses_redemption_id) key stays: the new one implies it.

alter table credit_redemptions
  add constraint credit_redemptions_organization_id_credit_id_id_key unique (organization_id, credit_id, id);

alter table credit_redemptions
  add constraint credit_redemptions_reversal_same_credit_fk
    foreign key (organization_id, credit_id, reverses_redemption_id)
    references credit_redemptions (organization_id, credit_id, id) not valid;
alter table credit_redemptions validate constraint credit_redemptions_reversal_same_credit_fk;

create or replace function credit_redemptions_reversal_matches() returns trigger
language plpgsql as $$
declare
  v_target record;
begin
  select kind, credit_id, reference_type, reference_id, currency, amount_minor
    into v_target
    from credit_redemptions
   where organization_id = new.organization_id and id = new.reverses_redemption_id;
  if not found then
    return new; -- the foreign keys report a missing target
  end if;
  if v_target.kind <> 'redeem' or v_target.credit_id <> new.credit_id
     or v_target.reference_type <> new.reference_type or v_target.reference_id <> new.reference_id
     or v_target.currency <> new.currency or v_target.amount_minor <> new.amount_minor then
    raise exception 'credit reversal % must give back a redemption of the same credit, reference and amount (target %: % % % %/% %)',
      new.id, new.reverses_redemption_id, v_target.kind, v_target.amount_minor, v_target.currency,
      v_target.reference_type, v_target.reference_id, v_target.credit_id
      using errcode = 'check_violation', constraint = 'credit_redemptions_reversal_matches';
  end if;
  return new;
end
$$;

create trigger credit_redemptions_reversal_matches before insert on credit_redemptions
  for each row when (new.kind = 'reversal')
  execute function credit_redemptions_reversal_matches();
