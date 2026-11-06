-- 1309_reporting_pos_product_lines.sql
-- Reporting module (park UI redesign "revenue by product line"; SPK-REPORT-004, SPK-PAY-011,
-- metric MET-109 / MET-110): point-of-sale sales and returns by product kind, read-only.
--
--   * reporting_pos_sale_lines_v: the lines in effect of every paid sale (finance migration 0686:
--     a line superseded by a quantity change or removal was never paid for as such, and a removal
--     has quantity 0), at the instant the sale was paid, with the line's total (approved taxes and
--     fees included, as charged) and its charges apart;
--   * reporting_pos_return_lines_v: each returned line's amount, at the instant of the return,
--     with the kind of the line it returns. Returns are adjustments shown apart, never netted.
--
-- No customer, staff member, product name or evidence is exposed. Amounts are minor units with
-- their currency (SPK-PAY-001); the facility is the sale's.

create view reporting_pos_sale_lines_v as
  select l.id as sale_line_id, l.organization_id, s.facility_id, l.kind as product_kind,
         l.currency, l.quantity, l.base_minor, l.charges_minor, l.line_total_minor, s.paid_at
  from pos_sale_lines l
  join pos_sales s on s.organization_id = l.organization_id and s.id = l.sale_id
  where s.paid_at is not null
    and s.status in ('paid', 'partially_returned', 'returned')
    and l.quantity > 0
    and not exists (select 1 from pos_sale_lines n
                     where n.organization_id = l.organization_id and n.supersedes_line_id = l.id);

create trigger reporting_pos_sale_lines_v_read_only
  instead of insert or update or delete on reporting_pos_sale_lines_v
  for each row execute function reporting_view_read_only();

create view reporting_pos_return_lines_v as
  select r.id as return_id, r.organization_id, s.facility_id, sl.kind as product_kind,
         r.currency, (rl->>'amountMinor')::bigint as amount_minor, r.returned_at,
         r.tender_kind, r.refund_attempt_id
  from pos_returns r
  join pos_sales s on s.organization_id = r.organization_id and s.id = r.sale_id
  cross join lateral jsonb_array_elements(r.lines) rl
  join pos_sale_lines sl on sl.organization_id = r.organization_id
                        and sl.id = (rl->>'saleLineId')::uuid;

create trigger reporting_pos_return_lines_v_read_only
  instead of insert or update or delete on reporting_pos_return_lines_v
  for each row execute function reporting_view_read_only();
