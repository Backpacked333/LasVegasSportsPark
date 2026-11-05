-- 0452_competition_suspension_decision_index.sql
-- §4.4, review focus "indexes for the queries services actually run"
-- (review2 data-and-contracts-2-09).
--
-- A disciplinary decision reads, overturns and appeals through its suspension (DisciplineService
-- by decision_id); no index led with decision_id, so each lookup scanned the organization's
-- suspensions.
create index suspensions_decision_idx on suspensions (organization_id, decision_id)
  where decision_id is not null;
