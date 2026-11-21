-- 0975_facilities_field_preparations.sql
-- Facilities module: the field crew's daily preparation of a pitch (SPK-FAC-001 maintainable
-- spaces, SPK-UX-006 readiness and escalation, SPK-READY-001 "field" readiness check; staff
-- redesign Phase 8 "Field crew · Fields").
--
-- Before a pitch's first use of the facility-local day the crew ticks a fixed checklist (lines
-- marked, goals anchored, nets up, corner flags out) and marks the pitch ready. One record per
-- pitch and local day. A ready record always carries every item and who marked it ready and when;
-- unticking an item after that reopens the record (status back to in_progress, the ready facts
-- cleared). The application lifecycle is FieldPreparationMachine (facilities.state-machines.ts);
-- the checks below list the same states and are the guarantee.

create table field_preparations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid not null,
  local_date date not null,
  checked_items text[] not null default '{}'
    check (checked_items <@ array['lines', 'goals_anchored', 'nets', 'corner_flags']::text[]),
  status text not null default 'in_progress' check (status in ('in_progress', 'ready')),
  ready_at timestamptz,
  ready_by jsonb,
  ready_by_person_id uuid,
  updated_by jsonb not null,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- one preparation per pitch and facility-local day
  unique (organization_id, resource_id, local_date),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  -- the pitch belongs to the record's facility (facility-scoped key, migration 0301)
  foreign key (organization_id, facility_id, resource_id)
    references resources (organization_id, facility_id, id),
  foreign key (organization_id, ready_by_person_id) references persons (organization_id, id),
  -- ready exactly when the ready facts are recorded
  constraint field_preparations_ready_facts
    check ((status = 'ready') = (ready_at is not null and ready_by is not null)),
  -- a pitch is ready only with every checklist item ticked
  constraint field_preparations_ready_complete
    check (
      status <> 'ready'
      or checked_items @> array['lines', 'goals_anchored', 'nets', 'corner_flags']::text[]
    )
);
create index field_preparations_facility_day_idx
  on field_preparations (organization_id, facility_id, local_date);

create trigger field_preparations_touch before update on field_preparations
  for each row execute function touch_updated_at();
