-- 0902_facilities_facility_scoped_keys.sql
-- Facilities module: facility boundaries enforced by the database (§4.3 facility boundaries,
-- §4.7 "integrity that matters is enforced in the database", CLAUDE.md composite foreign keys).
-- Authorization is facility-scoped (`facilityId` in the target), so an asset, task, preventive
-- schedule or restriction of facility A must never name a space, asset, task, schedule or closure
-- of facility B: a restriction with that mismatch would close facility B's pitch under facility
-- A's authority. The services check the facility first (restrictions.service, assets.service,
-- maintenance-tasks.service); these keys are the guarantee. Migration 0900 is applied and
-- immutable. The scheduling targets (resources, closures) gained their facility-scoped keys in 0301.

alter table assets
  add constraint assets_facility_scoped_key unique (organization_id, facility_id, id),
  add constraint assets_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id);

alter table preventive_schedules
  add constraint preventive_schedules_facility_scoped_key unique (organization_id, facility_id, id),
  add constraint preventive_schedules_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id),
  add constraint preventive_schedules_asset_same_facility
    foreign key (organization_id, facility_id, asset_id)
    references assets (organization_id, facility_id, id);

alter table maintenance_tasks
  add constraint maintenance_tasks_facility_scoped_key unique (organization_id, facility_id, id),
  add constraint maintenance_tasks_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id),
  add constraint maintenance_tasks_asset_same_facility
    foreign key (organization_id, facility_id, asset_id)
    references assets (organization_id, facility_id, id),
  add constraint maintenance_tasks_schedule_same_facility
    foreign key (organization_id, facility_id, preventive_schedule_id)
    references preventive_schedules (organization_id, facility_id, id);

alter table restrictions
  add constraint restrictions_resource_same_facility
    foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id),
  add constraint restrictions_asset_same_facility
    foreign key (organization_id, facility_id, asset_id)
    references assets (organization_id, facility_id, id),
  add constraint restrictions_task_same_facility
    foreign key (organization_id, facility_id, task_id)
    references maintenance_tasks (organization_id, facility_id, id),
  add constraint restrictions_schedule_same_facility
    foreign key (organization_id, facility_id, preventive_schedule_id)
    references preventive_schedules (organization_id, facility_id, id),
  add constraint restrictions_closure_same_facility
    foreign key (organization_id, facility_id, scheduling_closure_id)
    references closures (organization_id, facility_id, id);
