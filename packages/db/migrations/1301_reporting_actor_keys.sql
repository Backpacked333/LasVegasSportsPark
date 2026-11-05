-- 1301_reporting_actor_keys.sql
-- Reporting module: actor and space references are organization-scoped composite foreign keys
-- (§4.3, §4.7 invariant 1, §4.14, CLAUDE.md "composite foreign keys"). Migration 1300 is applied
-- and immutable; this file adds:
--
-- 1. The requester of a stored run and of an export, and the approver of a cost input, name an
--    account or person of the row's own organization. The export's requester account is the
--    binding its single-requester download checks (ExportsService.loadOwn), so it must never name
--    another organization's account or one that does not exist.
-- 2. A cost input for one space names a space of the input's own facility (target: the
--    facility-scoped key of 0301_scheduling_facility_scoped_keys.sql).

alter table report_runs
  add constraint report_runs_requested_by_account_fk
    foreign key (organization_id, requested_by_account_id) references accounts (organization_id, id),
  add constraint report_runs_requested_by_person_fk
    foreign key (organization_id, requested_by_person_id) references persons (organization_id, id);

alter table exports
  add constraint exports_requested_by_account_fk
    foreign key (organization_id, requested_by_account_id) references accounts (organization_id, id),
  add constraint exports_requested_by_person_fk
    foreign key (organization_id, requested_by_person_id) references persons (organization_id, id);

alter table cost_inputs
  add constraint cost_inputs_approved_by_person_fk
    foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  add constraint cost_inputs_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id);
