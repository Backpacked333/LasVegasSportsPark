-- 0691_finance_order_line_kinds.sql
-- Finance module. Proposed amendments PA-03 (SPK-PAY-014) and PA-07 (SPK-REG-012); Proposed, open
-- values Pending decision (DEC-097, DEC-101). ADR-003: order lines follow the quote lines.
--
-- An order line is the purchase of exactly one quote line (unique (order_id, quote_line_id),
-- 0600), so it gains the same line_kind and source_id and keeps the same enrollment as the place
-- it belongs to: an add-on or a uniform is refunded, transferred and reported with its
-- registration. order_lines is append-only: only columns and constraints are added.
--
-- Invariants enforced here:
--   * line_kind is one of the three kinds; the place names no source and an extra names one
--     (order_lines_source_shape);
--   * an order line has the kind and source of the quote line it purchases
--     (trigger order_lines_follow_quote_line), so an order can never relabel what was quoted.

alter table order_lines
  add column line_kind text not null default 'registration'
    constraint order_lines_line_kind_check check (line_kind in ('registration', 'addon', 'uniform')),
  add column source_id uuid;

alter table order_lines
  add constraint order_lines_source_shape
    check ((line_kind = 'registration') = (source_id is null));

create or replace function order_lines_follow_quote_line() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from quote_lines q
     where q.organization_id = new.organization_id
       and q.id = new.quote_line_id
       and q.line_kind = new.line_kind
       and q.source_id is not distinct from new.source_id
  ) then
    raise exception 'order line % does not follow the kind of its quote line', new.id
      using errcode = 'check_violation', constraint = 'order_lines_follow_quote_line';
  end if;
  return new;
end
$$;
create trigger order_lines_follow_quote_line before insert on order_lines
  for each row execute function order_lines_follow_quote_line();
