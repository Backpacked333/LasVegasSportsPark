-- 0606_finance_customer_read_indexes.sql
-- FIN-01 / FIN-02 (SPK-PAY-004, SPK-PAY-005, SPK-PAY-007, §4.5 scoped, paginated queries):
-- indexes for the keyset lists finance now serves, newest first on (created_at desc, id desc).
--
-- Customer lists read by the payer (GET /v1/me/registration-checkouts, /me/payments,
-- /me/receipts) and by the requested player (GET /v1/me/contribution-requests); staff lists read
-- the organization's orders, payments and refunds the same way. orders_payer_idx (0600) already
-- serves GET /v1/me/orders; the obligation and credit lists page on their existing indexes.
create index checkouts_payer_idx on checkouts (organization_id, payer_person_id, created_at desc, id desc);
create index payment_attempts_payer_idx
  on payment_attempts (organization_id, payer_person_id, created_at desc, id desc);
create index receipts_payer_idx on receipts (organization_id, payer_person_id, created_at desc, id desc);
create index contribution_requests_requested_idx
  on contribution_requests (organization_id, requested_person_id, status);
create index orders_created_idx on orders (organization_id, created_at desc, id desc);
create index payment_attempts_created_idx on payment_attempts (organization_id, created_at desc, id desc);
create index refund_attempts_created_idx on refund_attempts (organization_id, created_at desc, id desc);
