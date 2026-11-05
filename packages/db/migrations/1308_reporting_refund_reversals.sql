-- 1308_reporting_refund_reversals.sql
-- Reporting module, R4-PROVIDER-OUTCOMES-02 follow-up (§4.11 provider money facts stay visible when
-- they contradict a recorded state; SPK-PAY-008 refunds; SPK-REPORT-002 report definitions): a refund
-- the provider reported failed after finance recorded it `succeeded` keeps that status, and finance
-- records the contradiction in refund_attempts.reversed_at (migration 0681). No money was returned,
-- so reports must not count such a refund as returned.
--
-- Migration 1300 is applied and immutable; `create or replace view` keeps the view's columns, in
-- order and with their types, and its read-only trigger, and only appends `reversed_at`.

create or replace view reporting_refund_attempts_v as
  select ra.id as refund_attempt_id, ra.organization_id, ra.payment_attempt_id, pa.order_id,
         ra.amount_minor, ra.currency, ra.purpose, ra.provider, ra.status, ra.reservation_status,
         ra.submitted_at, ra.unknown_since, ra.resolved_at, ra.reversed_at
  from refund_attempts ra
  join payment_attempts pa on pa.organization_id = ra.organization_id and pa.id = ra.payment_attempt_id;
