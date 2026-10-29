-- 0605_finance_lookup_indexes.sql
-- §4.4, review focus "indexes for the queries services actually run"
-- (review2 data-and-contracts-2-09).
--
-- Receipts are read by order (every checkout view and compensation) and by obligation (the totals
-- of every obligation shown); obligations by order (checkout views, payment evidence); credit
-- redemptions by the record that consumed them (checkout finalization and abort). None had an
-- index whose leading columns matched, so each lookup scanned the organization's rows.
create index receipts_order_idx on receipts (organization_id, order_id) where order_id is not null;
create index receipts_obligation_idx on receipts (organization_id, obligation_id)
  where obligation_id is not null;
create index obligations_order_idx on obligations (organization_id, order_id, status)
  where order_id is not null;
create index credit_redemptions_reference_idx
  on credit_redemptions (organization_id, reference_type, reference_id, kind);
