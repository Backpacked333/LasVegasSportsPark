-- SPK-FAC-002 (a maintenance record names its assigned owner), §4.3 and CLAUDE.md composite
-- foreign keys: the assigned owner is a person of the task's own organization. The facilities
-- service checks the person through the identity person directory first (an active adult); this
-- constraint is the guarantee when the service is bypassed.
alter table maintenance_tasks
  add constraint maintenance_tasks_assigned_owner_person_fkey
  foreign key (organization_id, assigned_owner_person_id) references persons (organization_id, id);

-- GET /v1/maintenance-tasks?assignedOwnerPersonId=…
create index maintenance_tasks_owner_idx on maintenance_tasks (organization_id, assigned_owner_person_id)
  where assigned_owner_person_id is not null;
