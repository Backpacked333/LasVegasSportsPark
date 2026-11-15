-- 1311_reporting_open_amount_awaiting_approval.sql
-- Reporting module (SPK-PAY-016, proposed amendment PA-08, DEC-102 pending; SPK-REPORT-004):
-- whether an open-amount line still waits for its second approval, read through the reporting
-- view instead of being guessed from `approval_required`.
--
-- Since finance migration 0697 the ceiling applies to the total of the open-amount lines one
-- person has in effect on one sale. `approval_required` says the line needed an approval when it
-- was entered; removing other lines can bring the enterer's total back within the ceiling, and
-- the line then no longer needs one (the API's `PosOpenAmountLine.awaitingApproval`). The report
-- printed "missing" for every such line. `awaiting_approval` is added at the end of
-- reporting_pos_open_amount_lines_v (1310) with the condition of finance's
-- `pos_sale_awaits_line_approval` (0697) for the one line: it needed an approval, nobody gave
-- one, and its own amount or its enterer's total in effect on the sale now is above the ceiling
-- recorded with it. Every other column, the filter and the read-only trigger are unchanged.

create or replace view reporting_pos_open_amount_lines_v as
  select l.id as sale_line_id, l.organization_id, s.facility_id, s.sale_number,
         l.reason_category, l.name as reason_label, l.revenue_category, l.description,
         l.currency, l.base_minor as amount_minor, l.charges_minor, l.line_total_minor,
         l.approval_required, (a.id is not null) as approved, a.approved_at, s.paid_at,
         coalesce(l.approval_required and a.id is null
          and (l.unit_price_minor > l.approval_ceiling_minor
               or (select coalesce(sum(o.unit_price_minor), 0)
                     from pos_sale_lines o
                    where o.organization_id = l.organization_id and o.sale_id = l.sale_id
                      and o.kind = 'open_amount' and o.quantity > 0
                      and o.entered_by_person_id = l.entered_by_person_id
                      and not exists (select 1 from pos_sale_lines n
                                       where n.organization_id = o.organization_id
                                         and n.supersedes_line_id = o.id))
                  > l.approval_ceiling_minor), false) as awaiting_approval
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
