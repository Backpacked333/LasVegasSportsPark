-- 1303_reporting_requirement_retirement.sql
-- Reporting module (REP-03; WRK-02, IF-32; SPK-STAFF-002, SPK-REPORT-002): a staffing requirement
-- whose activity was withdrawn is retired by the workforce module (`assignment_requirements
-- .retired_at`, workforce migration 0704) and never counts in coverage, exceptions, Today or
-- reporting. The uncovered-assignments report reads requirements through
-- `reporting_assignment_requirements_v`, which gains `retired_at` so the report skips retired ones.
--
-- Migration 1300 is applied and immutable; `create or replace view` keeps the view's columns and
-- its read-only trigger and only appends a column.
--
-- The workforce migration that adds the column is built in parallel with this one, and migrations
-- are applied in version order but also when they arrive later (a pending lower version is still
-- applied). `retired_at` is therefore read from the whole row (`to_jsonb(ar)`), which PostgreSQL
-- evaluates against the table's columns at query time: before the column exists the view reports
-- every requirement as in force (null), and from the moment it exists the view reports it, in
-- whichever order the two migrations were applied. The view stays read-only (no write path).

create or replace view reporting_assignment_requirements_v as
  select ar.id as requirement_id, ar.organization_id, ar.facility_id, ar.target_type, ar.target_id,
         ar.kind, ar.role, ar.required_count, ar.must_be_accepted,
         coalesce(fe.scheduled_start, f.scheduled_start, e.scheduled_start, s.scheduled_start) as target_start,
         coalesce(fe.title, e.title, o.name) as target_title,
         (to_jsonb(ar) ->> 'retired_at')::timestamptz as retired_at
  from assignment_requirements ar
  left join fixtures f on f.organization_id = ar.organization_id and f.id = ar.fixture_id
  left join events fe on fe.organization_id = f.organization_id and fe.id = f.scheduling_event_id
  left join events e on e.organization_id = ar.organization_id and e.id = ar.scheduling_event_id
  left join offering_sessions s on s.organization_id = ar.organization_id and s.id = ar.offering_session_id
  left join offerings o on o.organization_id = ar.organization_id and o.id = ar.offering_id;
