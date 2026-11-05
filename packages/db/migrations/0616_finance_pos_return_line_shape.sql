-- 0616_finance_pos_return_line_shape.sql
-- R2-SCHEMA-04 (§4.7 invariant 6: a return never exceeds what was sold), completing 0615 (and the
-- stage-5 MONEY-10 fix of 0610). pos_returns_within_paid still trusted the JSON shape of a
-- return's lines: a line without a quantity, or with a null one, passed every check, because
-- `(line->>'quantity')::integer < 1` is NULL for it, the per-line sum of NULL quantities made
-- `earlier + requested > sold` NULL, and a missing amountMinor made the line sum NULL so the
-- "amount is the sum of its lines" check was skipped too. A fully returned line could therefore be
-- returned again by a direct or non-HTTP writer, bounded only by the tender total. Now every line
-- must be an object whose quantity is a whole JSON number from 1 to 2147483647 and whose
-- amountMinor is a whole JSON number of at least 0 (the shape the service writes), else the return
-- is refused (pos_returns_line_shape); with every line valid no sum below can be NULL, and the
-- sums are coalesced besides. Everything else is as in 0615.

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
  line_quantity numeric;
  line_amount numeric;
  -- numeric, so no sum of valid amounts can overflow before it is compared.
  line_sum numeric := 0;
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
    -- The type checks come first, each in its own statement, so no cast below meets a value that
    -- is not a JSON number (SQL does not promise to evaluate the operands of `or` in order).
    if jsonb_typeof(line) is distinct from 'object'
       or jsonb_typeof(line->'quantity') is distinct from 'number'
       or jsonb_typeof(line->'amountMinor') is distinct from 'number' then
      raise exception 'pos return % has a line without a numeric quantity and amountMinor: %',
        new.id, line
        using errcode = 'check_violation', constraint = 'pos_returns_line_shape';
    end if;
    line_quantity := (line->>'quantity')::numeric;
    line_amount := (line->>'amountMinor')::numeric;
    if line_quantity <> trunc(line_quantity) or line_quantity < 1 or line_quantity > 2147483647
       or line_amount <> trunc(line_amount) or line_amount < 0
       or line_amount > 9223372036854775807 then
      raise exception 'pos return % has a line whose quantity % is not a whole number of units or whose amount % is not whole minor units',
        new.id, line_quantity, line_amount
        using errcode = 'check_violation', constraint = 'pos_returns_line_shape';
    end if;
    if (line->>'saleLineId') is null
       or (line->>'saleLineId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'pos return % names sale line % that is not a canonical lower-case uuid',
        new.id, coalesce(line->>'saleLineId', 'missing')
        using errcode = 'check_violation', constraint = 'pos_returns_line_id_canonical';
    end if;
    line_sum := line_sum + line_amount;
  end loop;
  -- One check per sale line (by uuid value) over the units this return names for it in total.
  for requested in
    select (l->>'saleLineId')::uuid as sale_line_id,
           coalesce(sum((l->>'quantity')::integer), 0)::bigint as quantity
      from jsonb_array_elements(new.lines) l
     group by (l->>'saleLineId')::uuid
  loop
    select quantity into sold from pos_sale_lines
     where organization_id = new.organization_id and sale_id = new.sale_id
       and id = requested.sale_line_id;
    if sold is null then
      raise exception 'pos return % names a line % that is not on sale %', new.id,
        requested.sale_line_id, new.sale_id
        using errcode = 'check_violation', constraint = 'pos_returns_line_of_sale';
    end if;
    -- Earlier rows passed the uuid cast of 0607/0610/0615, so each of their ids casts; a quantity
    -- an earlier row lacks counts as no unit (sum skips NULL, coalesce covers none at all).
    select coalesce(sum((l->>'quantity')::integer), 0)::integer into earlier
      from pos_returns r, jsonb_array_elements(r.lines) l
     where r.organization_id = new.organization_id and r.sale_id = new.sale_id
       and (l->>'saleLineId')::uuid = requested.sale_line_id;
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
