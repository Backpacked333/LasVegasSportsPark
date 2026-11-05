-- 1302_reporting_space_status_and_order_totals.sql
-- Reporting module: two facts the reports need and the views of 1300 did not expose. Migration
-- 1300 is applied and immutable; `create or replace view` keeps a view's columns and its
-- read-only trigger and only appends columns.
--
-- 1. Space status history (SPK-REPORT-003, metric dictionary MET-064 "units of resources with
--    status closed are reported as closed"). `resources.status` holds only the current status. A
--    space is created active (ResourcesService.createResource) and the scheduling module records
--    every status change in the same transaction, as an append-only audit record stamped with the
--    injected clock (action `scheduling.resource_updated`, `details.status`). The view exposes
--    those changes, so a report evaluated as of an instant sees exactly the changes recorded by
--    then (metric dictionary G3) and a later change never rewrites an earlier period.
-- 2. The order total on each order line (SPK-REPORT-005, MET-082 excludes orders fully refunded):
--    whether succeeded refunds reach the order's total needs the total, not the sum of its lines.

create view reporting_resource_status_changes_v as
  select a.id as change_id, a.organization_id, r.facility_id, r.id as resource_id,
         a.details ->> 'status' as status, a.occurred_at as changed_at
  from audit_records a
  join resources r on r.organization_id = a.organization_id and r.id::text = a.target_id
  where a.action = 'scheduling.resource_updated'
    and a.target_type = 'resource'
    and a.details ->> 'status' is not null;

create trigger reporting_resource_status_changes_v_read_only
  instead of insert or update or delete on reporting_resource_status_changes_v
  for each row execute function reporting_view_read_only();

create or replace view reporting_order_lines_v as
  select ol.id as order_line_id, ol.organization_id, ol.order_id, ol.offering_id, ol.enrollment_id,
         ol.participant_person_id, ol.total_minor, ol.currency, o.payer_person_id,
         o.payment_status, o.fulfillment_status, o.paid_at, o.fulfilled_at, o.canceled_at,
         off.facility_id, off.kind as offering_kind, o.total_minor as order_total_minor
  from order_lines ol
  join orders o on o.organization_id = ol.organization_id and o.id = ol.order_id
  join offerings off on off.organization_id = ol.organization_id and off.id = ol.offering_id;
