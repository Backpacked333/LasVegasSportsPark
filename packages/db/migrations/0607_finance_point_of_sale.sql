-- 0607_finance_point_of_sale.sql
-- FIN-06: point of sale (§3.16 POS row "products, prices, approved taxes, tenders, receipts,
-- returns, permissions, reconciliation"; SPK-PAY-002, SPK-PAY-008, SPK-PAY-010, SPK-PAY-012;
-- §4.7 invariants 5 and 6). Behind the per-organization capability `point_of_sale` (DEC-016,
-- DEC-079): the tables exist for every organization, only the commands are switched.
--
-- Integrity enforced here:
--   * a sale, its lines, tenders and returns share one currency (composite foreign keys on
--     (organization_id, sale_id, currency));
--   * a sale's totals are recomputed from its lines under the sale lock (total = subtotal +
--     charges), lines are added only while the sale is open and never change afterwards;
--   * tenders never exceed the sale total; a card tender is the only kind with a payment attempt,
--     an external tender carries evidence, cash and external tenders are settled when recorded;
--   * a return never exceeds the settled tenders of its kind minus earlier returns (invariant 6)
--     nor the quantity sold of a line, and is append-only;
--   * one open session per register, one live card attempt per sale, sale numbers unique.
-- POS does not use cash_tenders (whose target is an obligation or a checkout, amount positive only)
-- nor receipts (money for an obligation): the sale, its tenders and its journals are the record.

-- ---------------------------------------------------------------------------------------------
-- Existing finance schema: the POS purpose of a payment attempt, POS accounts, card refundables
-- ---------------------------------------------------------------------------------------------
alter table payment_attempts drop constraint payment_attempts_purpose_check;
alter table payment_attempts add constraint payment_attempts_purpose_check
  check (purpose in ('checkout', 'obligation', 'contribution', 'installment', 'pos_sale'));
alter table payment_attempts add column pos_sale_id uuid;
alter table payment_attempts drop constraint payment_attempts_purpose_target;
alter table payment_attempts add constraint payment_attempts_purpose_target check (
  (purpose = 'checkout' and checkout_id is not null and order_id is not null)
  or (purpose = 'obligation' and obligation_id is not null)
  or (purpose = 'contribution' and obligation_id is not null and contribution_request_id is not null)
  or (purpose = 'installment' and obligation_id is not null and installment_id is not null)
  or (purpose = 'pos_sale' and pos_sale_id is not null and checkout_id is null and obligation_id is null)
);
alter table payment_attempts add constraint payment_attempts_pos_sale_purpose
  check (pos_sale_id is null or purpose = 'pos_sale');
-- SPK-PAY-007: one live (or unknown) card charge per sale.
create unique index payment_attempts_live_pos_sale_idx on payment_attempts (organization_id, pos_sale_id)
  where pos_sale_id is not null and status in ('created', 'action_required', 'processing', 'unknown');

-- Revenue, taxes and fees of point-of-sale sales (product kind and charge code in the memo).
alter table journal_entries drop constraint journal_entries_account_code_check;
alter table journal_entries add constraint journal_entries_account_code_check check (account_code in (
  'customer_receivable', 'cash_processor', 'deferred_revenue', 'credits_payable',
  'processor_fees', 'refunds', 'cash_on_hand', 'overpayment_liability',
  'pos_revenue', 'taxes_payable', 'fees_payable'
));

-- ---------------------------------------------------------------------------------------------
-- Products and the approved tax and fee policies their sales apply (DEC-057)
-- ---------------------------------------------------------------------------------------------
create table pos_products (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  -- Null: sold at every facility of the organization.
  facility_id uuid,
  sku text not null check (sku ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- SPK-PAY-012: registrations, memberships, packages and bookings are never POS products.
  kind text not null check (kind in ('merchandise', 'concession', 'service')),
  price_minor bigint not null check (price_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  retire_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, sku),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  constraint pos_products_retired_fact check (
    (status = 'retired') = (retired_at is not null) and (retired_at is null) = (retire_reason is null)
  )
);
create trigger pos_products_touch before update on pos_products
  for each row execute function touch_updated_at();

-- PosProductMachine: active { retire: retired }; a retired product never comes back.
create or replace function pos_products_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id or new.sku <> old.sku then
    raise exception 'pos product % keeps its organization and sku', old.id
      using errcode = 'check_violation', constraint = 'pos_products_identity_immutable';
  end if;
  if old.status = 'retired' then
    raise exception 'pos product % is retired', old.id
      using errcode = 'check_violation', constraint = 'pos_products_machine';
  end if;
  return new;
end
$$;
create trigger pos_products_guard before update on pos_products
  for each row execute function pos_products_guard();

create table pos_product_charges (
  organization_id uuid not null references organizations(id),
  product_id uuid not null,
  -- The key of a catalog `tax_fee` policy family; the approved version effective at sale time
  -- applies (POLICY_PORT.currentPolicyVersion), and a key without one refuses the sale.
  tax_fee_policy_key text not null check (tax_fee_policy_key ~ '^[a-z0-9][a-z0-9_-]{0,99}$'),
  position integer not null check (position >= 1),
  created_at timestamptz not null default now(),
  primary key (organization_id, product_id, tax_fee_policy_key),
  unique (organization_id, product_id, position),
  foreign key (organization_id, product_id) references pos_products (organization_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Registers and register sessions (cash drawers)
-- ---------------------------------------------------------------------------------------------
create table pos_registers (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  code text not null check (code ~ '^[A-Z0-9]{2,8}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_at timestamptz,
  retire_reason text,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, facility_id),
  unique (organization_id, code),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  constraint pos_registers_retired_fact check (
    (status = 'retired') = (retired_at is not null) and (retired_at is null) = (retire_reason is null)
  )
);
create trigger pos_registers_touch before update on pos_registers
  for each row execute function touch_updated_at();

-- PosRegisterMachine: active { retire: retired }.
create or replace function pos_registers_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id or new.facility_id <> old.facility_id
     or new.code <> old.code then
    raise exception 'pos register % keeps its facility and code', old.id
      using errcode = 'check_violation', constraint = 'pos_registers_identity_immutable';
  end if;
  if old.status = 'retired' then
    raise exception 'pos register % is retired', old.id
      using errcode = 'check_violation', constraint = 'pos_registers_machine';
  end if;
  return new;
end
$$;
create trigger pos_registers_guard before update on pos_registers
  for each row execute function pos_registers_guard();

create table pos_register_sessions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  register_id uuid not null,
  facility_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- The facility-local date the session opened on, YYYYMMDD (SPK-SCHED-008); sale numbers carry it.
  business_date text not null check (business_date ~ '^[0-9]{8}$'),
  opening_float_minor bigint not null check (opening_float_minor >= 0),
  opened_by jsonb not null,
  opened_by_person_id uuid not null,
  opened_at timestamptz not null,
  next_sale_number integer not null default 1 check (next_sale_number >= 1),
  status text not null default 'open' check (status in ('open', 'closed')),
  counted_cash_minor bigint check (counted_cash_minor is null or counted_cash_minor >= 0),
  expected_cash_minor bigint,
  variance_minor bigint,
  closed_by jsonb,
  closed_by_person_id uuid,
  closed_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, currency, facility_id),
  foreign key (organization_id, register_id, facility_id)
    references pos_registers (organization_id, id, facility_id),
  foreign key (organization_id, opened_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, closed_by_person_id) references persons (organization_id, id),
  constraint pos_register_sessions_closed_facts check (
    (status = 'closed') = (closed_at is not null)
    and (closed_at is null) = (counted_cash_minor is null)
    and (closed_at is null) = (expected_cash_minor is null)
    and (closed_at is null) = (variance_minor is null)
    and (closed_at is null) = (closed_by_person_id is null)
  ),
  constraint pos_register_sessions_variance check (
    variance_minor is null or variance_minor = counted_cash_minor - expected_cash_minor
  )
);
create unique index pos_register_sessions_one_open_idx on pos_register_sessions (organization_id, register_id)
  where status = 'open';
create index pos_register_sessions_register_idx
  on pos_register_sessions (organization_id, register_id, business_date);
create trigger pos_register_sessions_touch before update on pos_register_sessions
  for each row execute function touch_updated_at();

-- PosRegisterSessionMachine: open { close: closed }; opening facts never change and the sale
-- number only advances.
create or replace function pos_register_sessions_guard() returns trigger
language plpgsql as $$
begin
  if new.register_id <> old.register_id or new.facility_id <> old.facility_id
     or new.currency <> old.currency or new.business_date <> old.business_date
     or new.opening_float_minor <> old.opening_float_minor or new.opened_at <> old.opened_at
     or new.opened_by_person_id <> old.opened_by_person_id then
    raise exception 'register session % keeps its opening facts', old.id
      using errcode = 'check_violation', constraint = 'pos_register_sessions_opening_immutable';
  end if;
  if new.next_sale_number < old.next_sale_number then
    raise exception 'register session % sale numbers only advance', old.id
      using errcode = 'check_violation', constraint = 'pos_register_sessions_numbering';
  end if;
  if old.status = 'closed' then
    raise exception 'register session % is closed', old.id
      using errcode = 'check_violation', constraint = 'pos_register_sessions_machine';
  end if;
  return new;
end
$$;
create trigger pos_register_sessions_guard before update on pos_register_sessions
  for each row execute function pos_register_sessions_guard();

-- ---------------------------------------------------------------------------------------------
-- Sales, lines, tenders and returns
-- ---------------------------------------------------------------------------------------------
create table pos_sales (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  register_session_id uuid not null,
  facility_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- '<register code>-<YYYYMMDD>-<n>' numbered under the session lock.
  sale_number text not null check (sale_number ~ '^[A-Z0-9]{2,8}-[0-9]{8}-[1-9][0-9]*$'),
  customer_person_id uuid,
  status text not null default 'open'
    check (status in ('open', 'paid', 'voided', 'partially_returned', 'returned')),
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  charges_minor bigint not null default 0 check (charges_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_at timestamptz,
  void_reason text,
  voided_at timestamptz,
  voided_by jsonb,
  created_by jsonb not null,
  created_by_person_id uuid not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, currency),
  unique (organization_id, sale_number),
  foreign key (organization_id, register_session_id, currency, facility_id)
    references pos_register_sessions (organization_id, id, currency, facility_id),
  foreign key (organization_id, customer_person_id) references persons (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id),
  constraint pos_sales_total check (total_minor = subtotal_minor + charges_minor),
  constraint pos_sales_void_reason check ((status = 'voided') = (void_reason is not null)),
  constraint pos_sales_voided_fact check ((status = 'voided') = (voided_at is not null)),
  constraint pos_sales_paid_fact check (
    (status in ('paid', 'partially_returned', 'returned')) = (paid_at is not null)
  )
);
create index pos_sales_session_idx on pos_sales (organization_id, register_session_id, status);
create index pos_sales_customer_idx on pos_sales (organization_id, customer_person_id, created_at desc, id desc)
  where customer_person_id is not null;
create trigger pos_sales_touch before update on pos_sales
  for each row execute function touch_updated_at();

-- PosSaleMachine (finance.state-machines.ts): open { pay: paid, void: voided }; paid and
-- partially_returned { return_part: partially_returned, return_all: returned }. Totals change only
-- while the sale is open (the line trigger recomputes them); identity facts never change.
create or replace function pos_sales_guard() returns trigger
language plpgsql as $$
begin
  if new.register_session_id <> old.register_session_id or new.currency <> old.currency
     or new.sale_number <> old.sale_number or new.facility_id <> old.facility_id
     or new.created_by_person_id <> old.created_by_person_id then
    raise exception 'pos sale % keeps its session, number and currency', old.id
      using errcode = 'check_violation', constraint = 'pos_sales_identity_immutable';
  end if;
  if old.status <> 'open' and (new.subtotal_minor <> old.subtotal_minor
     or new.charges_minor <> old.charges_minor or new.total_minor <> old.total_minor
     or new.customer_person_id is distinct from old.customer_person_id) then
    raise exception 'pos sale % is % and its amounts are final', old.id, old.status
      using errcode = 'check_violation', constraint = 'pos_sales_amounts_final';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'open' and new.status in ('paid', 'voided'))
     or (old.status in ('paid', 'partially_returned') and new.status in ('partially_returned', 'returned')) then
    return new;
  end if;
  raise exception 'pos sale % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'pos_sales_machine';
end
$$;
create trigger pos_sales_guard before update on pos_sales
  for each row execute function pos_sales_guard();

create table pos_sale_lines (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  sale_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  line_number integer not null check (line_number >= 1),
  product_id uuid not null,
  -- Snapshot of the product as sold (a later PATCH changes later sales only).
  sku text not null,
  name text not null,
  kind text not null check (kind in ('merchandise', 'concession', 'service')),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity >= 1),
  base_minor bigint not null check (base_minor >= 0),
  -- [{ policyVersionId, code, label, kind tax|fee, amountMinor }] from approved tax_fee versions.
  charges jsonb not null default '[]'::jsonb check (jsonb_typeof(charges) = 'array'),
  charges_minor bigint not null default 0 check (charges_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, sale_id, line_number),
  foreign key (organization_id, sale_id, currency) references pos_sales (organization_id, id, currency),
  foreign key (organization_id, product_id) references pos_products (organization_id, id),
  constraint pos_sale_lines_base check (base_minor = unit_price_minor * quantity),
  constraint pos_sale_lines_total check (line_total_minor = base_minor + charges_minor)
);
create trigger pos_sale_lines_append_only before update or delete on pos_sale_lines
  for each row execute function forbid_mutation();

-- A line is added only while its sale is open; the sale's totals follow from its lines, computed
-- under the sale lock so concurrent lines never lose an amount.
create or replace function pos_sale_lines_apply() returns trigger
language plpgsql as $$
declare
  sale_status text;
  charge_sum bigint;
begin
  select status into sale_status from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if sale_status is distinct from 'open' then
    raise exception 'pos sale % is % and takes no new line', new.sale_id, coalesce(sale_status, 'missing')
      using errcode = 'check_violation', constraint = 'pos_sale_lines_open_sale';
  end if;
  select coalesce(sum((c->>'amountMinor')::bigint), 0)::bigint into charge_sum
    from jsonb_array_elements(new.charges) c;
  if charge_sum <> new.charges_minor then
    raise exception 'pos sale line % charges % do not add up to %', new.id, charge_sum, new.charges_minor
      using errcode = 'check_violation', constraint = 'pos_sale_lines_charges';
  end if;
  update pos_sales s
     set subtotal_minor = t.subtotal, charges_minor = t.charges, total_minor = t.subtotal + t.charges,
         revision = s.revision + 1
    from (select coalesce(sum(base_minor), 0)::bigint as subtotal,
                 coalesce(sum(charges_minor), 0)::bigint as charges
            from pos_sale_lines
           where organization_id = new.organization_id and sale_id = new.sale_id) t
   where s.organization_id = new.organization_id and s.id = new.sale_id;
  return null;
end
$$;
create trigger pos_sale_lines_apply after insert on pos_sale_lines
  for each row execute function pos_sale_lines_apply();

create table pos_tenders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  sale_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  kind text not null check (kind in ('cash', 'card', 'external')),
  amount_minor bigint not null check (amount_minor > 0),
  payment_attempt_id uuid,
  evidence jsonb,
  status text not null check (status in ('pending', 'settled', 'failed')),
  failure_reason text,
  recorded_by jsonb not null,
  recorded_by_person_id uuid not null,
  recorded_at timestamptz not null,
  settled_at timestamptz,
  failed_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (payment_attempt_id),
  foreign key (organization_id, sale_id, currency) references pos_sales (organization_id, id, currency),
  foreign key (organization_id, payment_attempt_id) references payment_attempts (organization_id, id),
  foreign key (organization_id, recorded_by_person_id) references persons (organization_id, id),
  constraint pos_tenders_card_attempt check ((kind = 'card') = (payment_attempt_id is not null)),
  constraint pos_tenders_external_evidence check (
    kind <> 'external' or (evidence is not null and evidence ? 'reference')
  ),
  constraint pos_tenders_settled_at_once check (kind = 'card' or status = 'settled'),
  constraint pos_tenders_settled_fact check ((status = 'settled') = (settled_at is not null)),
  constraint pos_tenders_failed_fact check ((status = 'failed') = (failed_at is not null))
);
create index pos_tenders_sale_idx on pos_tenders (organization_id, sale_id, kind, status);
create trigger pos_tenders_touch before update on pos_tenders
  for each row execute function touch_updated_at();

-- A tender is taken only while its sale is open, and live tenders never exceed the sale total.
create or replace function pos_tenders_insert_guard() returns trigger
language plpgsql as $$
declare
  sale_status text;
  sale_total bigint;
  tendered bigint;
begin
  select status, total_minor into sale_status, sale_total from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if sale_status is distinct from 'open' then
    raise exception 'pos sale % is % and takes no tender', new.sale_id, coalesce(sale_status, 'missing')
      using errcode = 'check_violation', constraint = 'pos_tenders_open_sale';
  end if;
  select coalesce(sum(amount_minor), 0)::bigint into tendered from pos_tenders
   where organization_id = new.organization_id and sale_id = new.sale_id
     and status in ('pending', 'settled');
  if tendered + new.amount_minor > sale_total then
    raise exception 'pos sale % would be tendered % beyond its total %', new.sale_id,
      tendered + new.amount_minor, sale_total
      using errcode = 'check_violation', constraint = 'pos_tenders_within_total';
  end if;
  return new;
end
$$;
create trigger pos_tenders_insert_guard before insert on pos_tenders
  for each row execute function pos_tenders_insert_guard();

-- Only pending -> settled | failed; the money basis never changes.
create or replace function pos_tenders_guard() returns trigger
language plpgsql as $$
begin
  if new.sale_id <> old.sale_id or new.kind <> old.kind or new.amount_minor <> old.amount_minor
     or new.currency <> old.currency or new.payment_attempt_id is distinct from old.payment_attempt_id
     or new.evidence is distinct from old.evidence then
    raise exception 'pos tender % keeps its amount, kind and evidence', old.id
      using errcode = 'check_violation', constraint = 'pos_tenders_basis_immutable';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'pending' and new.status in ('settled', 'failed') then
    return new;
  end if;
  raise exception 'pos tender % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'pos_tenders_machine';
end
$$;
create trigger pos_tenders_guard before update on pos_tenders
  for each row execute function pos_tenders_guard();

create table pos_returns (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  sale_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- [{ saleLineId, quantity, amountMinor, baseMinor, charges [{ code, kind, amountMinor }] }]
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 1),
  amount_minor bigint not null check (amount_minor > 0),
  tender_kind text not null check (tender_kind in ('cash', 'card', 'external')),
  refund_attempt_id uuid,
  -- The open register session whose drawer pays out a cash return.
  register_session_id uuid,
  evidence jsonb,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  approved_by jsonb not null,
  approved_by_person_id uuid not null,
  returned_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (refund_attempt_id),
  foreign key (organization_id, sale_id, currency) references pos_sales (organization_id, id, currency),
  foreign key (organization_id, refund_attempt_id) references refund_attempts (organization_id, id),
  foreign key (organization_id, register_session_id) references pos_register_sessions (organization_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  constraint pos_returns_card_refund check ((tender_kind = 'card') = (refund_attempt_id is not null)),
  constraint pos_returns_cash_drawer check ((tender_kind = 'cash') = (register_session_id is not null)),
  constraint pos_returns_external_evidence check (
    tender_kind <> 'external' or (evidence is not null and evidence ? 'reference')
  )
);
create index pos_returns_sale_idx on pos_returns (organization_id, sale_id, tender_kind);
create index pos_returns_session_idx on pos_returns (organization_id, register_session_id)
  where register_session_id is not null;
create trigger pos_returns_append_only before update or delete on pos_returns
  for each row execute function forbid_mutation();

-- §4.7 invariant 6: a return never exceeds what was paid by that tender kind minus earlier returns,
-- nor a line's quantity minus what was already returned of it; its amount is the sum of its lines.
create or replace function pos_returns_within_paid() returns trigger
language plpgsql as $$
declare
  sale_status text;
  settled bigint;
  returned bigint;
  line jsonb;
  sold integer;
  earlier integer;
  line_sum bigint := 0;
begin
  select status into sale_status from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if sale_status is null or sale_status not in ('paid', 'partially_returned') then
    raise exception 'pos sale % is % and cannot be returned', new.sale_id, coalesce(sale_status, 'missing')
      using errcode = 'check_violation', constraint = 'pos_returns_paid_sale';
  end if;
  select coalesce(sum(amount_minor), 0)::bigint into settled from pos_tenders
   where organization_id = new.organization_id and sale_id = new.sale_id
     and kind = new.tender_kind and status = 'settled';
  select coalesce(sum(amount_minor), 0)::bigint into returned from pos_returns
   where organization_id = new.organization_id and sale_id = new.sale_id
     and tender_kind = new.tender_kind;
  if returned + new.amount_minor > settled then
    raise exception 'pos sale % return of % by % exceeds % paid that way less % returned',
      new.sale_id, new.amount_minor, new.tender_kind, settled, returned
      using errcode = 'check_violation', constraint = 'pos_returns_within_paid';
  end if;
  for line in select value from jsonb_array_elements(new.lines) loop
    select quantity into sold from pos_sale_lines
     where organization_id = new.organization_id and sale_id = new.sale_id
       and id = (line->>'saleLineId')::uuid;
    if sold is null then
      raise exception 'pos return % names a line % that is not on sale %', new.id,
        line->>'saleLineId', new.sale_id
        using errcode = 'check_violation', constraint = 'pos_returns_line_of_sale';
    end if;
    select coalesce(sum((l->>'quantity')::integer), 0)::integer into earlier
      from pos_returns r, jsonb_array_elements(r.lines) l
     where r.organization_id = new.organization_id and r.sale_id = new.sale_id
       and l->>'saleLineId' = line->>'saleLineId';
    if (line->>'quantity')::integer < 1 or earlier + (line->>'quantity')::integer > sold then
      raise exception 'pos return % of line % exceeds the % sold less % returned', new.id,
        line->>'saleLineId', sold, earlier
        using errcode = 'check_violation', constraint = 'pos_returns_within_quantity';
    end if;
    line_sum := line_sum + (line->>'amountMinor')::bigint;
  end loop;
  if line_sum <> new.amount_minor then
    raise exception 'pos return % amount % is not the sum % of its lines', new.id, new.amount_minor, line_sum
      using errcode = 'check_violation', constraint = 'pos_returns_amount';
  end if;
  return new;
end
$$;
create trigger pos_returns_within_paid before insert on pos_returns
  for each row execute function pos_returns_within_paid();

-- ---------------------------------------------------------------------------------------------
-- Card payments of sales: the attempt names its sale; refundable funds name the tender
-- ---------------------------------------------------------------------------------------------
alter table payment_attempts add constraint payment_attempts_pos_sale_fk
  foreign key (organization_id, pos_sale_id) references pos_sales (organization_id, id);

-- A captured POS card payment has no receipt (no obligation is paid); its refundable funds name
-- the tender instead. Exactly one of the two.
alter table payment_refundables alter column receipt_id drop not null;
alter table payment_refundables add column pos_tender_id uuid;
alter table payment_refundables add constraint payment_refundables_pos_tender_fk
  foreign key (organization_id, pos_tender_id) references pos_tenders (organization_id, id);
alter table payment_refundables add constraint payment_refundables_source
  check ((receipt_id is null) <> (pos_tender_id is null));

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
  return new;
end
$$;
