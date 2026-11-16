-- 0697_finance_pos_open_amount_sale_total.sql
-- SPK-PAY-016 (proposed amendment PA-08, DEC-102 pending; capability `open_amount_lines`): the
-- ceiling of the person who enters open-amount lines applies to the total of the open-amount
-- lines in effect that this person entered on the sale, not to each line alone.
--
-- Until now a line needed the second approval exactly when its own amount was above the ceiling
-- recorded with it (0695, pos_sale_lines_open_amount_ceiling), so any number of lines just under
-- the ceiling could be entered on one sale and tendered with no second person. From this
-- migration a line needs the second approval exactly when the open-amount total its enterer has
-- in effect on the sale, this line included, is above the ceiling recorded with the line. A
-- single line above the ceiling is the case of a total of one line, and behaves as before.
--
-- What is enforced here (the service computes the same first):
--   * `entered_total_minor`, the total the line was judged against, is derived by the database
--     under the sale lock and never taken from the writer (pos_sale_lines_open_amount_total);
--   * `approval_required` follows from that total and the ceiling, never from the writer
--     (pos_sale_lines_open_amount_ceiling, now raised by the trigger that knows the total; the
--     table check keeps the part it can see: a line above the ceiling always needs approval);
--   * a removal repeats the ceiling, the total and the approval need of the line it removes
--     (pos_sale_lines_open_amount_supersede);
--   * an approval records the total it was given for, derived from the line, and is for an
--     amount or a total above the ceiling (pos_line_approvals_above_ceiling);
--   * a sale waits for an approval while a line in effect that needed one when it was entered is
--     not approved and its own amount, or the total its enterer has in effect on the sale now, is
--     above the ceiling (pos_sale_awaits_line_approval). Removing lines until the enterer's total
--     is within the ceiling lifts the block, as removing a single line above the ceiling does.
-- Every rule of 0695 and 0696 is kept. `pos_sale_lines_apply`, `pos_line_approvals_guard`,
-- `pos_tenders_open_amount_approved` and `pos_sales_open_amount_approved` are not replaced; the
-- triggers below are additional. `pos_sale_awaits_line_approval`, the predicate the tender and
-- paid guards call, is replaced with one that answers the same for every line written before
-- this migration (such a line needed its approval only for its own amount, which is the first
-- half of the new condition) and applies the total to the lines written after it. So a sale
-- whose enterer's total is above the ceiling takes no tender and is never paid until a second
-- person approves, exactly as a sale with one line above the ceiling.
--
-- Not limited here: totals across separate sales of a register session or of a day. Those are
-- visible in the session's open-amount report and stay a pending decision (DEC-102).
--
-- Lines written before this migration keep `entered_total_minor` null: lines are append-only
-- (0607) and they were judged alone, which the table check still describes.

alter table pos_sale_lines add column entered_total_minor bigint;
alter table pos_sale_lines add constraint pos_sale_lines_entered_total check (
  (kind = 'open_amount' or entered_total_minor is null)
  and (entered_total_minor is null or entered_total_minor >= unit_price_minor)
);

-- The part of the rule one row can show: above the ceiling alone, the approval is needed. Whether
-- it is needed within the ceiling depends on the enterer's other lines (the trigger below).
alter table pos_sale_lines drop constraint pos_sale_lines_open_amount_ceiling;
alter table pos_sale_lines add constraint pos_sale_lines_open_amount_ceiling check (
  kind <> 'open_amount'
  or (approval_ceiling_minor >= 0
      and (approval_required or unit_price_minor <= approval_ceiling_minor))
);

-- Before the row is stored: the total it is judged against. The sale row is locked first, as
-- every other writer of a sale's parts does, so two lines of one person never pass each other.
-- Nothing is refused here, so the table's own checks still answer first for a malformed row.
create or replace function pos_sale_lines_entered_total() returns trigger
language plpgsql as $$
declare
  prior bigint;
begin
  if new.kind is distinct from 'open_amount' then
    return new;
  end if;
  perform 1 from pos_sales
   where organization_id = new.organization_id and id = new.sale_id for update;
  if new.supersedes_line_id is not null then
    -- A removal repeats what it removes, the total it was judged against included.
    select l.entered_total_minor into new.entered_total_minor from pos_sale_lines l
     where l.organization_id = new.organization_id and l.sale_id = new.sale_id
       and l.id = new.supersedes_line_id;
    return new;
  end if;
  select coalesce(sum(l.unit_price_minor), 0)::bigint into prior
    from pos_sale_lines l
   where l.organization_id = new.organization_id and l.sale_id = new.sale_id
     and l.kind = 'open_amount' and l.quantity > 0
     and l.entered_by_person_id = new.entered_by_person_id
     and not exists (select 1 from pos_sale_lines n
                      where n.organization_id = l.organization_id
                        and n.supersedes_line_id = l.id);
  new.entered_total_minor := prior + new.unit_price_minor;
  return new;
end
$$;
create trigger pos_sale_lines_entered_total before insert on pos_sale_lines
  for each row execute function pos_sale_lines_entered_total();

-- After the row passed the table's checks and pos_sale_lines_apply (which fires first, by name):
-- the approval need follows from the total, and a removal repeats the line it removes.
create or replace function pos_sale_lines_open_amount_total() returns trigger
language plpgsql as $$
declare
  superseded record;
begin
  if new.kind <> 'open_amount' then
    return null;
  end if;
  if new.supersedes_line_id is not null then
    select approval_ceiling_minor, approval_required into superseded from pos_sale_lines
     where organization_id = new.organization_id and sale_id = new.sale_id
       and id = new.supersedes_line_id;
    if new.approval_ceiling_minor is distinct from superseded.approval_ceiling_minor
       or new.approval_required is distinct from superseded.approval_required then
      raise exception 'pos sale line % is an open amount and can only be removed as it was entered',
        new.supersedes_line_id
        using errcode = 'check_violation', constraint = 'pos_sale_lines_open_amount_supersede';
    end if;
    return null;
  end if;
  if new.approval_required is distinct from (new.entered_total_minor > new.approval_ceiling_minor) then
    raise exception 'pos sale line %: the open amounts its enterer has on the sale total %, the ceiling is %, so a second approval is % needed',
      new.id, new.entered_total_minor, new.approval_ceiling_minor,
      case when new.entered_total_minor > new.approval_ceiling_minor then '' else 'not' end
      using errcode = 'check_violation', constraint = 'pos_sale_lines_open_amount_ceiling';
  end if;
  return null;
end
$$;
create trigger pos_sale_lines_open_amount_total after insert on pos_sale_lines
  for each row execute function pos_sale_lines_open_amount_total();

-- The approval records the total it was given for. A line within the ceiling whose enterer's
-- total is above it needs an approval too, so "above the ceiling" is about the amount or the
-- total.
alter table pos_line_approvals add column entered_total_minor bigint
  check (entered_total_minor is null or entered_total_minor >= amount_minor);
alter table pos_line_approvals drop constraint pos_line_approvals_above_ceiling;
alter table pos_line_approvals add constraint pos_line_approvals_above_ceiling check (
  amount_minor > ceiling_minor or coalesce(entered_total_minor, amount_minor) > ceiling_minor
);

-- Fires after pos_line_approvals_guard (by name), which has locked the sale and judged the line.
create or replace function pos_line_approvals_total() returns trigger
language plpgsql as $$
begin
  select l.entered_total_minor into new.entered_total_minor from pos_sale_lines l
   where l.organization_id = new.organization_id and l.sale_id = new.sale_id
     and l.id = new.sale_line_id;
  return new;
end
$$;
create trigger pos_line_approvals_total before insert on pos_line_approvals
  for each row execute function pos_line_approvals_total();

-- True when a line in effect of the sale needed an approval when it was entered, nobody approved
-- it yet, and it is still above the ceiling: alone, or with the other open-amount lines its
-- enterer has in effect on the sale now. 0696's predicate with the last condition added; for a
-- line written before this migration `approval_required` already means "alone".
create or replace function pos_sale_awaits_line_approval(org uuid, sale uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from pos_sale_lines l
     where l.organization_id = org and l.sale_id = sale
       and l.kind = 'open_amount' and l.approval_required and l.quantity > 0
       and not exists (select 1 from pos_sale_lines n
                        where n.organization_id = l.organization_id
                          and n.supersedes_line_id = l.id)
       and not exists (select 1 from pos_line_approvals a
                        where a.organization_id = l.organization_id
                          and a.sale_line_id = l.id)
       and (l.unit_price_minor > l.approval_ceiling_minor
            or (select coalesce(sum(o.unit_price_minor), 0)
                  from pos_sale_lines o
                 where o.organization_id = l.organization_id and o.sale_id = l.sale_id
                   and o.kind = 'open_amount' and o.quantity > 0
                   and o.entered_by_person_id = l.entered_by_person_id
                   and not exists (select 1 from pos_sale_lines n
                                    where n.organization_id = o.organization_id
                                      and n.supersedes_line_id = o.id)) > l.approval_ceiling_minor)
  )
$$;
