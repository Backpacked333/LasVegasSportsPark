-- 1310_reporting_pos_open_amount_lines.sql
-- Reporting module (SPK-PAY-016, proposed amendment PA-08, DEC-102 pending; SPK-REPORT-004,
-- SPK-PAY-011): open-amount register lines apart from product lines, so they can be reviewed.
-- Read-only, as every reporting view (1300, 1309).
--
--   * reporting_pos_open_amount_lines_v: the open-amount lines in effect of every paid sale
--     (finance migrations 0686 and 0695: a removed line was never paid for), at the instant the
--     sale was paid, with the reason category (code and the label as approved when it was sold),
--     the revenue category it books to, the description typed at the register, the amount, its
--     charges apart, and whether a second approval was needed and given (finance migration 0696);
--   * reporting_pos_open_amount_return_lines_v: each returned open-amount line's amount, at the
--     instant of the return, under the same categories. Returns are adjustments shown apart.
--
-- The description is what a reviewer needs and is exposed on purpose; no customer and no staff
-- member is (who entered and who approved stay in the finance module's own read). The existing
-- reporting_pos_sale_lines_v and reporting_pos_return_lines_v (1309) are unchanged: they keep
-- every line, with `open_amount` as the product kind of these, and the report leaves that kind
-- out of the product lines and reads these views instead.

create view reporting_pos_open_amount_lines_v as
  select l.id as sale_line_id, l.organization_id, s.facility_id, s.sale_number,
         l.reason_category, l.name as reason_label, l.revenue_category, l.description,
         l.currency, l.base_minor as amount_minor, l.charges_minor, l.line_total_minor,
         l.approval_required, (a.id is not null) as approved, a.approved_at, s.paid_at
  from pos_sale_lines l
  join pos_sales s on s.organization_id = l.organization_id and s.id = l.sale_id
  left join pos_line_approvals a on a.organization_id = l.organization_id
                                and a.sale_line_id = l.id
  where l.kind = 'open_amount'
    and s.paid_at is not null
    and s.status in ('paid', 'partially_returned', 'returned')
    and l.quantity > 0
    and not exists (select 1 from pos_sale_lines n
                     where n.organization_id = l.organization_id and n.supersedes_line_id = l.id);

create trigger reporting_pos_open_amount_lines_v_read_only
  instead of insert or update or delete on reporting_pos_open_amount_lines_v
  for each row execute function reporting_view_read_only();

create view reporting_pos_open_amount_return_lines_v as
  select r.id as return_id, r.organization_id, s.facility_id, sl.id as sale_line_id,
         sl.reason_category, sl.name as reason_label, sl.revenue_category,
         r.currency, (rl->>'amountMinor')::bigint as amount_minor, r.returned_at, r.tender_kind
  from pos_returns r
  join pos_sales s on s.organization_id = r.organization_id and s.id = r.sale_id
  cross join lateral jsonb_array_elements(r.lines) rl
  join pos_sale_lines sl on sl.organization_id = r.organization_id
                        and sl.id = (rl->>'saleLineId')::uuid
  where sl.kind = 'open_amount';

create trigger reporting_pos_open_amount_return_lines_v_read_only
  instead of insert or update or delete on reporting_pos_open_amount_return_lines_v
  for each row execute function reporting_view_read_only();
