-- 1300_reporting_core.sql
-- Reporting module (specification §3.20 SPK-REPORT-001..007, §4.2 "Reporting: derived metrics and
-- exports", §4.4, §4.14 "Expiring exports", §1.2 success measures; docs/package-a/metric-dictionary.md).
--
-- The module owns four tables and is their only writer (§4.2):
--   * metric_definitions — every metric's SPK-REPORT-001 fields as columns, seeded from the
--     TypeScript registry (apps/api/src/modules/reporting/reporting.metrics.ts). A definition is a
--     version: its fields never change; a changed registry entry supersedes the active version
--     with a new one, so a stored report run always cites the exact definition it was produced
--     under (SPK-REPORT-007 "reproducible after corrections").
--   * report_runs (+ report_run_metrics) — append-only stored evaluations: definition versions,
--     parameters, actor, produced-at, row count, the as-of instant the figures are reproducible at,
--     the result snapshot and its SHA-256 digest.
--   * exports — expiring, single-use, requester-bound downloads of a stored run, authorized by a
--     separate export action and audited (SPK-REPORT-007, §4.14).
--   * cost_inputs — agreed direct cost inputs (effective dates, approver) without which no
--     contribution margin is shown (SPK-REPORT-004, metric dictionary rule E4).
--
-- It never writes another module's records. Reads of other modules' records go through the
-- read-only views at the end of this file (reporting_*_v): each exposes only the columns a report
-- needs (no names, contact details or dates of birth of people: §4.14 child data minimization,
-- metric dictionary rule G9) and refuses writes through an INSTEAD OF trigger.

create or replace function reporting_view_read_only() returns trigger
language plpgsql as $$
begin
  raise exception 'view % is read-only: reporting never writes another module''s records', tg_table_name
    using errcode = 'restrict_violation';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Metric definitions (SPK-REPORT-001). One row per (metric, version); exactly one active version
-- per metric and organization. Lifecycle (MetricDefinitionMachine): active → superseded.
-- ---------------------------------------------------------------------------------------------
create table metric_definitions (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  metric_key text not null check (metric_key ~ '^MET-[0-9]{3}$'),
  version integer not null check (version >= 1),
  name text not null check (length(name) between 1 and 200),
  report_keys text[] not null check (cardinality(report_keys) >= 1),
  business_question text not null check (length(business_question) between 1 and 2000),
  grain text not null check (length(grain) between 1 and 500),
  numerator text not null check (length(numerator) between 1 and 2000),
  denominator text not null check (length(denominator) between 1 and 2000),
  time_basis text not null check (length(time_basis) between 1 and 1000),
  exclusions text[] not null,
  dimensions text[] not null,
  currency text not null check (currency in ('none', 'minor_units')),
  freshness text not null check (freshness in ('F1', 'F2', 'F3')),
  access_scope text not null check (access_scope ~ '^reporting\.[a-z_]+$'),
  unit text not null check (unit in ('count', 'hours', 'ratio', 'minor_units', 'minutes')),
  requirement_ids text[] not null check (cardinality(requirement_ids) >= 1),
  pending_decisions text[] not null default '{}',
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'superseded')),
  recorded_at timestamptz not null,
  superseded_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, metric_key, version),
  constraint metric_definitions_superseded_fact check ((status = 'superseded') = (superseded_at is not null)),
  check (superseded_at is null or superseded_at >= recorded_at)
);
create unique index metric_definitions_one_active_idx on metric_definitions (organization_id, metric_key)
  where status = 'active';
create trigger metric_definitions_touch before update on metric_definitions
  for each row execute function touch_updated_at();
create trigger metric_definitions_no_delete before delete on metric_definitions
  for each row execute function forbid_mutation();

create or replace function metric_definitions_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.metric_key <> old.metric_key
     or new.version <> old.version
     or new.name <> old.name
     or new.report_keys <> old.report_keys
     or new.business_question <> old.business_question
     or new.grain <> old.grain
     or new.numerator <> old.numerator
     or new.denominator <> old.denominator
     or new.time_basis <> old.time_basis
     or new.exclusions <> old.exclusions
     or new.dimensions <> old.dimensions
     or new.currency <> old.currency
     or new.freshness <> old.freshness
     or new.access_scope <> old.access_scope
     or new.unit <> old.unit
     or new.requirement_ids <> old.requirement_ids
     or new.pending_decisions <> old.pending_decisions
     or new.definition_hash <> old.definition_hash
     or new.recorded_at <> old.recorded_at then
    raise exception 'metric definition % version % is immutable: record a new version', old.metric_key, old.version
      using errcode = 'check_violation', constraint = 'metric_definitions_immutable';
  end if;
  if new.status = old.status then
    if new.superseded_at is distinct from old.superseded_at then
      raise exception 'metric definition % superseded instant is a fact', old.id
        using errcode = 'check_violation', constraint = 'metric_definitions_machine';
    end if;
    return new;
  end if;
  if old.status = 'active' and new.status = 'superseded' then
    return new;
  end if;
  raise exception 'metric definition % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'metric_definitions_machine';
end
$$;
create trigger metric_definitions_guard before update on metric_definitions
  for each row execute function metric_definitions_guard();

-- ---------------------------------------------------------------------------------------------
-- Report runs (SPK-REPORT-007): append-only. `reproducible_as_of` is the instant the figures were
-- evaluated at; the stored result and its digest are the reproducible record. A reproduction is a
-- new run that names the run it reproduces and whether the digests matched.
-- ---------------------------------------------------------------------------------------------
create table report_runs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid,
  report_key text not null check (report_key ~ '^[a-z][a-z_]{0,63}$'),
  parameters jsonb not null check (jsonb_typeof(parameters) = 'object'),
  reproducible_as_of timestamptz not null,
  produced_at timestamptz not null,
  point_in_time text not null check (point_in_time in ('full', 'partial', 'none')),
  access_action text not null check (access_action ~ '^reporting\.[a-z_]+$'),
  requested_by jsonb not null,
  requested_by_account_id uuid,
  requested_by_person_id uuid,
  row_count integer not null check (row_count >= 0),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  result_digest text not null check (result_digest ~ '^[0-9a-f]{64}$'),
  reproduces_run_id uuid,
  reproduction_matched boolean,
  correlation_id text,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, reproduces_run_id) references report_runs (organization_id, id),
  constraint report_runs_as_of_not_future check (reproducible_as_of <= produced_at),
  constraint report_runs_reproduction_fact check ((reproduces_run_id is null) = (reproduction_matched is null)),
  constraint report_runs_row_count check (
    jsonb_typeof(result -> 'rows') = 'array' and jsonb_array_length(result -> 'rows') = row_count
  )
);
create index report_runs_report_idx on report_runs (organization_id, report_key, produced_at desc);
create index report_runs_requester_idx on report_runs (organization_id, requested_by_account_id, produced_at desc);
create trigger report_runs_append_only before update or delete on report_runs
  for each row execute function forbid_mutation();

-- The exact metric definition versions a run was produced under.
create table report_run_metrics (
  organization_id uuid not null references organizations(id),
  report_run_id uuid not null,
  metric_definition_id uuid not null,
  primary key (organization_id, report_run_id, metric_definition_id),
  foreign key (organization_id, report_run_id) references report_runs (organization_id, id),
  foreign key (organization_id, metric_definition_id) references metric_definitions (organization_id, id)
);
create trigger report_run_metrics_append_only before update or delete on report_run_metrics
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Exports (SPK-REPORT-007, §4.14 "Expiring exports"). An export is a requester-bound, single-use
-- download of one stored run, authorized by its own export action (independent of the right to
-- view the report) and audited at creation, download, revocation and expiry. Only the SHA-256 of
-- the one-time download token is stored. Lifecycle (ExportMachine):
--   ready → downloaded | expired | revoked; every other state is final.
-- The database refuses a download recorded at or after the expiry instant.
-- ---------------------------------------------------------------------------------------------
create table exports (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  report_run_id uuid not null,
  report_key text not null check (report_key ~ '^[a-z][a-z_]{0,63}$'),
  format text not null check (format in ('csv', 'json')),
  authorized_action text not null check (authorized_action in ('reporting.export_operational', 'reporting.export_financial')),
  requested_by jsonb not null,
  requested_by_account_id uuid not null,
  requested_by_person_id uuid,
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  download_token_hash text not null check (download_token_hash ~ '^[0-9a-f]{64}$'),
  row_count integer not null check (row_count >= 0),
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  status text not null default 'ready' check (status in ('ready', 'downloaded', 'expired', 'revoked')),
  downloaded_at timestamptz,
  downloaded_by jsonb,
  expired_at timestamptz,
  revoked_at timestamptz,
  revoked_by jsonb,
  revoke_reason text check (revoke_reason is null or length(revoke_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (download_token_hash),
  foreign key (organization_id, report_run_id) references report_runs (organization_id, id),
  constraint exports_expiry_after_request check (expires_at > requested_at),
  constraint exports_downloaded_fact check (
    (status = 'downloaded') = (downloaded_at is not null and downloaded_by is not null)
  ),
  constraint exports_download_before_expiry check (
    downloaded_at is null or (downloaded_at >= requested_at and downloaded_at < expires_at)
  ),
  constraint exports_expired_fact check ((status = 'expired') = (expired_at is not null)),
  constraint exports_expired_after_expiry check (expired_at is null or expired_at >= expires_at),
  constraint exports_revoked_fact check (
    (status = 'revoked') = (revoked_at is not null and revoked_by is not null and revoke_reason is not null)
  )
);
create index exports_requester_idx on exports (organization_id, requested_by_account_id, requested_at desc);
create index exports_ready_expiry_idx on exports (expires_at) where status = 'ready';
create trigger exports_touch before update on exports
  for each row execute function touch_updated_at();
create trigger exports_no_delete before delete on exports
  for each row execute function forbid_mutation();

create or replace function exports_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.report_run_id <> old.report_run_id
     or new.report_key <> old.report_key
     or new.format <> old.format
     or new.authorized_action <> old.authorized_action
     or new.requested_by <> old.requested_by
     or new.requested_by_account_id <> old.requested_by_account_id
     or new.requested_by_person_id is distinct from old.requested_by_person_id
     or new.requested_at <> old.requested_at
     or new.expires_at <> old.expires_at
     or new.download_token_hash <> old.download_token_hash
     or new.row_count <> old.row_count
     or new.content_digest <> old.content_digest then
    raise exception 'export % request, expiry, token and content are immutable', old.id
      using errcode = 'check_violation', constraint = 'exports_immutable';
  end if;
  if new.status = old.status then
    if old.status <> 'ready' then
      raise exception 'export % is % and final', old.id, old.status
        using errcode = 'check_violation', constraint = 'exports_machine';
    end if;
    return new;
  end if;
  if old.status = 'ready' and new.status in ('downloaded', 'expired', 'revoked') then
    return new;
  end if;
  raise exception 'export % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'exports_machine';
end
$$;
create trigger exports_guard before update on exports
  for each row execute function exports_guard();

-- ---------------------------------------------------------------------------------------------
-- Agreed cost inputs (SPK-REPORT-004, metric dictionary rule E4, DEC-085). A cost per activity hour
-- for a facility or one space, with effective dates and the approving actor. Inputs never overlap
-- for the same scope, basis and currency (an ambiguous input could not be agreed). Lifecycle
-- (CostInputMachine): active → withdrawn; amounts and dates are immutable.
-- ---------------------------------------------------------------------------------------------
create table cost_inputs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  resource_id uuid,
  scope_id uuid generated always as (coalesce(resource_id, facility_id)) stored,
  basis text not null check (basis in ('per_activity_hour')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from date not null,
  effective_to date,
  effective daterange generated always as (daterange(effective_from, effective_to, '[)')) stored,
  description text not null check (length(description) between 1 and 500),
  approval_reference text not null check (length(approval_reference) between 1 and 200),
  approved_by jsonb not null,
  approved_by_person_id uuid,
  recorded_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  withdrawn_by jsonb,
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, resource_id) references resources (organization_id, id),
  check (effective_to is null or effective_to > effective_from),
  constraint cost_inputs_withdrawn_fact check (
    (status = 'withdrawn') = (withdrawn_at is not null and withdrawn_by is not null and withdrawn_reason is not null)
  ),
  constraint cost_inputs_no_overlap exclude using gist (
    organization_id with =, scope_id with =, basis with =, currency with =, effective with &&
  ) where (status = 'active')
);
create index cost_inputs_facility_idx on cost_inputs (organization_id, facility_id, status);
create trigger cost_inputs_touch before update on cost_inputs
  for each row execute function touch_updated_at();
create trigger cost_inputs_no_delete before delete on cost_inputs
  for each row execute function forbid_mutation();

create or replace function cost_inputs_guard() returns trigger
language plpgsql as $$
begin
  if new.organization_id <> old.organization_id
     or new.facility_id <> old.facility_id
     or new.resource_id is distinct from old.resource_id
     or new.basis <> old.basis
     or new.amount_minor <> old.amount_minor
     or new.currency <> old.currency
     or new.effective_from <> old.effective_from
     or new.effective_to is distinct from old.effective_to
     or new.description <> old.description
     or new.approval_reference <> old.approval_reference
     or new.approved_by <> old.approved_by
     or new.recorded_at <> old.recorded_at then
    raise exception 'cost input % is an agreed fact: withdraw it and record a new one', old.id
      using errcode = 'check_violation', constraint = 'cost_inputs_immutable';
  end if;
  if new.status = old.status then
    if old.status = 'withdrawn' then
      raise exception 'cost input % is withdrawn and final', old.id
        using errcode = 'check_violation', constraint = 'cost_inputs_machine';
    end if;
    return new;
  end if;
  if old.status = 'active' and new.status = 'withdrawn' then
    return new;
  end if;
  raise exception 'cost input % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'cost_inputs_machine';
end
$$;
create trigger cost_inputs_guard before update on cost_inputs
  for each row execute function cost_inputs_guard();

-- =============================================================================================
-- Read-only views over other modules' records (§4.2: reporting reads, never writes). Columns are
-- the minimum each report needs; people appear only as identifiers and adult/child kind.
-- =============================================================================================

-- Core and identity ---------------------------------------------------------------------------
create view reporting_persons_v as
  select p.id as person_id, p.organization_id, p.kind as person_kind, p.status as person_status,
         coalesce(p.merged_into_person_id, p.id) as canonical_person_id
  from persons p;

create view reporting_household_members_v as
  select hm.organization_id, hm.household_id, hm.person_id
  from household_memberships hm;

-- Scheduling (SPK-SCHED-001..009) -----------------------------------------------------------------
create view reporting_events_v as
  select e.id as event_id, e.organization_id, e.facility_id, e.kind, e.title, e.format, e.status,
         e.scheduled_start, e.scheduled_end, e.setup_minutes, e.cleanup_minutes, e.timezone,
         e.source_type, e.source_id, e.published_revision, e.canceled_at,
         cardinality(e.resource_ids) as resource_count
  from events e;

create view reporting_conflict_units_v as
  select cu.id as conflict_unit_id, cu.organization_id, cu.facility_id, cu.name as unit_name
  from conflict_units cu;

create view reporting_resource_units_v as
  select r.id as resource_id, r.organization_id, r.facility_id, r.name as resource_name,
         r.kind as resource_kind, r.parent_resource_id, r.status as resource_status,
         rcu.conflict_unit_id
  from resources r
  join resource_conflict_units rcu
    on rcu.organization_id = r.organization_id and rcu.resource_id = r.id;

create view reporting_operating_hours_v as
  select oh.id as window_id, oh.organization_id, oh.facility_id, oh.resource_id, oh.weekday,
         to_char(oh.opens_at, 'HH24:MI') as opens_at, to_char(oh.closes_at, 'HH24:MI') as closes_at
  from operating_hours oh;

create view reporting_closures_v as
  select c.id as closure_id, c.organization_id, c.facility_id, c.resource_id,
         lower(c.during) as starts_at, upper(c.during) as ends_at, c.source, c.status,
         c.applied_at, c.lifted_at
  from closures c;

-- One row per (reservation, conflict unit): the grain that never double-counts physical time (U1).
create view reporting_reserved_units_v as
  select ru.id as reservation_unit_id, ru.organization_id, e.facility_id, ru.conflict_unit_id,
         ru.reservation_id, r.resource_id, ru.event_id, e.kind as event_kind, e.format as event_format,
         e.status as event_status, e.source_type, e.source_id,
         lower(ru.occupied) as occupied_start, upper(ru.occupied) as occupied_end,
         e.scheduled_start, e.scheduled_end, e.setup_minutes, e.cleanup_minutes,
         r.status as reservation_status, r.released_at
  from reservation_units ru
  join reservations r on r.organization_id = ru.organization_id and r.id = ru.reservation_id
  join events e on e.organization_id = ru.organization_id and e.id = ru.event_id;

-- Catalog (SPK-CAT-001) ---------------------------------------------------------------------------
create view reporting_offerings_v as
  select o.id as offering_id, o.organization_id, o.facility_id, o.program_id, o.name as offering_name,
         o.kind as offering_kind, o.format, o.starts_on::text as starts_on, o.ends_on::text as ends_on,
         o.publication_state,
         p.name as program_name, p.format as program_format, p.age_band as program_age_band
  from offerings o
  left join programs p on p.organization_id = o.organization_id and p.id = o.program_id;

create view reporting_sessions_v as
  select s.id as session_id, s.organization_id, s.offering_id, o.facility_id, o.kind as offering_kind,
         s.sequence, s.scheduled_start, s.scheduled_end, s.scheduling_event_id, s.status
  from offering_sessions s
  join offerings o on o.organization_id = s.organization_id and o.id = s.offering_id;

create view reporting_required_forms_v as
  select f.organization_id, f.offering_id, f.policy_version_id
  from offering_required_forms f;

create view reporting_acknowledgments_v as
  select a.id as acknowledgment_id, a.organization_id, a.subject_person_id, a.policy_version_id,
         a.status, a.signed_at, a.withdrawn_at
  from acknowledgments a;

-- Enrollment (SPK-REG-001..009) -------------------------------------------------------------------
create view reporting_enrollments_v as
  select e.id as enrollment_id, e.organization_id, e.offering_id, e.participant_person_id,
         coalesce(p.merged_into_person_id, p.id) as canonical_person_id, p.kind as person_kind,
         e.intent, e.status, e.payer_person_id, e.source_application_id,
         e.confirmed_at, e.canceled_at, e.transferred_at, e.completed_at
  from enrollments e
  join persons p on p.organization_id = e.organization_id and p.id = e.participant_person_id;

create view reporting_session_bookings_v as
  select b.id as booking_id, b.organization_id, b.offering_id, b.session_id, b.participant_person_id,
         coalesce(p.merged_into_person_id, p.id) as canonical_person_id, p.kind as person_kind,
         b.kind, b.status, b.payer_person_id, b.scheduled_start, b.scheduled_end,
         b.confirmed_at, b.canceled_at, b.expired_at
  from session_bookings b
  join persons p on p.organization_id = b.organization_id and p.id = b.participant_person_id;

create view reporting_applications_v as
  select a.id as application_id, a.organization_id, a.offering_id, a.intent, a.status,
         a.requires_approval, a.submitted_at, a.decided_at, a.withdrawn_at
  from applications a;

create view reporting_capacity_pools_v as
  select cp.id as pool_id, cp.organization_id, cp.offering_id, cp.scope_type, cp.unit,
         cp.constraint_kind, cp.capacity, cp.committed, cp.held, cp.status
  from capacity_pools cp;

create view reporting_holds_v as
  select h.id as hold_id, h.organization_id, cp.offering_id, h.status, h.quantity, h.owner_kind,
         h.acquired_at, h.committed_at, h.released_at, h.expired_at
  from holds h
  join capacity_pools cp on cp.organization_id = h.organization_id and cp.id = h.pool_id;

create view reporting_waitlist_entries_v as
  select w.id as waitlist_entry_id, w.organization_id, w.offering_id, w.intent, w.status,
         w.joined_at, w.withdrawn_at, w.removed_at, w.accepted_enrollment_id
  from waitlist_entries w;

create view reporting_waitlist_offers_v as
  select wo.id as waitlist_offer_id, wo.organization_id, we.offering_id, wo.status, wo.offered_at,
         wo.expires_at, wo.accepted_at, wo.declined_at, wo.expired_at
  from waitlist_offers wo
  join waitlist_entries we on we.organization_id = wo.organization_id and we.id = wo.waitlist_entry_id;

-- Competition (SPK-COMP-001..005, SPK-READY-001) --------------------------------------------------
create view reporting_seasons_v as
  select s.id as season_id, s.organization_id, s.competition_id, s.name as season_name,
         s.starts_on::text as starts_on, s.ends_on::text as ends_on, s.status, s.registration_offering_ref
  from seasons s;

create view reporting_team_entries_v as
  select te.id as team_entry_id, te.organization_id, te.season_id, te.division_id, te.team_id,
         d.facility_id, te.status, te.approved_at, s.status as season_status,
         s.starts_on::text as season_starts_on, s.ends_on::text as season_ends_on,
         (rs.content ->> 'rosterMin')::integer as roster_min
  from team_entries te
  left join divisions d on d.organization_id = te.organization_id and d.id = te.division_id
  join seasons s on s.organization_id = te.organization_id and s.id = te.season_id
  join rule_sets rs on rs.organization_id = s.organization_id and rs.id = s.rule_set_id;

create view reporting_roster_memberships_v as
  select rm.id as roster_membership_id, rm.organization_id, rm.team_entry_id, rm.person_id,
         coalesce(p.merged_into_person_id, p.id) as canonical_person_id, p.kind as person_kind,
         rm.status, rm.effective_from, rm.effective_to
  from roster_memberships rm
  join persons p on p.organization_id = rm.organization_id and p.id = rm.person_id;

create view reporting_fixtures_v as
  select f.id as fixture_id, f.organization_id, f.season_id, f.division_id,
         coalesce(e.facility_id, d.facility_id) as facility_id, f.status, f.scheduling_event_id,
         coalesce(e.scheduled_start, f.scheduled_start) as scheduled_start,
         coalesce(e.scheduled_end, f.scheduled_end) as scheduled_end,
         f.home_entry_id, f.away_entry_id
  from fixtures f
  left join divisions d on d.organization_id = f.organization_id and d.id = f.division_id
  left join events e on e.organization_id = f.organization_id and e.id = f.scheduling_event_id;

-- Workforce (SPK-STAFF-002) -----------------------------------------------------------------------
create view reporting_assignment_requirements_v as
  select ar.id as requirement_id, ar.organization_id, ar.facility_id, ar.target_type, ar.target_id,
         ar.kind, ar.role, ar.required_count, ar.must_be_accepted,
         coalesce(fe.scheduled_start, f.scheduled_start, e.scheduled_start, s.scheduled_start) as target_start,
         coalesce(fe.title, e.title, o.name) as target_title
  from assignment_requirements ar
  left join fixtures f on f.organization_id = ar.organization_id and f.id = ar.fixture_id
  left join events fe on fe.organization_id = f.organization_id and fe.id = f.scheduling_event_id
  left join events e on e.organization_id = ar.organization_id and e.id = ar.scheduling_event_id
  left join offering_sessions s on s.organization_id = ar.organization_id and s.id = ar.offering_session_id
  left join offerings o on o.organization_id = ar.organization_id and o.id = ar.offering_id;

-- Entry (SPK-ENTRY-001, SPK-ENTRY-005, SPK-ENTRY-008) ---------------------------------------------
create view reporting_attendance_v as
  select a.id as observation_id, a.organization_id, a.facility_id, a.person_id, a.activity_type,
         a.activity_id, a.offering_id, a.scheduling_event_id, a.observed_state, a.observed_at,
         a.received_at, a.source, a.corrects_observation_id, a.flags
  from attendance_observations a;

create view reporting_session_checkins_v as
  select c.id as checkin_id, c.organization_id, c.facility_id, c.person_id, c.activity_type,
         c.activity_id, c.scheduling_event_id, c.status, c.checked_in_at, c.admitted_at, c.withdrawn_at
  from session_checkins c;

create view reporting_visits_v as
  select v.id as visit_id, v.organization_id, v.facility_id, v.visitor_category, v.party_size,
         v.status, v.arrived_at, v.received_at, v.departed_at, v.voided_at
  from visits v;

-- Finance (SPK-PAY-001..012) ----------------------------------------------------------------------
create view reporting_obligations_v as
  select o.id as obligation_id, o.organization_id, o.debtor_kind, o.mode, o.source_kind,
         o.amount_minor, o.allocated_minor, o.currency, o.due_at, o.status,
         o.settled_at, o.written_off_at, o.canceled_at
  from obligations o;

create view reporting_installments_v as
  select i.id as installment_id, i.organization_id, i.plan_id, i.amount_minor, i.currency, i.due_at,
         i.status, i.paid_at, i.failed_at, i.extension_count
  from installments i;

create view reporting_credits_v as
  select c.id as credit_id, c.organization_id, c.original_minor, c.remaining_minor, c.currency,
         c.source_kind, c.status, c.expires_at
  from credits c;

create view reporting_payment_attempts_v as
  select pa.id as payment_attempt_id, pa.organization_id, pa.purpose, pa.order_id, pa.amount_minor,
         pa.currency, pa.provider, pa.status, pa.processor_fee_minor, pa.submitted_at,
         pa.unknown_since, pa.resolved_at
  from payment_attempts pa;

create view reporting_refund_attempts_v as
  select ra.id as refund_attempt_id, ra.organization_id, ra.payment_attempt_id, pa.order_id,
         ra.amount_minor, ra.currency, ra.purpose, ra.provider, ra.status, ra.reservation_status,
         ra.submitted_at, ra.unknown_since, ra.resolved_at
  from refund_attempts ra
  join payment_attempts pa on pa.organization_id = ra.organization_id and pa.id = ra.payment_attempt_id;

create view reporting_receipts_v as
  select r.id as receipt_id, r.organization_id, r.source_kind, r.amount_minor, r.excess_minor,
         r.currency, r.order_id, r.received_at
  from receipts r;

create view reporting_settlements_v as
  select s.id as settlement_id, s.organization_id, s.kind, s.provider, s.facility_id, s.period_start,
         s.period_end, s.currency, s.expected_minor, s.reported_minor, s.difference_minor, s.status,
         s.performed_at
  from settlement_reconciliations s;

create view reporting_order_lines_v as
  select ol.id as order_line_id, ol.organization_id, ol.order_id, ol.offering_id, ol.enrollment_id,
         ol.participant_person_id, ol.total_minor, ol.currency, o.payer_person_id,
         o.payment_status, o.fulfillment_status, o.paid_at, o.fulfilled_at, o.canceled_at,
         off.facility_id, off.kind as offering_kind
  from order_lines ol
  join orders o on o.organization_id = ol.organization_id and o.id = ol.order_id
  join offerings off on off.organization_id = ol.organization_id and off.id = ol.offering_id;

-- Facilities (SPK-FAC-002..004) -------------------------------------------------------------------
create view reporting_restrictions_v as
  select r.id as restriction_id, r.organization_id, r.facility_id, r.resource_id,
         res.name as resource_name, r.asset_id, r.task_id, r.preventive_schedule_id, r.kind,
         lower(r.during) as starts_at, upper(r.during) as ends_at, r.status, r.approved_at,
         r.released_at, cardinality(r.affected_conflict_unit_ids) as affected_unit_count,
         t.status as task_status, t.resolved_at as task_resolved_at
  from restrictions r
  join resources res on res.organization_id = r.organization_id and res.id = r.resource_id
  left join maintenance_tasks t on t.organization_id = r.organization_id and t.id = r.task_id;

create view reporting_maintenance_tasks_v as
  select t.id as task_id, t.organization_id, t.facility_id, t.resource_id, t.asset_id, t.severity,
         t.status, t.requires_inspection, t.reported_at, t.due_at, t.resolved_at, t.closed_at
  from maintenance_tasks t;

-- Communications (SPK-COMMS-002..007) -------------------------------------------------------------
create view reporting_notifications_v as
  select n.id as notification_id, n.organization_id, n.facility_id, n.kind, n.category, n.protected,
         n.status, n.queued_at, n.dispatched_at, n.suppressed_at, n.suppression_reason
  from notifications n;

create view reporting_delivery_attempts_v as
  select da.id as delivery_attempt_id, da.organization_id, da.notification_id, n.facility_id,
         n.kind as notification_kind, n.category, da.channel, da.provider, da.status, da.queued_at,
         da.attempted_at, da.accepted_at, da.delivered_at, da.failed_at, da.failure_code
  from delivery_attempts da
  join notifications n on n.organization_id = da.organization_id and n.id = da.notification_id;

create view reporting_notification_recipients_v as
  select nr.id as recipient_id, nr.organization_id, nr.notification_id, nr.status, nr.revoked_at
  from notification_recipients nr;

-- Every reporting view refuses writes, including simple (auto-updatable) projections.
do $$
declare
  v record;
begin
  for v in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'v'
      and n.nspname = current_schema()
      and c.relname like 'reporting\_%\_v'
  loop
    execute format(
      'create trigger %I instead of insert or update or delete on %I for each row execute function reporting_view_read_only()',
      v.relname || '_read_only',
      v.relname
    );
  end loop;
end
$$;
