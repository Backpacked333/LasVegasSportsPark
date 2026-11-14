-- 0305_scheduling_facility_public_views.sql
-- Public and lobby schedule views (SPK-SCHED-010, proposed amendment PA-06; capability
-- `public_schedule`, DEC-100). A facility's day schedule is readable without sign-in only while a
-- permitted staff member has enabled its public view. The view is addressed by a random public
-- code, never by the facility's id: the code is the only identifier a public answer is reached
-- through, and it opens no private record. Disabling keeps the row and its history of who
-- enabled and disabled it; enabling again issues the same code unless staff ask for a new one.
create table facility_public_views (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  public_code text not null check (public_code ~ '^[a-z0-9]{16,40}$'),
  enabled boolean not null default true,
  enabled_at timestamptz not null,
  enabled_by jsonb not null,
  disabled_at timestamptz,
  disabled_by jsonb,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- one public view per facility
  unique (organization_id, facility_id),
  -- a code names one view
  unique (public_code),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  constraint facility_public_views_disabled_fact check (enabled = (disabled_at is null)),
  constraint facility_public_views_disabler_fact check ((disabled_at is null) = (disabled_by is null))
);
create trigger facility_public_views_touch before update on facility_public_views
  for each row execute function touch_updated_at();
