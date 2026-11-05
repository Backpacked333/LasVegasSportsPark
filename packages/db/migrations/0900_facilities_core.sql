-- 0900_facilities_core.sql
-- Facilities module (specification §3.17 SPK-FAC-001..005, §4.4 Facilities: Asset, MaintenanceTask,
-- Inspection, Restriction; SPK-AT-021).
--
-- A restriction names the affected physical area (a scheduling resource: a whole pitch or one
-- subdivision). Approving it creates a scheduling closure through the scheduling module's closure
-- port — this module never writes scheduling tables — and the closure is what makes availability
-- reject bookings on the area's conflict units (SPK-FAC-003). Returning the area to service is a
-- separate, authorized release that lifts the closure (SPK-FAC-004). Inspections are append-only
-- observations. Preventive schedules materialize future tasks and restrictions through the same
-- path (SPK-FAC-005).

-- ---------------------------------------------------------------------------------------------
-- Assets (SPK-FAC-001)
-- ---------------------------------------------------------------------------------------------

create table assets (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid,                                   -- the space the asset belongs to, when any
  kind text not null check (kind in ('turf', 'goal', 'net', 'boards', 'divider', 'lighting', 'scoreboard', 'equipment', 'other')),
  name text not null,
  identifier text,                                    -- tag / serial number
  attributes jsonb not null default '{}'::jsonb,
  status text not null default 'in_service' check (status in ('in_service', 'restricted', 'out_of_service', 'retired')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id)
);
-- An identifier (tag, serial) names at most one non-retired asset per facility.
create unique index assets_identifier_idx on assets (organization_id, facility_id, identifier)
  where identifier is not null and status <> 'retired';
create index assets_facility_idx on assets (organization_id, facility_id, status);
create index assets_resource_idx on assets (organization_id, resource_id) where resource_id is not null;
create trigger assets_touch before update on assets
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Preventive schedules (SPK-FAC-005) — created before tasks/restrictions so they can reference it
-- ---------------------------------------------------------------------------------------------

create table preventive_schedules (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid not null,                          -- affected physical area of every occurrence
  asset_id uuid,
  name text not null,
  recurrence jsonb not null,                          -- { frequency, interval, byWeekday, startDate, until | count }
  local_start_time time not null,
  duration_minutes integer not null check (duration_minutes > 0),
  timezone text not null,                             -- IANA zone copied from the facility (SPK-SCHED-008)
  task_template jsonb not null,                       -- { issue, severity, requiresInspection, assignedOwnerPersonId }
  restriction_kind text not null check (restriction_kind in ('closed', 'limited')),
  lead_time_days integer not null check (lead_time_days >= 0),
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  last_generated_at timestamptz,
  last_generated_through timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id),
  foreign key (organization_id, asset_id) references assets (organization_id, id)
);
create index preventive_schedules_facility_idx on preventive_schedules (organization_id, facility_id, status);
create trigger preventive_schedules_touch before update on preventive_schedules
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Maintenance tasks (SPK-FAC-002)
-- ---------------------------------------------------------------------------------------------

create table maintenance_tasks (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  asset_id uuid,
  resource_id uuid,
  issue text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  reporter jsonb not null,                            -- actor snapshot (never child information)
  reported_at timestamptz not null,
  evidence jsonb not null default '[]'::jsonb,        -- references only (storage keys, links); never binary content
  assigned_owner_person_id uuid,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'resolved', 'closed')),
  requires_inspection boolean not null default false,
  resolution jsonb,
  resolved_at timestamptz,
  closed_at timestamptz,
  preventive_schedule_id uuid,
  occurrence_index integer,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, asset_id) references assets (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id),
  foreign key (organization_id, preventive_schedule_id) references preventive_schedules (organization_id, id),
  -- a maintenance record names an asset or a space (SPK-FAC-002)
  check (asset_id is not null or resource_id is not null),
  -- 'assigned' means an owner is recorded
  check (status <> 'assigned' or assigned_owner_person_id is not null),
  -- resolution and its instant travel with the resolved/closed states
  check ((status in ('resolved', 'closed')) = (resolved_at is not null)),
  check (status not in ('resolved', 'closed') or resolution is not null),
  check ((status = 'closed') = (closed_at is not null)),
  check ((preventive_schedule_id is null) = (occurrence_index is null))
);
-- A preventive schedule materializes each occurrence's task at most once.
create unique index maintenance_tasks_occurrence_idx
  on maintenance_tasks (organization_id, preventive_schedule_id, occurrence_index)
  where preventive_schedule_id is not null;
create index maintenance_tasks_facility_idx on maintenance_tasks (organization_id, facility_id, status, reported_at desc);
create index maintenance_tasks_due_idx on maintenance_tasks (organization_id, due_at)
  where status not in ('resolved', 'closed') and due_at is not null;
create index maintenance_tasks_asset_idx on maintenance_tasks (organization_id, asset_id) where asset_id is not null;
create trigger maintenance_tasks_touch before update on maintenance_tasks
  for each row execute function touch_updated_at();

-- Inspections are observations: append-only, corrections are new rows (SPK-FAC-002/004).
create table inspections (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  task_id uuid not null,
  inspector jsonb not null,                           -- actor snapshot
  outcome text not null check (outcome in ('passed', 'failed')),
  notes text,
  inspected_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, task_id) references maintenance_tasks (organization_id, id)
);
create index inspections_task_idx on inspections (organization_id, task_id, inspected_at desc);
create trigger inspections_append_only before update or delete on inspections
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Operating restrictions (SPK-FAC-003/004, SPK-AT-021)
-- ---------------------------------------------------------------------------------------------

create table restrictions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid not null,                          -- affected physical area (whole pitch or subdivision)
  asset_id uuid,
  task_id uuid,
  preventive_schedule_id uuid,
  occurrence_index integer,
  kind text not null check (kind in ('closed', 'limited')),
  during tstzrange not null check (not isempty(during)),
  reason text not null,
  -- conflict units of the area as derived from scheduling when the restriction was activated
  affected_conflict_unit_ids uuid[] not null default '{}',
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'active', 'released')),
  approved_by jsonb,
  approved_at timestamptz,
  scheduling_closure_id uuid,                         -- the closure created through the scheduling authority
  released_by jsonb,
  released_at timestamptz,
  release_reason text,
  operation_id uuid,                                  -- last multi-step operation (approve / release)
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id),
  foreign key (organization_id, asset_id) references assets (organization_id, id),
  foreign key (organization_id, task_id) references maintenance_tasks (organization_id, id),
  foreign key (organization_id, preventive_schedule_id) references preventive_schedules (organization_id, id),
  foreign key (organization_id, scheduling_closure_id) references closures (organization_id, id),
  -- approval facts travel with every state after 'proposed'
  check ((status = 'proposed') = (approved_at is null)),
  check ((approved_at is null) = (approved_by is null)),
  -- an active restriction is backed by a scheduling closure (SPK-FAC-003)
  check (status <> 'active' or scheduling_closure_id is not null),
  -- a release is an authorized, recorded act (SPK-FAC-004)
  check ((status = 'released') = (released_at is not null)),
  check ((released_at is null) = (released_by is null)),
  check (status <> 'released' or scheduling_closure_id is not null),
  check ((preventive_schedule_id is null) = (occurrence_index is null))
);
-- One scheduling closure backs at most one restriction.
create unique index restrictions_closure_idx on restrictions (organization_id, scheduling_closure_id)
  where scheduling_closure_id is not null;
-- A maintenance record carries at most one unreleased operating restriction (SPK-FAC-002).
create unique index restrictions_open_task_idx on restrictions (organization_id, task_id)
  where task_id is not null and status <> 'released';
-- A preventive schedule materializes each occurrence's restriction at most once (SPK-FAC-005).
create unique index restrictions_occurrence_idx
  on restrictions (organization_id, preventive_schedule_id, occurrence_index)
  where preventive_schedule_id is not null;
create index restrictions_area_idx on restrictions using gist (organization_id, resource_id, during)
  where status in ('approved', 'active');
create index restrictions_facility_idx on restrictions (organization_id, facility_id, status);
create trigger restrictions_touch before update on restrictions
  for each row execute function touch_updated_at();
