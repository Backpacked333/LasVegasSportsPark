-- 0686_finance_pos_line_quantity.sql
-- Changing the quantity of a point-of-sale ticket line (§3.16 POS, SPK-PAY-001, SPK-PAY-002,
-- SPK-PAY-010; park UI redesign gap "a command to change line quantity").
--
-- Sale lines stay append-only (0607): a quantity change is a new line that supersedes the line it
-- corrects, priced again from the product and its approved charges, and a removal is a superseding
-- line of quantity 0. The superseded line is kept as it was, so the ticket's history is complete;
-- only lines nobody supersedes ("live" lines) count toward the sale's totals, are paid for, and can
-- be returned.
--
-- Enforced here (the service checks the same first):
--   * a line is superseded at most once, by a line of the same sale and product
--     (pos_sale_lines_superseded_once, pos_sale_lines_supersedes_fk, pos_sale_lines_same_product);
--   * quantity 0 only on a superseding line (pos_sale_lines_quantity), and a removed line is not
--     superseded again (pos_sale_lines_supersede_removed);
--   * only while the sale is open (pos_sale_lines_open_sale, as before), and never so that the
--     sale's total falls below the tenders already taken or pending on it
--     (pos_sale_lines_below_tendered);
--   * a return names live lines only (pos_returns_live_lines).

alter table pos_sale_lines
  add constraint pos_sale_lines_organization_id_sale_id_id_key unique (organization_id, sale_id, id);
alter table pos_sale_lines add column supersedes_line_id uuid;
alter table pos_sale_lines
  add constraint pos_sale_lines_supersedes_fk foreign key (organization_id, sale_id, supersedes_line_id)
    references pos_sale_lines (organization_id, sale_id, id);
alter table pos_sale_lines
  add constraint pos_sale_lines_not_self check (supersedes_line_id is distinct from id);
create unique index pos_sale_lines_superseded_once
  on pos_sale_lines (organization_id, supersedes_line_id) where supersedes_line_id is not null;
alter table pos_sale_lines drop constraint pos_sale_lines_quantity_check;
alter table pos_sale_lines
  add constraint pos_sale_lines_quantity
    check (quantity >= 1 or (quantity = 0 and supersedes_line_id is not null));

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
    select product_id, quantity into superseded from pos_sale_lines
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

-- A return names only live lines: a superseded line was never paid for as such.
create or replace function pos_returns_live_lines() returns trigger
language plpgsql as $$
declare
  line_id uuid;
begin
  for line_id in
    select distinct (l->>'saleLineId')::uuid from jsonb_array_elements(new.lines) l
     where (l->>'saleLineId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  loop
    if exists (select 1 from pos_sale_lines n
                where n.organization_id = new.organization_id and n.supersedes_line_id = line_id)
       or exists (select 1 from pos_sale_lines z
                   where z.organization_id = new.organization_id and z.id = line_id
                     and z.quantity = 0) then
      raise exception 'pos return % names line % that was changed or removed before the sale was paid',
        new.id, line_id
        using errcode = 'check_violation', constraint = 'pos_returns_live_lines';
    end if;
  end loop;
  return new;
end
$$;
create trigger pos_returns_live_lines before insert on pos_returns
  for each row execute function pos_returns_live_lines();
