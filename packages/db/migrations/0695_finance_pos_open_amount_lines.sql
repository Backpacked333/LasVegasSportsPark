-- 0695_finance_pos_open_amount_lines.sql
-- SPK-PAY-016 (proposed amendment PA-08, DEC-102 pending; capability `open_amount_lines`): a
-- register line whose amount a permitted staff member enters, with a description and a reason
-- category from the approved list. §3.16 POS row; SPK-PAY-001, SPK-PAY-010.
--
-- Until now a sale line was a product and a quantity (0607). A line is now one of two shapes, and
-- the database refuses anything in between (pos_sale_lines_shape):
--   * a product line, exactly as before: product, sku, a product kind, none of the columns below;
--   * an open-amount line (kind `open_amount`): no product and no sku; a typed description; the
--     reason category chosen (its label as approved is snapshotted in `name`); the revenue
--     category the line books to; who entered it; the ceiling that applied to that person when
--     it was entered, and whether the amount is above it (`approval_required`, which the database
--     derives from the two amounts and never takes on trust); the approved policy version the
--     category and ceiling came from (null: the engineering default applied, **Proposed**).
-- An open-amount line is one unit at the entered amount: the amount is positive (a discount or a
-- refund is never a negative line, SPK-PAY-003, SPK-PAY-008) and the quantity is 1.
--
-- Lines stay append-only (0607) and a line is still corrected only by a superseding line (0686).
-- An open-amount line is corrected in one way: it is removed (a superseding line of quantity 0
-- that repeats what it removes); a different amount is a new line, entered and judged against the
-- ceiling again. `pos_sale_lines_apply` is replaced below with every rule of 0686 kept and that
-- one added.

alter table pos_sale_lines alter column product_id drop not null;
alter table pos_sale_lines alter column sku drop not null;
alter table pos_sale_lines drop constraint pos_sale_lines_kind_check;
alter table pos_sale_lines add constraint pos_sale_lines_kind_check
  check (kind in ('merchandise', 'concession', 'service', 'open_amount'));

alter table pos_sale_lines
  add column description text,
  add column reason_category text,
  add column revenue_category text,
  add column entered_by jsonb,
  add column entered_by_person_id uuid,
  add column approval_ceiling_minor bigint,
  add column approval_required boolean,
  add column policy_version_id uuid;

alter table pos_sale_lines
  add constraint pos_sale_lines_entered_by_fk foreign key (organization_id, entered_by_person_id)
    references persons (organization_id, id);
alter table pos_sale_lines
  add constraint pos_sale_lines_policy_version_fk foreign key (organization_id, policy_version_id)
    references policy_versions (organization_id, id);

-- Exactly one shape.
alter table pos_sale_lines add constraint pos_sale_lines_shape check (
  (kind <> 'open_amount'
     and product_id is not null and sku is not null
     and description is null and reason_category is null and revenue_category is null
     and entered_by is null and entered_by_person_id is null
     and approval_ceiling_minor is null and approval_required is null
     and policy_version_id is null)
  or
  (kind = 'open_amount'
     and product_id is null and sku is null
     and description is not null and reason_category is not null and revenue_category is not null
     and entered_by is not null and entered_by_person_id is not null
     and approval_ceiling_minor is not null and approval_required is not null)
);
alter table pos_sale_lines add constraint pos_sale_lines_open_amount_text check (
  (description is null or length(btrim(description)) between 1 and 200)
  and (reason_category is null or reason_category ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
  and (revenue_category is null or revenue_category ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
);
-- Positive, one unit (0 only on the superseding line that removes it, as pos_sale_lines_quantity
-- already requires).
alter table pos_sale_lines add constraint pos_sale_lines_open_amount_positive check (
  kind <> 'open_amount' or (unit_price_minor > 0 and quantity in (0, 1))
);
-- The second approval is needed exactly when the amount is above the ceiling recorded with it.
alter table pos_sale_lines add constraint pos_sale_lines_open_amount_ceiling check (
  kind <> 'open_amount'
  or (approval_ceiling_minor >= 0 and approval_required = (unit_price_minor > approval_ceiling_minor))
);

create index pos_sale_lines_open_amount_idx on pos_sale_lines (organization_id, sale_id)
  where kind = 'open_amount';

-- 0686 with one rule added (pos_sale_lines_open_amount_supersede). Everything else is unchanged:
-- the sale is open, the charges add up, a line is superseded by a line of the same product, a
-- removed line is not changed again, the totals follow the lines in effect under the sale lock,
-- and a correction never takes the total below what was tendered.
create or replace function pos_sale_lines_apply() returns trigger
language plpgsql as $$
declare
  sale_status text;
  charge_sum bigint;
  superseded record;
  new_total bigint;
  tendered bigint;
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
  if new.supersedes_line_id is not null then
    select product_id, quantity, kind, description, reason_category, revenue_category,
           unit_price_minor
      into superseded from pos_sale_lines
     where organization_id = new.organization_id and sale_id = new.sale_id
       and id = new.supersedes_line_id;
    if superseded.product_id is distinct from new.product_id then
      raise exception 'pos sale line % supersedes line % of another product', new.id, new.supersedes_line_id
        using errcode = 'check_violation', constraint = 'pos_sale_lines_same_product';
    end if;
    if superseded.quantity = 0 then
      raise exception 'pos sale line % was removed and is not changed again', new.supersedes_line_id
        using errcode = 'check_violation', constraint = 'pos_sale_lines_supersede_removed';
    end if;
    -- SPK-PAY-016: an open-amount line is only ever removed, by a line that repeats it; a product
    -- line is never superseded by an open amount nor the other way round.
    if (superseded.kind = 'open_amount') <> (new.kind = 'open_amount')
       or (new.kind = 'open_amount'
           and (new.quantity <> 0
                or new.description is distinct from superseded.description
                or new.reason_category is distinct from superseded.reason_category
                or new.revenue_category is distinct from superseded.revenue_category
                or new.unit_price_minor is distinct from superseded.unit_price_minor)) then
      raise exception 'pos sale line % is an open amount and can only be removed as it was entered',
        new.supersedes_line_id
        using errcode = 'check_violation', constraint = 'pos_sale_lines_open_amount_supersede';
    end if;
  end if;
  update pos_sales s
     set subtotal_minor = t.subtotal, charges_minor = t.charges, total_minor = t.subtotal + t.charges,
         revision = s.revision + 1
    from (select coalesce(sum(l.base_minor), 0)::bigint as subtotal,
                 coalesce(sum(l.charges_minor), 0)::bigint as charges
            from pos_sale_lines l
           where l.organization_id = new.organization_id and l.sale_id = new.sale_id
             and not exists (select 1 from pos_sale_lines n
                              where n.organization_id = l.organization_id
                                and n.supersedes_line_id = l.id)) t
   where s.organization_id = new.organization_id and s.id = new.sale_id
  returning s.total_minor into new_total;
  if new.supersedes_line_id is not null then
    select coalesce(sum(amount_minor), 0)::bigint into tendered from pos_tenders
     where organization_id = new.organization_id and sale_id = new.sale_id
       and status in ('pending', 'settled');
    if new_total < tendered then
      raise exception 'pos sale % total % would fall below the % already tendered', new.sale_id,
        new_total, tendered
        using errcode = 'check_violation', constraint = 'pos_sale_lines_below_tendered';
    end if;
  end if;
  return null;
end
$$;
