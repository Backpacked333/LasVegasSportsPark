-- 0503_enrollment_basket_line_index.sql
-- §4.4, review focus "indexes for the queries services actually run"
-- (review2 data-and-contracts-2-09).
--
-- A basket hold resolves its enrollment by basket line (EnrollmentsService, capacity-hold owner
-- lookups); no index led with basket_line_id, so the lookup scanned the organization's enrollments.
create index enrollments_basket_line_idx on enrollments (organization_id, basket_line_id)
  where basket_line_id is not null;
