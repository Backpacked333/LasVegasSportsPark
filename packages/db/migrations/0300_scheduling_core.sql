-- 0300_scheduling_core.sql
-- Scheduling module (specification §3.7 SPK-SCHED-001..009, §3.8 SPK-FIX-005, §4.4 Scheduling,
-- §4.5 "Resource must express physical overlap and configurations", §4.7 invariant 4).
--
-- Physical model (SPK-SCHED-001/002): a facility owns resources (whole pitches, subdivisions,
-- rooms). Every resource maps to one or more conflict units, the atomic physical areas. A whole
-- pitch maps to all units of its subdivisions; a subdivision maps to its own unit. Reservations
-- occupy conflict units for the occupied interval (scheduled interval ± setup/cleanup buffers,
-- SPK-SCHED-003). The GiST exclusion constraint on reservation_units is the final guarantee that
-- no two active reservations occupy the same unit at the same time (§4.7 invariant 4, SPK-AT-008).

-- ---------------------------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------------------------

create table resources (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  kind text not null check (kind in ('pitch', 'subdivision', 'room', 'other')),
  name text not null,
  parent_resource_id uuid,
  dimensions jsonb not null default '{}'::jsonb,
  compatible_formats text[] not null default '{}',
  default_setup_minutes integer not null default 0 check (default_setup_minutes >= 0),
  default_cleanup_minutes integer not null default 0 check (default_cleanup_minutes >= 0),
  required_equipment jsonb not null default '[]'::jsonb,
  staffing_constraints jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'restricted', 'closed')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, facility_id, name),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, parent_resource_id) references resources (organization_id, id),
  -- a subdivision is always part of a whole space (SPK-SCHED-001 whole-space/subdivision relationships)
  check (kind <> 'subdivision' or parent_resource_id is not null),
  check (parent_resource_id is null or parent_resource_id <> id)
);
create index resources_facility_idx on resources (organization_id, facility_id, status);
create index resources_parent_idx on resources (organization_id, parent_resource_id)
  where parent_resource_id is not null;
create trigger resources_touch before update on resources
  for each row execute function touch_updated_at();

-- A configuration names a physical arrangement: the set of resources that may operate
-- simultaneously (SPK-SCHED-002 "only when the configured physical arrangement permits it").
create table resource_configurations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  name text not null,
  description text,
  active boolean not null default true,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, facility_id, name),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create trigger resource_configurations_touch before update on resource_configurations
  for each row execute function touch_updated_at();

create table resource_configuration_members (
  organization_id uuid not null references organizations(id),
  configuration_id uuid not null,
  resource_id uuid not null,
  primary key (organization_id, configuration_id, resource_id),
  foreign key (organization_id, configuration_id) references resource_configurations (organization_id, id) on delete cascade,
  foreign key (organization_id, resource_id) references resources (organization_id, id)
);

-- Atomic physical areas. Overlap between resources is expressed only through shared units.
create table conflict_units (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, facility_id, name),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create trigger conflict_units_touch before update on conflict_units
  for each row execute function touch_updated_at();

create table resource_conflict_units (
  organization_id uuid not null references organizations(id),
  resource_id uuid not null,
  conflict_unit_id uuid not null,
  primary key (organization_id, resource_id, conflict_unit_id),
  foreign key (organization_id, resource_id) references resources (organization_id, id) on delete cascade,
  foreign key (organization_id, conflict_unit_id) references conflict_units (organization_id, id)
);
create index resource_conflict_units_unit_idx on resource_conflict_units (organization_id, conflict_unit_id);

-- Local operating windows per weekday (0 = Sunday … 6 = Saturday) for a resource, or for the
-- whole facility when resource_id is null. Times are facility-local (facilities.timezone).
create table operating_hours (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id) on delete cascade,
  check (opens_at < closes_at)
);
create unique index operating_hours_window_idx
  on operating_hours (organization_id, facility_id, coalesce(resource_id, facility_id), weekday, opens_at);
create trigger operating_hours_touch before update on operating_hours
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Closures (SPK-SCHED-009, SPK-FAC-003/004/005)
-- ---------------------------------------------------------------------------------------------

create table closures (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid,                                   -- null = whole facility
  during tstzrange not null check (not isempty(during)),
  reason text not null,
  source text not null check (source in ('manual', 'maintenance', 'holiday')),
  status text not null default 'pending' check (status in ('pending', 'active', 'lifted', 'withdrawn')),
  created_by jsonb not null,
  impact jsonb,                                       -- preview captured when created / applied
  resolution jsonb,                                   -- how affected records were handled on apply
  applied_at timestamptz,
  lifted_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id)
);
create index closures_during_idx on closures using gist (organization_id, facility_id, during)
  where status in ('pending', 'active');
create trigger closures_touch before update on closures
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Series and events (SPK-SCHED-007/008)
-- ---------------------------------------------------------------------------------------------

-- A series stores the recurrence rule in facility-local wall-clock time plus the IANA zone. Each
-- materialized occurrence records how a nonexistent or ambiguous local time was resolved.
create table event_series (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  kind text not null check (kind in ('game', 'practice', 'session', 'rental', 'party', 'pickup', 'maintenance', 'block')),
  title text not null,
  timezone text not null,
  recurrence jsonb not null,                          -- { frequency, interval, byWeekday, startDate, until | count }
  local_start_time time not null,
  duration_minutes integer not null check (duration_minutes > 0),
  setup_minutes integer not null default 0 check (setup_minutes >= 0),
  cleanup_minutes integer not null default 0 check (cleanup_minutes >= 0),
  nonexistent_policy text not null default 'shift_forward' check (nonexistent_policy in ('shift_forward', 'skip')),
  ambiguous_policy text not null default 'first' check (ambiguous_policy in ('first', 'second')),
  exceptions jsonb not null default '[]'::jsonb,      -- local dates excluded from the series
  resource_ids uuid[] not null default '{}',
  commitments jsonb not null default '[]'::jsonb,
  source_type text,
  source_id uuid,
  status text not null default 'active' check (status in ('active', 'ended')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create trigger event_series_touch before update on event_series
  for each row execute function touch_updated_at();

create table events (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  kind text not null check (kind in ('game', 'practice', 'session', 'rental', 'party', 'pickup', 'maintenance', 'block')),
  title text not null,
  format text,
  series_id uuid,
  occurrence_index integer,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  timezone text not null,                             -- IANA zone copied from the facility (SPK-SCHED-008)
  setup_minutes integer not null default 0 check (setup_minutes >= 0),
  cleanup_minutes integer not null default 0 check (cleanup_minutes >= 0),
  dst_resolution text not null default 'exact' check (dst_resolution in ('exact', 'shifted_forward', 'first', 'second')),
  status text not null default 'draft' check (status in ('draft', 'published', 'canceled')),
  published_revision integer,
  revision integer not null default 1,
  -- requested allocation; the held allocation of a published event lives in reservations/event_commitments
  resource_ids uuid[] not null default '{}',
  commitments jsonb not null default '[]'::jsonb,
  source_type text,
  source_id uuid,
  canceled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, series_id) references event_series (organization_id, id),
  check (scheduled_start < scheduled_end),
  check ((series_id is null) = (occurrence_index is null)),
  check (status <> 'published' or published_revision is not null)
);
-- Stable identity per occurrence: a series never materializes the same occurrence twice (SPK-SCHED-007).
create unique index events_series_occurrence_idx on events (organization_id, series_id, occurrence_index)
  where series_id is not null;
create index events_facility_time_idx on events (organization_id, facility_id, scheduled_start);
create index events_source_idx on events (organization_id, source_type, source_id) where source_id is not null;
create trigger events_touch before update on events
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Reservations (§4.7 invariant 4)
-- ---------------------------------------------------------------------------------------------

create table reservations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  event_id uuid not null,
  resource_id uuid not null,
  occupied tstzrange not null check (not isempty(occupied)),  -- scheduled interval ± buffers (SPK-SCHED-003)
  status text not null default 'active' check (status in ('active', 'released')),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, event_id) references events (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id),
  check ((status = 'released') = (released_at is not null))
);
create index reservations_event_idx on reservations (organization_id, event_id);
create index reservations_resource_idx on reservations using gist (organization_id, resource_id, occupied)
  where status = 'active';
create trigger reservations_touch before update on reservations
  for each row execute function touch_updated_at();

-- One row per (reservation, conflict unit). The exclusion constraint is the database-level
-- guarantee of SPK-SCHED-002/003: a whole pitch conflicts with every overlapping subdivision
-- because they share units; two halves never share a unit and may run simultaneously.
create table reservation_units (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  reservation_id uuid not null,
  event_id uuid not null,
  conflict_unit_id uuid not null,
  occupied tstzrange not null check (not isempty(occupied)),
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, reservation_id) references reservations (organization_id, id),
  foreign key (organization_id, event_id) references events (organization_id, id),
  foreign key (organization_id, conflict_unit_id) references conflict_units (organization_id, id),
  constraint reservation_units_no_overlap
    exclude using gist (organization_id with =, conflict_unit_id with =, occupied with &&)
    where (status = 'active')
);
create index reservation_units_reservation_idx on reservation_units (organization_id, reservation_id);
create index reservation_units_event_idx on reservation_units (organization_id, event_id);
create trigger reservation_units_touch before update on reservation_units
  for each row execute function touch_updated_at();

-- Parties (teams, people such as officials and coaches, equipment) cannot be committed to two
-- overlapping events (SPK-SCHED-004). The occupied interval is the scheduled interval.
create table event_commitments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  event_id uuid not null,
  party_type text not null check (party_type in ('team', 'person', 'equipment')),
  party_id uuid not null,
  role text not null default 'participant',
  occupied tstzrange not null check (not isempty(occupied)),
  status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, event_id) references events (organization_id, id),
  constraint event_commitments_no_overlap
    exclude using gist (organization_id with =, party_type with =, party_id with =, occupied with &&)
    where (status = 'active')
);
create index event_commitments_event_idx on event_commitments (organization_id, event_id);
create trigger event_commitments_touch before update on event_commitments
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Drafts and publication (SPK-SCHED-005/006)
-- ---------------------------------------------------------------------------------------------

create table schedule_drafts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  name text not null,
  base_revision jsonb not null,                       -- { capturedAt, eventRevisions: { eventId: revision } }
  author jsonb not null,
  status text not null default 'editing' check (status in ('editing', 'validated', 'publishing', 'published', 'failed', 'discarded')),
  last_saved_at timestamptz not null default now(),
  validation_results jsonb,
  validated_at timestamptz,
  published_at timestamptz,
  publication_group_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create index schedule_drafts_facility_idx on schedule_drafts (organization_id, facility_id, status);
create trigger schedule_drafts_touch before update on schedule_drafts
  for each row execute function touch_updated_at();

create table draft_changes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  draft_id uuid not null,
  sequence integer not null check (sequence >= 1),
  kind text not null check (kind in ('create', 'move', 'cancel', 'resize', 'resource_change')),
  target_event_id uuid,
  base_event_revision integer,
  proposed jsonb not null default '{}'::jsonb,        -- proposed event fields and commitments
  proposed_resource_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, draft_id, sequence),
  foreign key (organization_id, draft_id) references schedule_drafts (organization_id, id) on delete cascade,
  foreign key (organization_id, target_event_id) references events (organization_id, id),
  check (kind = 'create' or target_event_id is not null),
  check ((target_event_id is null) = (base_event_revision is null))
);

-- Publication groups are facts: append-only (§4.7 invariant 9).
create table publications (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  draft_id uuid not null,
  actor jsonb not null,
  committed_at timestamptz not null,
  event_ids uuid[] not null default '{}',
  notice_event_ids uuid[] not null default '{}',
  summary jsonb not null default '{}'::jsonb,
  operation_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, draft_id) references schedule_drafts (organization_id, id)
);
create index publications_draft_idx on publications (organization_id, draft_id);
create trigger publications_append_only before update or delete on publications
  for each row execute function forbid_mutation();
