-- 0600_finance_core.sql
-- Finance module (specification §3.15 SPK-PAY-001..012, §4.4 Finance + Accounting support, §4.5,
-- §4.6 PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7, §4.11, §4.12).
--
-- Money is bigint minor units next to an ISO currency (SPK-PAY-001). Every table is organization
-- scoped and references other organization-scoped rows through composite (organization_id, id)
-- keys, including rows owned by identity, catalog, competition and enrollment (read-only here).
-- Integrity that matters is enforced in the database:
--   * invariant 5 (no duplicate financial effect from replay): one receipt per payment fact, one
--     journal per (source, purpose), one live payment attempt per checkout / installment, one
--     succeeded attempt per checkout, one credit per source fact, one redemption per reference;
--   * invariant 6 (no refund beyond refundable funds): payment_refundables check
--     (refunded + reserved <= captured), reservations move by conditional UPDATE;
--   * invariant 7 (no double credit redemption): credits check (remaining >= 0), conditional UPDATE;
--   * SPK-PAY-010: journals and journal entries are append-only and every journal balances
--     (deferred constraint trigger); corrections are reversing entries;
--   * §4.6: transition guards refuse every state change the canonical machines do not allow.

-- ---------------------------------------------------------------------------------------------
-- Quotes (SPK-PAY-002): every participant and item, base price, discounts, approved taxes and
-- fees, credits applied, due now, future obligations, expiry and applicable policies.
-- ---------------------------------------------------------------------------------------------
create table quotes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  basket_id uuid not null,
  payer_person_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null check (discount_minor >= 0),
  tax_minor bigint not null check (tax_minor >= 0),
  fee_minor bigint not null check (fee_minor >= 0),
  included_tax_minor bigint not null default 0 check (included_tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  credits_applied_minor bigint not null default 0 check (credits_applied_minor >= 0),
  due_now_minor bigint not null check (due_now_minor >= 0),
  future_minor bigint not null default 0 check (future_minor >= 0),
  payment_plan text not null default 'full' check (payment_plan in ('full', 'installments')),
  future_obligations jsonb not null default '[]'::jsonb,
  applied_credits jsonb not null default '[]'::jsonb,
  discount_codes jsonb not null default '[]'::jsonb,
  discounts jsonb not null default '[]'::jsonb,
  policy_references jsonb not null,
  basket_revision integer not null,
  status text not null default 'active' check (status in ('active', 'expired', 'consumed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_checkout_id uuid,
  expired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  constraint quotes_total_consistent check (total_minor = subtotal_minor - discount_minor + tax_minor + fee_minor),
  constraint quotes_credits_within_total check (credits_applied_minor <= total_minor),
  constraint quotes_due_consistent check (due_now_minor + future_minor = total_minor - credits_applied_minor),
  constraint quotes_plan_consistent check (payment_plan = 'installments' or future_minor = 0),
  constraint quotes_consumed_fact check ((status = 'consumed') = (consumed_at is not null and consumed_by_checkout_id is not null)),
  constraint quotes_expired_fact check ((status = 'expired') = (expired_at is not null))
);
create index quotes_basket_idx on quotes (organization_id, basket_id, created_at desc);
create trigger quotes_touch before update on quotes
  for each row execute function touch_updated_at();

-- A quote's price basis never changes after it is issued; only its status moves (active → expired | consumed).
create or replace function quotes_guard() returns trigger
language plpgsql as $$
begin
  if new.basket_id <> old.basket_id or new.payer_person_id <> old.payer_person_id
     or new.currency <> old.currency or new.subtotal_minor <> old.subtotal_minor
     or new.discount_minor <> old.discount_minor or new.tax_minor <> old.tax_minor
     or new.fee_minor <> old.fee_minor or new.total_minor <> old.total_minor
     or new.credits_applied_minor <> old.credits_applied_minor
     or new.due_now_minor <> old.due_now_minor or new.future_minor <> old.future_minor
     or new.future_obligations <> old.future_obligations or new.applied_credits <> old.applied_credits
     or new.discounts <> old.discounts or new.policy_references <> old.policy_references
     or new.expires_at <> old.expires_at then
    raise exception 'quote % price basis is immutable', old.id
      using errcode = 'check_violation', constraint = 'quotes_basis_immutable';
  end if;
  if new.status <> old.status and not (old.status = 'active' and new.status in ('expired', 'consumed')) then
    raise exception 'quote % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'quotes_machine';
  end if;
  return new;
end
$$;
create trigger quotes_guard before update on quotes
  for each row execute function quotes_guard();

create table quote_lines (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  quote_id uuid not null,
  sequence integer not null check (sequence >= 1),
  basket_line_id uuid not null,
  participant_person_id uuid not null,
  offering_id uuid not null,
  description text not null,
  quantity integer not null check (quantity >= 1),
  price_rule_id uuid,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  base_amount_minor bigint not null check (base_amount_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  included_tax_minor bigint not null default 0 check (included_tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  discount_lines jsonb not null default '[]'::jsonb,
  charge_lines jsonb not null default '[]'::jsonb,
  policy_references jsonb not null,
  equivalence_key text,
  enrollment_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (quote_id, sequence),
  unique (quote_id, basket_line_id),
  foreign key (organization_id, quote_id) references quotes (organization_id, id),
  foreign key (organization_id, basket_line_id) references basket_lines (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, price_rule_id) references price_rules (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  constraint quote_lines_base_consistent check (base_amount_minor = unit_price_minor * quantity),
  constraint quote_lines_priced check (price_rule_id is not null or unit_price_minor = 0),
  constraint quote_lines_discount_within_base check (discount_minor <= base_amount_minor),
  constraint quote_lines_total_consistent check (total_minor = base_amount_minor - discount_minor + tax_minor + fee_minor)
);
create trigger quote_lines_append_only before update or delete on quote_lines
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Orders and order lines: historical purchases retain their price and policy basis (SPK-PAY-002).
-- Payment and fulfillment are independent facts with their own columns (§4.6).
-- ---------------------------------------------------------------------------------------------
create table orders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  quote_id uuid not null,
  basket_id uuid not null,
  payer_person_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0),
  credits_applied_minor bigint not null default 0 check (credits_applied_minor >= 0),
  due_now_minor bigint not null check (due_now_minor >= 0),
  payment_status text not null default 'awaiting_payment' check (payment_status in ('awaiting_payment', 'paid', 'canceled')),
  fulfillment_status text not null default 'pending' check (fulfillment_status in ('pending', 'fulfilled', 'recovery_required', 'compensated', 'canceled')),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  policy_references jsonb not null,
  created_by jsonb not null,
  created_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, quote_id),
  foreign key (organization_id, quote_id) references quotes (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  constraint orders_credits_within_total check (credits_applied_minor <= total_minor),
  constraint orders_paid_fact check ((payment_status = 'paid') = (paid_at is not null)),
  constraint orders_canceled_fact check ((payment_status = 'canceled') = (canceled_at is not null)),
  constraint orders_fulfilled_fact check ((fulfillment_status = 'fulfilled') = (fulfilled_at is not null)),
  constraint orders_fulfilled_after_payment check (fulfillment_status not in ('fulfilled', 'recovery_required', 'compensated') or payment_status = 'paid')
);
create index orders_payer_idx on orders (organization_id, payer_person_id, created_at desc);
create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();

create or replace function orders_guard() returns trigger
language plpgsql as $$
begin
  if new.quote_id <> old.quote_id or new.basket_id <> old.basket_id
     or new.payer_person_id <> old.payer_person_id or new.currency <> old.currency
     or new.total_minor <> old.total_minor or new.credits_applied_minor <> old.credits_applied_minor
     or new.due_now_minor <> old.due_now_minor or new.policy_references <> old.policy_references then
    raise exception 'order % price basis is immutable', old.id
      using errcode = 'check_violation', constraint = 'orders_basis_immutable';
  end if;
  if new.payment_status <> old.payment_status
     and not (old.payment_status = 'awaiting_payment' and new.payment_status in ('paid', 'canceled')) then
    raise exception 'order % payment cannot move from % to %', old.id, old.payment_status, new.payment_status
      using errcode = 'check_violation', constraint = 'orders_payment_machine';
  end if;
  if new.fulfillment_status <> old.fulfillment_status
     and not (
       (old.fulfillment_status = 'pending' and new.fulfillment_status in ('fulfilled', 'recovery_required', 'canceled'))
       or (old.fulfillment_status = 'recovery_required' and new.fulfillment_status in ('fulfilled', 'compensated'))
     ) then
    raise exception 'order % fulfillment cannot move from % to %', old.id, old.fulfillment_status, new.fulfillment_status
      using errcode = 'check_violation', constraint = 'orders_fulfillment_machine';
  end if;
  return new;
end
$$;
create trigger orders_guard before update on orders
  for each row execute function orders_guard();

create table order_lines (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  order_id uuid not null,
  quote_line_id uuid not null,
  sequence integer not null check (sequence >= 1),
  basket_line_id uuid not null,
  enrollment_id uuid,
  participant_person_id uuid not null,
  offering_id uuid not null,
  description text not null,
  quantity integer not null check (quantity >= 1),
  price_rule_id uuid,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  base_amount_minor bigint not null check (base_amount_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_basis jsonb not null,
  policy_references jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (order_id, sequence),
  unique (order_id, quote_line_id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, quote_line_id) references quote_lines (organization_id, id),
  foreign key (organization_id, basket_line_id) references basket_lines (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, participant_person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, price_rule_id) references price_rules (organization_id, id),
  constraint order_lines_base_consistent check (base_amount_minor = unit_price_minor * quantity),
  constraint order_lines_total_consistent check (total_minor = base_amount_minor - discount_minor + tax_minor + fee_minor)
);
create index order_lines_enrollment_idx on order_lines (organization_id, enrollment_id) where enrollment_id is not null;
create trigger order_lines_append_only before update or delete on order_lines
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Installment plans (SPK-PAY-006): amounts, due dates, authorization, retry policy, notices,
-- extensions and outstanding obligations (each installment is one obligation).
-- ---------------------------------------------------------------------------------------------
create table installment_plans (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  order_id uuid not null,
  payer_person_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor > 0),
  installment_count integer not null check (installment_count between 2 and 24),
  status text not null default 'active' check (status in ('active', 'completed', 'defaulted', 'canceled')),
  payment_authorization jsonb not null,
  retry_policy jsonb not null,
  notice_policy jsonb not null,
  policy_version_id uuid,
  created_by jsonb not null,
  completed_at timestamptz,
  defaulted_at timestamptz,
  canceled_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, order_id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, policy_version_id) references policy_versions (organization_id, id),
  constraint installment_plans_completed_fact check ((status = 'completed') = (completed_at is not null))
);
create trigger installment_plans_touch before update on installment_plans
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Obligations (SPK-PAY-004): who owes what. A team obligation with player contributions is ONE
-- obligation; contribution requests are allocations against it, never copies of the debt.
-- ---------------------------------------------------------------------------------------------
create table obligations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  debtor_kind text not null check (debtor_kind in ('person', 'team_entry')),
  debtor_person_id uuid,
  debtor_team_entry_id uuid,
  mode text not null check (mode in ('individual', 'single_team_payer', 'team_with_contributions')),
  responsible_payer_person_id uuid,
  source_kind text not null check (source_kind in ('order', 'installment', 'team_fee', 'manual')),
  source_id uuid,
  order_id uuid,
  installment_plan_id uuid,
  description text not null,
  amount_minor bigint not null check (amount_minor > 0),
  allocated_minor bigint not null default 0 check (allocated_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'settled', 'written_off', 'canceled')),
  settled_at timestamptz,
  written_off_at timestamptz,
  canceled_at timestamptz,
  status_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, mode),
  foreign key (organization_id, debtor_person_id) references persons (organization_id, id),
  foreign key (organization_id, debtor_team_entry_id) references team_entries (organization_id, id),
  foreign key (organization_id, responsible_payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, installment_plan_id) references installment_plans (organization_id, id),
  constraint obligations_allocated_within_amount check (allocated_minor <= amount_minor),
  constraint obligations_person_debtor check ((debtor_kind = 'person') = (debtor_person_id is not null)),
  constraint obligations_team_debtor check ((debtor_kind = 'team_entry') = (debtor_team_entry_id is not null)),
  constraint obligations_mode_debtor check ((mode = 'individual') = (debtor_kind = 'person')),
  constraint obligations_single_payer check (mode <> 'single_team_payer' or responsible_payer_person_id is not null),
  constraint obligations_settled_fact check ((status = 'settled') = (settled_at is not null)),
  constraint obligations_settled_amount check (status <> 'settled' or allocated_minor = amount_minor),
  constraint obligations_open_remaining check (status <> 'open' or allocated_minor < amount_minor),
  constraint obligations_order_source check (source_kind not in ('order', 'installment') or order_id is not null)
);
-- Invariant 5: one obligation per source fact and debtor (a replayed command cannot bill twice).
create unique index obligations_source_idx on obligations
  (organization_id, source_kind, source_id, coalesce(debtor_person_id, debtor_team_entry_id))
  where source_id is not null and status <> 'canceled';
create index obligations_person_idx on obligations (organization_id, debtor_person_id, status) where debtor_person_id is not null;
create index obligations_team_idx on obligations (organization_id, debtor_team_entry_id, status) where debtor_team_entry_id is not null;
create trigger obligations_touch before update on obligations
  for each row execute function touch_updated_at();

create or replace function obligations_guard() returns trigger
language plpgsql as $$
begin
  if new.amount_minor <> old.amount_minor or new.currency <> old.currency
     or new.debtor_kind <> old.debtor_kind
     or new.debtor_person_id is distinct from old.debtor_person_id
     or new.debtor_team_entry_id is distinct from old.debtor_team_entry_id
     or new.mode <> old.mode then
    raise exception 'obligation % amount and debtor are immutable', old.id
      using errcode = 'check_violation', constraint = 'obligations_basis_immutable';
  end if;
  if new.allocated_minor < old.allocated_minor then
    raise exception 'obligation % allocations only accumulate (corrections are new records)', old.id
      using errcode = 'check_violation', constraint = 'obligations_allocations_accumulate';
  end if;
  if new.status <> old.status and not (old.status = 'open' and new.status in ('settled', 'written_off', 'canceled')) then
    raise exception 'obligation % cannot move from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'obligations_machine';
  end if;
  return new;
end
$$;
create trigger obligations_guard before update on obligations
  for each row execute function obligations_guard();

create table installments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  plan_id uuid not null,
  sequence integer not null check (sequence >= 1),
  obligation_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  due_at timestamptz not null,
  original_due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'paid', 'failed', 'canceled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  last_failure_reason text,
  next_retry_at timestamptz,
  paid_at timestamptz,
  failed_at timestamptz,
  extension_count integer not null default 0 check (extension_count >= 0),
  extension_reason text,
  notice_sent_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (plan_id, sequence),
  unique (organization_id, obligation_id),
  foreign key (organization_id, plan_id) references installment_plans (organization_id, id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  constraint installments_paid_fact check ((status = 'paid') = (paid_at is not null)),
  constraint installments_failed_fact check (status <> 'failed' or failed_at is not null)
);
create index installments_due_idx on installments (organization_id, status, due_at) where status in ('scheduled', 'failed');
create trigger installments_touch before update on installments
  for each row execute function touch_updated_at();

create or replace function installments_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'scheduled' and new.status in ('paid', 'failed', 'canceled'))
     or (old.status = 'failed' and new.status in ('scheduled', 'paid', 'canceled')) then
    return new;
  end if;
  raise exception 'installment % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'installments_machine';
end
$$;
create trigger installments_transition_guard before update on installments
  for each row execute function installments_transition_guard();

-- Contribution requests (SPK-PAY-004): a request against ONE team obligation (the composite key
-- carries the obligation's mode, so a request can only point at a team_with_contributions
-- obligation). A request grants no authority over the payer's account and holds no amount owed.
create table contribution_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  obligation_id uuid not null,
  obligation_mode text not null default 'team_with_contributions' check (obligation_mode = 'team_with_contributions'),
  requested_person_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  message text,
  status text not null default 'requested' check (status in ('requested', 'paid', 'canceled')),
  receipt_id uuid,
  paid_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, obligation_id, obligation_mode) references obligations (organization_id, id, mode),
  foreign key (organization_id, requested_person_id) references persons (organization_id, id),
  constraint contribution_requests_paid_fact check ((status = 'paid') = (paid_at is not null and receipt_id is not null)),
  constraint contribution_requests_canceled_fact check ((status = 'canceled') = (canceled_at is not null))
);
create unique index contribution_requests_open_idx on contribution_requests
  (organization_id, obligation_id, requested_person_id) where status = 'requested';
create trigger contribution_requests_touch before update on contribution_requests
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Checkouts (§4.11 coordinator; CheckoutMachine). One live checkout per basket, one per quote.
-- ---------------------------------------------------------------------------------------------
create table checkouts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  quote_id uuid not null,
  order_id uuid not null,
  basket_id uuid not null,
  payer_person_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  status text not null default 'prepared' check (status in ('prepared', 'awaiting_payment', 'finalizing', 'completed', 'recovery_required', 'compensated', 'aborted')),
  payment_kind text not null check (payment_kind in ('provider', 'cash', 'none')),
  hold_ids jsonb not null default '[]'::jsonb,
  enrollment_ids jsonb not null default '[]'::jsonb,
  payment_attempt_id uuid,
  cash_tender_id uuid,
  operation_id uuid not null references operations(id),
  failure_code text,
  failure_details jsonb,
  recovery jsonb,
  recovery_attempts integer not null default 0 check (recovery_attempts >= 0),
  completed_at timestamptz,
  aborted_at timestamptz,
  compensated_at timestamptz,
  recovery_required_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, quote_id),
  unique (organization_id, order_id),
  foreign key (organization_id, quote_id) references quotes (organization_id, id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, basket_id) references baskets (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  constraint checkouts_completed_fact check ((status = 'completed') = (completed_at is not null)),
  constraint checkouts_aborted_fact check ((status = 'aborted') = (aborted_at is not null)),
  constraint checkouts_compensated_fact check ((status = 'compensated') = (compensated_at is not null)),
  constraint checkouts_recovery_fact check (status not in ('recovery_required', 'compensated') or recovery_required_at is not null)
);
-- Invariant 2 at the money boundary: one live checkout per basket.
create unique index checkouts_live_basket_idx on checkouts (organization_id, basket_id)
  where status in ('prepared', 'awaiting_payment', 'finalizing', 'recovery_required');
create index checkouts_status_idx on checkouts (organization_id, status, updated_at);
create trigger checkouts_touch before update on checkouts
  for each row execute function touch_updated_at();

create or replace function checkouts_transition_guard() returns trigger
language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'prepared' and new.status in ('awaiting_payment', 'finalizing', 'aborted'))
     or (old.status = 'awaiting_payment' and new.status in ('finalizing', 'aborted'))
     or (old.status = 'finalizing' and new.status in ('completed', 'recovery_required'))
     or (old.status = 'recovery_required' and new.status in ('completed', 'compensated')) then
    return new;
  end if;
  raise exception 'checkout % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'checkouts_machine';
end
$$;
create trigger checkouts_transition_guard before update on checkouts
  for each row execute function checkouts_transition_guard();

-- ---------------------------------------------------------------------------------------------
-- Payment attempts (PaymentAttemptMachine). Card details never reach this API: only an opaque
-- provider payment-method reference is stored. `unknown` is resolved only by authoritative
-- evidence (SPK-PAY-007); evidence that contradicts a terminal state is an exception, never a flip.
-- ---------------------------------------------------------------------------------------------
create table payment_attempts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  purpose text not null check (purpose in ('checkout', 'obligation', 'contribution', 'installment')),
  checkout_id uuid,
  order_id uuid,
  obligation_id uuid,
  contribution_request_id uuid,
  installment_id uuid,
  payer_person_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  provider text not null,
  payment_method_ref text not null,
  provider_reference text,
  status text not null default 'created' check (status in ('created', 'action_required', 'processing', 'succeeded', 'failed', 'canceled', 'unknown')),
  action_required_payload jsonb,
  failure_reason text,
  processor_fee_minor bigint check (processor_fee_minor is null or processor_fee_minor >= 0),
  evidence_source text check (evidence_source in ('sync_response', 'webhook', 'reconciliation')),
  evidence_inbox_event_id uuid references inbox_events(id),
  -- Provider-side ordering of applied evidence: an older non-terminal event never moves the state back.
  evidence_sequence integer,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  submitted_at timestamptz,
  unknown_since timestamptz,
  resolved_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (provider, provider_reference),
  foreign key (organization_id, checkout_id) references checkouts (organization_id, id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  foreign key (organization_id, contribution_request_id) references contribution_requests (organization_id, id),
  foreign key (organization_id, installment_id) references installments (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  constraint payment_attempts_purpose_target check (
    (purpose = 'checkout' and checkout_id is not null and order_id is not null)
    or (purpose = 'obligation' and obligation_id is not null)
    or (purpose = 'contribution' and obligation_id is not null and contribution_request_id is not null)
    or (purpose = 'installment' and obligation_id is not null and installment_id is not null)
  ),
  constraint payment_attempts_unknown_fact check (status <> 'unknown' or unknown_since is not null),
  constraint payment_attempts_resolved_fact check ((status in ('succeeded', 'failed', 'canceled')) = (resolved_at is not null)),
  constraint payment_attempts_succeeded_reference check (status <> 'succeeded' or provider_reference is not null),
  constraint payment_attempts_no_card_data check (payment_method_ref !~ '[0-9]{12,19}')
);
-- SPK-PAY-007: no second charge while an attempt is live or unknown.
create unique index payment_attempts_live_checkout_idx on payment_attempts (organization_id, checkout_id)
  where checkout_id is not null and status in ('created', 'action_required', 'processing', 'unknown');
create unique index payment_attempts_live_installment_idx on payment_attempts (organization_id, installment_id)
  where installment_id is not null and status in ('created', 'action_required', 'processing', 'unknown');
create unique index payment_attempts_live_payer_idx on payment_attempts (organization_id, obligation_id, payer_person_id)
  where purpose in ('obligation', 'contribution') and status in ('created', 'action_required', 'processing', 'unknown');
-- Invariant 5: a checkout is charged successfully at most once.
create unique index payment_attempts_one_success_idx on payment_attempts (organization_id, checkout_id)
  where checkout_id is not null and status = 'succeeded';
create index payment_attempts_unresolved_idx on payment_attempts (organization_id, status, updated_at)
  where status in ('created', 'processing', 'unknown', 'action_required');
create trigger payment_attempts_touch before update on payment_attempts
  for each row execute function touch_updated_at();

create or replace function payment_attempts_guard() returns trigger
language plpgsql as $$
begin
  if new.amount_minor <> old.amount_minor or new.currency <> old.currency
     or new.payer_person_id <> old.payer_person_id or new.purpose <> old.purpose
     or new.provider <> old.provider then
    raise exception 'payment attempt % amount, payer and provider are immutable', old.id
      using errcode = 'check_violation', constraint = 'payment_attempts_basis_immutable';
  end if;
  if old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference then
    raise exception 'payment attempt % provider reference is immutable once known', old.id
      using errcode = 'check_violation', constraint = 'payment_attempts_reference_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'created' and new.status in ('action_required', 'processing', 'succeeded', 'failed', 'canceled', 'unknown'))
     or (old.status = 'action_required' and new.status in ('processing', 'succeeded', 'failed', 'canceled', 'unknown'))
     or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'canceled', 'unknown'))
     or (old.status = 'unknown' and new.status in ('succeeded', 'failed', 'canceled')) then
    return new;
  end if;
  raise exception 'payment attempt % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'payment_attempts_machine';
end
$$;
create trigger payment_attempts_guard before update on payment_attempts
  for each row execute function payment_attempts_guard();

-- ---------------------------------------------------------------------------------------------
-- Cash and externally recorded tenders (SPK-PAY-012): permission, evidence and reconciliation.
-- A tender pays an existing obligation or a checkout; it never creates participation by itself.
-- ---------------------------------------------------------------------------------------------
create table cash_tenders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  tender_kind text not null check (tender_kind in ('cash', 'check', 'external_terminal')),
  payer_person_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  obligation_id uuid,
  checkout_id uuid,
  evidence jsonb not null,
  recorded_by jsonb not null,
  recorded_by_person_id uuid not null,
  recorded_at timestamptz not null,
  status text not null default 'recorded' check (status in ('recorded', 'reconciled')),
  reconciliation_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  foreign key (organization_id, checkout_id) references checkouts (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  constraint cash_tenders_target check (obligation_id is not null or checkout_id is not null),
  constraint cash_tenders_evidence check (jsonb_typeof(evidence) = 'object' and evidence ? 'reference'),
  constraint cash_tenders_reconciled_fact check ((status = 'reconciled') = (reconciliation_id is not null))
);
create unique index cash_tenders_checkout_idx on cash_tenders (organization_id, checkout_id) where checkout_id is not null;
create index cash_tenders_unreconciled_idx on cash_tenders (organization_id, facility_id, recorded_at) where status = 'recorded';
create trigger cash_tenders_touch before update on cash_tenders
  for each row execute function touch_updated_at();

create or replace function cash_tenders_guard() returns trigger
language plpgsql as $$
begin
  if new.amount_minor <> old.amount_minor or new.currency <> old.currency
     or new.evidence <> old.evidence or new.payer_person_id <> old.payer_person_id
     or new.recorded_by_person_id <> old.recorded_by_person_id or new.recorded_at <> old.recorded_at then
    raise exception 'cash tender % facts are immutable', old.id
      using errcode = 'check_violation', constraint = 'cash_tenders_immutable';
  end if;
  if old.status = 'reconciled' and new.status <> 'reconciled' then
    raise exception 'cash tender % is already reconciled', old.id
      using errcode = 'check_violation', constraint = 'cash_tenders_machine';
  end if;
  return new;
end
$$;
create trigger cash_tenders_guard before update on cash_tenders
  for each row execute function cash_tenders_guard();

alter table checkouts
  add foreign key (organization_id, payment_attempt_id) references payment_attempts (organization_id, id),
  add foreign key (organization_id, cash_tender_id) references cash_tenders (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Operational subledger (SPK-PAY-010): append-only journals with balanced double entries.
-- Balances are computed sums; nobody overwrites a balance. Corrections are reversing entries.
-- ---------------------------------------------------------------------------------------------
create table journals (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  source_type text not null,
  source_id uuid not null,
  purpose text not null,
  description text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reversal_of_journal_id uuid,
  posted_at timestamptz not null,
  posted_by jsonb not null,
  correlation_id text,
  operation_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  -- Invariant 5: one posting per financial fact and purpose (replay posts nothing twice).
  unique (organization_id, source_type, source_id, purpose),
  foreign key (organization_id, reversal_of_journal_id) references journals (organization_id, id)
);
create unique index journals_one_reversal_idx on journals (organization_id, reversal_of_journal_id)
  where reversal_of_journal_id is not null;
create index journals_posted_idx on journals (organization_id, posted_at);
create trigger journals_append_only before update or delete on journals
  for each row execute function forbid_mutation();

create table journal_entries (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  journal_id uuid not null,
  line_number integer not null check (line_number >= 1),
  account_code text not null check (account_code in (
    'customer_receivable', 'cash_processor', 'deferred_revenue', 'credits_payable',
    'processor_fees', 'refunds', 'cash_on_hand', 'overpayment_liability'
  )),
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  person_id uuid,
  order_id uuid,
  obligation_id uuid,
  reversal_of_entry_id uuid,
  memo text,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (journal_id, line_number),
  foreign key (organization_id, journal_id) references journals (organization_id, id),
  foreign key (organization_id, reversal_of_entry_id) references journal_entries (organization_id, id),
  constraint journal_entries_one_side check ((debit_minor > 0) <> (credit_minor > 0))
);
create unique index journal_entries_one_reversal_idx on journal_entries (organization_id, reversal_of_entry_id)
  where reversal_of_entry_id is not null;
create index journal_entries_account_idx on journal_entries (organization_id, account_code, currency);
create trigger journal_entries_append_only before update or delete on journal_entries
  for each row execute function forbid_mutation();

-- A journal balances (debits = credits, one currency, at least two lines) when its transaction
-- commits; checked once per journal row and once per entry row (deferred to commit).
create or replace function journal_balanced() returns trigger
language plpgsql as $$
declare
  jid uuid;
  jcurrency text;
  lines integer;
  debits bigint;
  credits bigint;
  foreign_currency integer;
begin
  if tg_table_name = 'journals' then
    jid := new.id;
  else
    jid := new.journal_id;
  end if;
  select currency into jcurrency from journals where id = jid;
  select count(*), coalesce(sum(debit_minor), 0)::bigint, coalesce(sum(credit_minor), 0)::bigint,
         count(*) filter (where currency <> jcurrency)
    into lines, debits, credits, foreign_currency
    from journal_entries where journal_id = jid;
  if lines < 2 or debits <> credits or foreign_currency > 0 then
    raise exception 'journal % does not balance (lines %, debits %, credits %)', jid, lines, debits, credits
      using errcode = 'check_violation', constraint = 'journals_balanced';
  end if;
  return null;
end
$$;
create constraint trigger journals_balanced after insert on journals
  deferrable initially deferred for each row execute function journal_balanced();
create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred for each row execute function journal_balanced();

-- ---------------------------------------------------------------------------------------------
-- Receipts (append-only): money actually received, one per payment fact (invariant 5). The
-- amount splits into what was allocated to obligations and the visible excess (SPK-PAY-005).
-- ---------------------------------------------------------------------------------------------
create table receipts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  source_kind text not null check (source_kind in ('payment_attempt', 'cash_tender')),
  payment_attempt_id uuid,
  cash_tender_id uuid,
  payer_person_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  allocated_minor bigint not null check (allocated_minor >= 0),
  excess_minor bigint not null check (excess_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  processor_fee_minor bigint not null default 0 check (processor_fee_minor >= 0),
  order_id uuid,
  obligation_id uuid,
  journal_id uuid not null,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (payment_attempt_id),
  unique (cash_tender_id),
  foreign key (organization_id, payment_attempt_id) references payment_attempts (organization_id, id),
  foreign key (organization_id, cash_tender_id) references cash_tenders (organization_id, id),
  foreign key (organization_id, payer_person_id) references persons (organization_id, id),
  foreign key (organization_id, order_id) references orders (organization_id, id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  foreign key (organization_id, journal_id) references journals (organization_id, id),
  constraint receipts_amount_split check (amount_minor = allocated_minor + excess_minor),
  constraint receipts_payment_source check ((source_kind = 'payment_attempt') = (payment_attempt_id is not null)),
  constraint receipts_cash_source check ((source_kind = 'cash_tender') = (cash_tender_id is not null))
);
create index receipts_received_idx on receipts (organization_id, received_at);
create trigger receipts_append_only before update or delete on receipts
  for each row execute function forbid_mutation();

alter table contribution_requests
  add foreign key (organization_id, receipt_id) references receipts (organization_id, id);

-- ---------------------------------------------------------------------------------------------
-- Refunds (SPK-PAY-008, invariant 6): reserve the refundable amount before execution; concurrent
-- requests cannot reserve the same funds; an unknown result keeps its reservation.
-- ---------------------------------------------------------------------------------------------
create table payment_refundables (
  payment_attempt_id uuid primary key,
  organization_id uuid not null references organizations(id),
  receipt_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  captured_minor bigint not null check (captured_minor > 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  reserved_minor bigint not null default 0 check (reserved_minor >= 0),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, payment_attempt_id) references payment_attempts (organization_id, id),
  foreign key (organization_id, receipt_id) references receipts (organization_id, id),
  constraint payment_refundables_within_captured check (refunded_minor + reserved_minor <= captured_minor)
);
create trigger payment_refundables_touch before update on payment_refundables
  for each row execute function touch_updated_at();

create or replace function payment_refundables_guard() returns trigger
language plpgsql as $$
begin
  if new.captured_minor <> old.captured_minor or new.currency <> old.currency
     or new.receipt_id <> old.receipt_id or new.organization_id <> old.organization_id then
    raise exception 'refundable funds of % are fixed at capture', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_immutable';
  end if;
  if new.refunded_minor < old.refunded_minor then
    raise exception 'refunded amount of % only accumulates', old.payment_attempt_id
      using errcode = 'check_violation', constraint = 'payment_refundables_accumulate';
  end if;
  return new;
end
$$;
create trigger payment_refundables_guard before update on payment_refundables
  for each row execute function payment_refundables_guard();

create table refund_attempts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  payment_attempt_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  purpose text not null default 'customer_refund' check (purpose in ('customer_refund', 'compensation')),
  checkout_id uuid,
  status text not null default 'requested' check (status in ('requested', 'processing', 'succeeded', 'failed', 'canceled', 'unknown')),
  reservation_status text not null default 'reserved' check (reservation_status in ('reserved', 'settled', 'released')),
  reason text not null,
  provider text not null,
  provider_reference text,
  failure_reason text,
  evidence_source text check (evidence_source in ('sync_response', 'webhook', 'reconciliation')),
  evidence_inbox_event_id uuid references inbox_events(id),
  evidence_sequence integer,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  operation_id uuid references operations(id),
  submitted_at timestamptz,
  unknown_since timestamptz,
  resolved_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (provider, provider_reference),
  foreign key (organization_id, payment_attempt_id) references payment_attempts (organization_id, id),
  foreign key (organization_id, checkout_id) references checkouts (organization_id, id),
  constraint refund_attempts_reservation_consistent check (
    (status in ('requested', 'processing', 'unknown') and reservation_status = 'reserved')
    or (status = 'succeeded' and reservation_status = 'settled')
    or (status in ('failed', 'canceled') and reservation_status = 'released')
  ),
  constraint refund_attempts_unknown_fact check (status <> 'unknown' or unknown_since is not null),
  constraint refund_attempts_compensation_target check (purpose <> 'compensation' or checkout_id is not null)
);
create index refund_attempts_payment_idx on refund_attempts (organization_id, payment_attempt_id);
create index refund_attempts_unresolved_idx on refund_attempts (organization_id, status, updated_at)
  where status in ('requested', 'processing', 'unknown');
create unique index refund_attempts_live_compensation_idx on refund_attempts (organization_id, checkout_id)
  where purpose = 'compensation' and status in ('requested', 'processing', 'unknown', 'succeeded');
create trigger refund_attempts_touch before update on refund_attempts
  for each row execute function touch_updated_at();

create or replace function refund_attempts_guard() returns trigger
language plpgsql as $$
begin
  if new.amount_minor <> old.amount_minor or new.currency <> old.currency
     or new.payment_attempt_id <> old.payment_attempt_id then
    raise exception 'refund % amount is immutable', old.id
      using errcode = 'check_violation', constraint = 'refund_attempts_basis_immutable';
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
create trigger refund_attempts_guard before update on refund_attempts
  for each row execute function refund_attempts_guard();

-- ---------------------------------------------------------------------------------------------
-- Credits (SPK-PAY-009, invariant 7): owner, currency, permitted uses, expiry, remaining balance,
-- source and redemption history. Remaining moves by conditional UPDATE; history is append-only
-- and the remaining balance always equals original - redeemed + reversed (deferred check).
-- ---------------------------------------------------------------------------------------------
create table credits (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  owner_person_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  original_minor bigint not null check (original_minor > 0),
  remaining_minor bigint not null check (remaining_minor >= 0),
  permitted_uses jsonb not null,
  source_kind text not null check (source_kind in ('overpayment', 'compensation', 'goodwill', 'adjustment')),
  source_id uuid,
  status text not null check (status in ('pending_approval', 'active', 'exhausted', 'expired', 'revoked')),
  expires_at timestamptz,
  reason text not null,
  issued_by jsonb not null,
  issued_by_person_id uuid,
  approved_at timestamptz,
  approved_by jsonb,
  revoked_at timestamptz,
  revoked_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, owner_person_id) references persons (organization_id, id),
  constraint credits_remaining_within_original check (remaining_minor <= original_minor),
  constraint credits_exhausted_fact check (status <> 'exhausted' or remaining_minor = 0),
  constraint credits_active_remaining check (status <> 'active' or remaining_minor > 0),
  constraint credits_approved_fact check (status = 'pending_approval' or source_kind <> 'overpayment' or approved_at is not null or status = 'revoked'),
  constraint credits_revoked_fact check ((status = 'revoked') = (revoked_at is not null)),
  constraint credits_pending_untouched check (status <> 'pending_approval' or remaining_minor = original_minor),
  constraint credits_permitted_uses check (jsonb_typeof(permitted_uses) = 'array' and jsonb_array_length(permitted_uses) > 0)
);
-- Invariant 5: one credit per source fact (an overpayment or compensation credits once).
create unique index credits_source_idx on credits (organization_id, source_kind, source_id) where source_id is not null;
create index credits_owner_idx on credits (organization_id, owner_person_id, status);
create trigger credits_touch before update on credits
  for each row execute function touch_updated_at();

create or replace function credits_guard() returns trigger
language plpgsql as $$
begin
  if new.original_minor <> old.original_minor or new.currency <> old.currency
     or new.owner_person_id <> old.owner_person_id or new.source_kind <> old.source_kind
     or new.source_id is distinct from old.source_id then
    raise exception 'credit % owner, amount and source are immutable', old.id
      using errcode = 'check_violation', constraint = 'credits_basis_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'pending_approval' and new.status in ('active', 'revoked'))
     or (old.status = 'active' and new.status in ('exhausted', 'expired', 'revoked'))
     or (old.status = 'exhausted' and new.status in ('active', 'revoked')) then
    return new;
  end if;
  raise exception 'credit % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'credits_machine';
end
$$;
create trigger credits_guard before update on credits
  for each row execute function credits_guard();

create table credit_redemptions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  credit_id uuid not null,
  kind text not null check (kind in ('redeem', 'reversal')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reference_type text not null,
  reference_id uuid not null,
  reverses_redemption_id uuid,
  actor jsonb not null,
  redeemed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  -- One redemption (and one reversal) per credit and consuming reference: a replay consumes nothing twice.
  unique (organization_id, credit_id, kind, reference_type, reference_id),
  foreign key (organization_id, credit_id) references credits (organization_id, id),
  foreign key (organization_id, reverses_redemption_id) references credit_redemptions (organization_id, id),
  constraint credit_redemptions_reversal_target check ((kind = 'reversal') = (reverses_redemption_id is not null))
);
create unique index credit_redemptions_one_reversal_idx on credit_redemptions (organization_id, reverses_redemption_id)
  where reverses_redemption_id is not null;
create trigger credit_redemptions_append_only before update or delete on credit_redemptions
  for each row execute function forbid_mutation();

create or replace function credit_balance_consistent() returns trigger
language plpgsql as $$
declare
  cid uuid;
  original bigint;
  remaining bigint;
  redeemed bigint;
  reversed bigint;
begin
  if tg_table_name = 'credits' then
    cid := new.id;
  else
    cid := new.credit_id;
  end if;
  select original_minor, remaining_minor into original, remaining from credits where id = cid;
  select coalesce(sum(amount_minor) filter (where kind = 'redeem'), 0)::bigint,
         coalesce(sum(amount_minor) filter (where kind = 'reversal'), 0)::bigint
    into redeemed, reversed
    from credit_redemptions where credit_id = cid;
  if remaining <> original - redeemed + reversed then
    raise exception 'credit % remaining % does not match its history (% - % + %)', cid, remaining, original, redeemed, reversed
      using errcode = 'check_violation', constraint = 'credits_history_consistent';
  end if;
  return null;
end
$$;
create constraint trigger credits_history_consistent after insert or update of remaining_minor on credits
  deferrable initially deferred for each row execute function credit_balance_consistent();
create constraint trigger credit_redemptions_history_consistent after insert on credit_redemptions
  deferrable initially deferred for each row execute function credit_balance_consistent();

-- ---------------------------------------------------------------------------------------------
-- Payment allocations (append-only): receipts and credit redemptions → obligations. An
-- obligation's allocated amount always equals the sum of its allocations (deferred check), so
-- total, received, allocated and remaining are consistent (SPK-PAY-004).
-- ---------------------------------------------------------------------------------------------
create table payment_allocations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  obligation_id uuid not null,
  source_kind text not null check (source_kind in ('receipt', 'credit_redemption')),
  receipt_id uuid,
  credit_redemption_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  allocated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (receipt_id, obligation_id),
  unique (credit_redemption_id, obligation_id),
  foreign key (organization_id, obligation_id) references obligations (organization_id, id),
  foreign key (organization_id, receipt_id) references receipts (organization_id, id),
  foreign key (organization_id, credit_redemption_id) references credit_redemptions (organization_id, id),
  constraint payment_allocations_receipt_source check ((source_kind = 'receipt') = (receipt_id is not null)),
  constraint payment_allocations_credit_source check ((source_kind = 'credit_redemption') = (credit_redemption_id is not null))
);
create index payment_allocations_obligation_idx on payment_allocations (organization_id, obligation_id);
create trigger payment_allocations_append_only before update or delete on payment_allocations
  for each row execute function forbid_mutation();

create or replace function obligation_allocations_consistent() returns trigger
language plpgsql as $$
declare
  oid uuid;
  allocated bigint;
  summed bigint;
  ocurrency text;
  foreign_currency integer;
begin
  if tg_table_name = 'obligations' then
    oid := new.id;
  else
    oid := new.obligation_id;
  end if;
  select allocated_minor, currency into allocated, ocurrency from obligations where id = oid;
  select coalesce(sum(amount_minor), 0)::bigint, count(*) filter (where currency <> ocurrency)
    into summed, foreign_currency
    from payment_allocations where obligation_id = oid;
  if allocated <> summed or foreign_currency > 0 then
    raise exception 'obligation % allocated % does not match its allocations %', oid, allocated, summed
      using errcode = 'check_violation', constraint = 'obligations_allocations_consistent';
  end if;
  return null;
end
$$;
create constraint trigger obligations_allocations_consistent after insert or update of allocated_minor on obligations
  deferrable initially deferred for each row execute function obligation_allocations_consistent();
create constraint trigger payment_allocations_consistent after insert on payment_allocations
  deferrable initially deferred for each row execute function obligation_allocations_consistent();

-- A receipt's allocated part equals the sum of its allocations (deferred check).
create or replace function receipt_allocations_consistent() returns trigger
language plpgsql as $$
declare
  summed bigint;
begin
  select coalesce(sum(amount_minor), 0)::bigint into summed
    from payment_allocations where receipt_id = new.id;
  if summed <> new.allocated_minor then
    raise exception 'receipt % allocated % does not match its allocations %', new.id, new.allocated_minor, summed
      using errcode = 'check_violation', constraint = 'receipts_allocations_consistent';
  end if;
  return null;
end
$$;
create constraint trigger receipts_allocations_consistent after insert on receipts
  deferrable initially deferred for each row execute function receipt_allocations_consistent();

-- ---------------------------------------------------------------------------------------------
-- Settlement reconciliations (SPK-PAY-011): a comparison of what the ledger expects with what a
-- processor settlement or a cash drawer reports. Append-only; a correction is a new record.
-- ---------------------------------------------------------------------------------------------
create table settlement_reconciliations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  kind text not null check (kind in ('processor_settlement', 'cash_drawer')),
  provider text,
  facility_id uuid,
  period_start timestamptz not null,
  period_end timestamptz not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  expected_minor bigint not null,
  reported_minor bigint not null,
  difference_minor bigint not null,
  breakdown jsonb not null,
  status text not null check (status in ('balanced', 'discrepancy')),
  external_reference text,
  notes text,
  performed_by jsonb not null,
  performed_by_person_id uuid,
  performed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  constraint settlement_reconciliations_period check (period_end > period_start),
  constraint settlement_reconciliations_difference check (difference_minor = reported_minor - expected_minor),
  constraint settlement_reconciliations_status check ((status = 'balanced') = (difference_minor = 0)),
  constraint settlement_reconciliations_kind_scope check (
    (kind = 'processor_settlement' and provider is not null)
    or (kind = 'cash_drawer' and facility_id is not null)
  )
);
create unique index settlement_reconciliations_reference_idx on settlement_reconciliations
  (organization_id, kind, coalesce(provider, ''), external_reference) where external_reference is not null;
create trigger settlement_reconciliations_append_only before update or delete on settlement_reconciliations
  for each row execute function forbid_mutation();

alter table cash_tenders
  add foreign key (organization_id, reconciliation_id) references settlement_reconciliations (organization_id, id);
