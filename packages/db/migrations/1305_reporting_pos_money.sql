-- 1305_reporting_pos_money.sql
-- Reporting module (R3-REPORTING-04; SPK-PAY-011 "distinguish customer receipts, refunds and
-- processor fees", metric dictionary MET-050, rule G6): point-of-sale money in the payment and
-- refund reconciliation report. A point-of-sale sale never creates a receipt or an order line: its
-- card tenders create payment attempts (purpose `pos_sale`, counted by MET-045) and its card
-- returns refund attempts (counted by MET-047), so customer receipts alone cannot be reconciled
-- with those attempts. The finance module's own reconciliation reports the same money beside its
-- receipts (MONEY-03); this view gives the reporting module the same facts, read-only:
--
--   * `tender`: a settled tender (card, cash or external), at the instant it settled;
--   * `late_capture`: a card capture the processor reported after its tender had failed, at the
--     instant its journal was posted (finance `POS_LATE_CAPTURE_PURPOSE`, MONEY-05);
--   * `return`: money paid back for a return (card, cash or external), at the instant returned.
--
-- Amounts are minor units with their currency (SPK-PAY-001); the facility is the sale's. No
-- customer, staff member or product is exposed. The view selects facts of three kinds, so its
-- `movement` is produced by the view and `tender_kind` is untyped text.

create view reporting_pos_money_v as
  select t.id as movement_id, t.organization_id, s.facility_id, 'tender'::text as movement,
         t.kind as tender_kind, t.currency, t.amount_minor, t.settled_at as occurred_at
  from pos_tenders t
  join pos_sales s on s.organization_id = t.organization_id and s.id = t.sale_id
  where t.status = 'settled'
  union all
  select j.id as movement_id, j.organization_id, s.facility_id, 'late_capture'::text as movement,
         'card'::text as tender_kind, j.currency, pa.amount_minor, j.posted_at as occurred_at
  from journals j
  join payment_attempts pa on pa.organization_id = j.organization_id and pa.id = j.source_id
  join pos_sales s on s.organization_id = pa.organization_id and s.id = pa.pos_sale_id
  where j.source_type = 'payment_attempt'
    and j.purpose = 'pos_capture_after_failure'
  union all
  select r.id as movement_id, r.organization_id, s.facility_id, 'return'::text as movement,
         r.tender_kind, r.currency, r.amount_minor, r.returned_at as occurred_at
  from pos_returns r
  join pos_sales s on s.organization_id = r.organization_id and s.id = r.sale_id;

create trigger reporting_pos_money_v_read_only
  instead of insert or update or delete on reporting_pos_money_v
  for each row execute function reporting_view_read_only();
