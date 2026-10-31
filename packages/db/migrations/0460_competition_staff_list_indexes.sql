-- 0460_competition_staff_list_indexes.sql
-- CMP-05 (SPK-RESULT-004/005, SPK-DISC-001..005, §4.5): the staff lists page newest first with a
-- keyset cursor (created_at desc, id desc) inside one organization. These indexes serve that order
-- for the lists that had no index leading with the organization and the creation time. Indexes
-- only: no constraint or data changes.
create index disputes_created_idx on disputes (organization_id, created_at desc, id desc);
create index appeals_created_idx on appeals (organization_id, created_at desc, id desc);
create index disciplinary_decisions_created_idx
  on disciplinary_decisions (organization_id, created_at desc, id desc);
