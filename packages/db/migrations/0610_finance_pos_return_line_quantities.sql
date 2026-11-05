-- 0610_finance_pos_return_line_quantities.sql
-- MONEY-10 (§4.7 invariant 6; README "a return never exceeds a line's sold quantity"): the 0607
-- trigger compared each element of a return's lines with earlier returns only, so one return naming
-- the same sale line twice ([{A,1},{A,1}] against 1 sold) passed the quantity check. The quantities
-- a return names are now summed per sale line before they are compared with what was sold less
-- what earlier returns took. Everything else is as in 0607.

create or replace function pos_returns_within_paid() returns trigger
language plpgsql as $$
declare
  sale_status text;
  settled bigint;
  returned bigint;
  line jsonb;
  requested record;
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
    if (line->>'quantity')::integer < 1 then
      raise exception 'pos return % of line % returns no unit', new.id, line->>'saleLineId'
        using errcode = 'check_violation', constraint = 'pos_returns_within_quantity';
    end if;
    line_sum := line_sum + (line->>'amountMinor')::bigint;
  end loop;
  -- One check per sale line over the units this return names for it in total.
  for requested in
    select l->>'saleLineId' as sale_line_id, sum((l->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(new.lines) l
     group by l->>'saleLineId'
  loop
    select quantity into sold from pos_sale_lines
     where organization_id = new.organization_id and sale_id = new.sale_id
       and id = requested.sale_line_id::uuid;
    if sold is null then
      raise exception 'pos return % names a line % that is not on sale %', new.id,
        requested.sale_line_id, new.sale_id
        using errcode = 'check_violation', constraint = 'pos_returns_line_of_sale';
    end if;
    select coalesce(sum((l->>'quantity')::integer), 0)::integer into earlier
      from pos_returns r, jsonb_array_elements(r.lines) l
     where r.organization_id = new.organization_id and r.sale_id = new.sale_id
       and l->>'saleLineId' = requested.sale_line_id;
    if earlier + requested.quantity > sold then
      raise exception 'pos return % of % units of line % exceeds the % sold less % returned', new.id,
        requested.quantity, requested.sale_line_id, sold, earlier
        using errcode = 'check_violation', constraint = 'pos_returns_within_quantity';
    end if;
  end loop;
  if line_sum <> new.amount_minor then
    raise exception 'pos return % amount % is not the sum % of its lines', new.id, new.amount_minor, line_sum
      using errcode = 'check_violation', constraint = 'pos_returns_amount';
  end if;
  return new;
end
$$;
