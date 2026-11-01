-- 1307_reporting_pos_return_refunds.sql
-- Reporting module (R3-REPORTING-04 rework; SPK-PAY-007 "unknown kept explicit until reconciled",
-- SPK-PAY-008, SPK-PAY-011, metric dictionary MET-050): a card return's `pos_returns` row is
-- written when its refund is only reserved, before the refund attempt is executed (finance
-- `PosSalesService.approveReturn`), and the row is append-only. Reported by its return instant
-- alone, a card return whose refund is still requested, processing or unknown, or has failed,
-- would read as money paid back. The view gains the card return's `refund_attempt_id`, so the
-- report shows card returns by the state of their refund attempt (read through
-- `reporting_refund_attempts_v`) and never resolves an outcome by labelling it.
--
-- Migration 1305 is applied and immutable; `create or replace view` keeps the view's columns, in
-- order and with their types, and its read-only trigger, and only appends a column. The tender and
-- late-capture branches carry no refund attempt (null); a cash or external return has none either
-- (check `pos_returns_card_refund`).

create or replace view reporting_pos_money_v as
  select t.id as movement_id, t.organization_id, s.facility_id, 'tender'::text as movement,
         t.kind as tender_kind, t.currency, t.amount_minor, t.settled_at as occurred_at,
         null::uuid as refund_attempt_id
  from pos_tenders t
  join pos_sales s on s.organization_id = t.organization_id and s.id = t.sale_id
  where t.status = 'settled'
  union all
  select j.id as movement_id, j.organization_id, s.facility_id, 'late_capture'::text as movement,
         'card'::text as tender_kind, j.currency, pa.amount_minor, j.posted_at as occurred_at,
         null::uuid as refund_attempt_id
  from journals j
  join payment_attempts pa on pa.organization_id = j.organization_id and pa.id = j.source_id
  join pos_sales s on s.organization_id = pa.organization_id and s.id = pa.pos_sale_id
  where j.source_type = 'payment_attempt'
    and j.purpose = 'pos_capture_after_failure'
  union all
  select r.id as movement_id, r.organization_id, s.facility_id, 'return'::text as movement,
         r.tender_kind, r.currency, r.amount_minor, r.returned_at as occurred_at,
         r.refund_attempt_id
  from pos_returns r
  join pos_sales s on s.organization_id = r.organization_id and s.id = r.sale_id;
