-- 0800_entry_core.sql
-- Entry module (specification §3.14 SPK-ENTRY-001..008, §4.4 Arrival: Visit, AttendanceObservation,
-- Departure, ReleaseRecord; §4.5 "Attendance must preserve observations and corrections"; §4.8
-- POST /v1/attendance-observations and POST /v1/releases; §4.15 offline behaviour; SPK-COND-004;
-- SPK-AT-015, SPK-AT-016, SPK-AT-018).
--
-- The module owns these tables and is their only writer (§4.2). It references people and
-- households (identity), offering sessions and offerings (catalog), events (scheduling),
-- enrollments and session bookings (enrollment) through composite (organization_id, id) foreign
-- keys so a row can never point at another organization's record (§4.3).
--
-- SPK-ENTRY-001: facility arrival (visits), session check-in (session_checkins), observed
-- attendance (attendance_observations), departure (departures) and supervised release
-- (release_records) are separate records. Observations, departures, releases, offline batches and
-- occupancy snapshots are append-only facts (forbid_mutation); corrections are new rows that
-- reference what they correct (SPK-ENTRY-005).

-- ---------------------------------------------------------------------------------------------
-- Passes (SPK-ENTRY-002): an opaque reference for a person or a household. Only the SHA-256 of
-- the reference is stored; the reference itself is random and carries no child or household
-- detail. A pass is active or revoked; a revoked pass never becomes active again.
-- ---------------------------------------------------------------------------------------------
create table passes (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  holder_kind text not null check (holder_kind in ('person', 'household')),
  holder_person_id uuid,
  holder_household_id uuid,
  reference_hash text not null check (reference_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  issued_at timestamptz not null,
  issued_by jsonb not null,
  issued_by_person_id uuid,
  revoked_at timestamptz,
  revoked_by jsonb,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint passes_reference_unique unique (reference_hash),
  foreign key (organization_id, holder_person_id) references persons (organization_id, id),
  foreign key (organization_id, holder_household_id) references households (organization_id, id),
  check ((holder_kind = 'person') = (holder_person_id is not null)),
  check ((holder_kind = 'household') = (holder_household_id is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (status <> 'revoked' or (revoked_reason is not null and revoked_by is not null))
);
create index passes_holder_person_idx on passes (organization_id, holder_person_id) where holder_person_id is not null;
create index passes_holder_household_idx on passes (organization_id, holder_household_id) where holder_household_id is not null;
create trigger passes_touch before update on passes
  for each row execute function touch_updated_at();
create trigger passes_no_delete before delete on passes
  for each row execute function forbid_mutation();

-- PassMachine: active → revoked. The holder and the reference never change.
create or replace function passes_guard() returns trigger
language plpgsql as $$
begin
  if new.reference_hash <> old.reference_hash
     or new.holder_kind <> old.holder_kind
     or new.holder_person_id is distinct from old.holder_person_id
     or new.holder_household_id is distinct from old.holder_household_id
     or new.issued_at <> old.issued_at then
    raise exception 'pass % holder, reference and issue time are immutable', old.id
      using errcode = 'check_violation', constraint = 'passes_machine';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'active' and new.status = 'revoked' then
    return new;
  end if;
  raise exception 'pass % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'passes_machine';
end
$$;
create trigger passes_guard before update on passes
  for each row execute function passes_guard();

-- ---------------------------------------------------------------------------------------------
-- Offline synchronization batches (§4.15). One row per uploaded batch, written once with every
-- item outcome. A re-uploaded batch (same device and client batch id) is the same row; items are
-- deduplicated by their client observation id on the tables they land in. The snapshot age at
-- receipt feeds the §5.11 "offline synchronization age" signal; items observed against a roster
-- older than the configured maximum (DEC-033, proposed two hours) are flagged, never dropped.
-- ---------------------------------------------------------------------------------------------
create table offline_sync_batches (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  device_id text not null check (length(device_id) between 1 and 200),
  client_batch_id uuid not null,
  snapshot_reference text not null check (length(snapshot_reference) between 1 and 200),
  snapshot_taken_at timestamptz not null,
  received_at timestamptz not null,
  snapshot_age_seconds integer not null check (snapshot_age_seconds >= 0),
  max_roster_age_minutes integer not null check (max_roster_age_minutes > 0),
  item_count integer not null check (item_count between 1 and 500),
  accepted_count integer not null check (accepted_count >= 0),
  conflict_count integer not null check (conflict_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  rejected_count integer not null check (rejected_count >= 0),
  stale_count integer not null check (stale_count >= 0),
  stale boolean not null,
  results jsonb not null check (jsonb_typeof(results) = 'array'),
  exception_ids uuid[] not null default '{}',
  operation_id uuid references operations(id),
  submitted_by jsonb not null,
  submitted_by_person_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint offline_sync_batches_client_unique unique (organization_id, device_id, client_batch_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check (accepted_count + conflict_count + duplicate_count + rejected_count = item_count),
  check (stale = (stale_count > 0)),
  check (stale_count <= item_count)
);
create index offline_sync_batches_facility_idx on offline_sync_batches (organization_id, facility_id, received_at desc);
create trigger offline_sync_batches_append_only before update or delete on offline_sync_batches
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Visits: facility arrival (SPK-ENTRY-001, SPK-ENTRY-006). A visit records who arrived, in which
-- visitor category, from which source. It never creates or implies an enrollment: a participant
-- visit names a real person, and session participation is a separate check-in. Unregistered
-- visitors (spectators, contractors) are described with a party size, never fabricated as people.
-- Hardware access events land here and nowhere else (SPK-COND-004).
-- VisitMachine: on_site → departed | voided.
-- ---------------------------------------------------------------------------------------------
create table visits (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  person_id uuid,
  visitor_description text check (visitor_description is null or length(visitor_description) between 1 and 200),
  party_size integer not null default 1 check (party_size between 1 and 200),
  visitor_category text not null
    check (visitor_category in ('participant', 'guardian', 'spectator', 'staff', 'contractor', 'unclassified')),
  arrived_at timestamptz not null,
  pass_id uuid,
  source text not null check (source in ('desk', 'offline_sync', 'access_control')),
  device_id text check (device_id is null or length(device_id) between 1 and 200),
  client_observation_id uuid,
  sync_batch_id uuid,
  access_event_ref text check (access_event_ref is null or length(access_event_ref) between 1 and 300),
  status text not null default 'on_site' check (status in ('on_site', 'departed', 'voided')),
  departed_at timestamptz,
  voided_at timestamptz,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 2000),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  received_at timestamptz not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, facility_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, pass_id) references passes (organization_id, id),
  foreign key (organization_id, sync_batch_id) references offline_sync_batches (organization_id, id)
    deferrable initially deferred,
  check (person_id is not null or visitor_description is not null),
  check (person_id is null or party_size = 1),
  -- SPK-ENTRY-006: a participant is always a real person record, never a fabricated one.
  constraint visits_participant_is_person check (visitor_category <> 'participant' or person_id is not null),
  check ((status = 'departed') = (departed_at is not null)),
  check ((status = 'voided') = (voided_at is not null and void_reason is not null)),
  check (departed_at is null or departed_at >= arrived_at),
  check ((source = 'offline_sync') = (sync_batch_id is not null)),
  check (source <> 'offline_sync' or client_observation_id is not null),
  check ((source = 'access_control') = (access_event_ref is not null)),
  check (client_observation_id is null or device_id is not null)
);
-- A person is on site at a facility at most once at a time.
create unique index visits_one_open_per_person_idx on visits (organization_id, facility_id, person_id)
  where status = 'on_site' and person_id is not null;
create unique index visits_client_observation_idx on visits (organization_id, device_id, client_observation_id)
  where client_observation_id is not null;
create unique index visits_access_event_idx on visits (organization_id, access_event_ref)
  where access_event_ref is not null;
create index visits_facility_time_idx on visits (organization_id, facility_id, arrived_at);
create index visits_person_idx on visits (organization_id, person_id, arrived_at) where person_id is not null;
create trigger visits_touch before update on visits
  for each row execute function touch_updated_at();
create trigger visits_no_delete before delete on visits
  for each row execute function forbid_mutation();

create or replace function visits_guard() returns trigger
language plpgsql as $$
begin
  if new.person_id is distinct from old.person_id
     or new.facility_id <> old.facility_id
     or new.visitor_category <> old.visitor_category
     or new.arrived_at <> old.arrived_at
     or new.party_size <> old.party_size
     or new.source <> old.source then
    raise exception 'visit % arrival facts are immutable', old.id
      using errcode = 'check_violation', constraint = 'visits_machine';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'on_site' and new.status in ('departed', 'voided') then
    return new;
  end if;
  raise exception 'visit % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'visits_machine';
end
$$;
create trigger visits_guard before update on visits
  for each row execute function visits_guard();

-- ---------------------------------------------------------------------------------------------
-- Session check-ins (SPK-ENTRY-001, SPK-ENTRY-003, SPK-ENTRY-004, SPK-ENTRY-006). One person, one
-- activity (a catalog offering session or a scheduling event). The participation basis is a real
-- record of another module (an enrollment or session booking from enrollment, a person commitment
-- of the scheduling event, or an effective roster membership in competition) and is never
-- fabricated. Arrival checks are stored as actionable issues; a check-in with a blocking issue is
-- held, and it is admitted only once no blocking issue remains (database check below).
-- SessionCheckinMachine: held → admitted | held | withdrawn; admitted → withdrawn.
-- ---------------------------------------------------------------------------------------------
create table session_checkins (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  visit_id uuid,
  person_id uuid not null,
  activity_type text not null check (activity_type in ('session', 'event')),
  activity_id uuid not null,
  offering_id uuid,
  offering_session_id uuid,
  scheduling_event_id uuid,
  activity_start timestamptz not null,
  activity_end timestamptz not null,
  basis_kind text check (basis_kind in ('enrollment', 'session_booking', 'event_commitment', 'roster_membership')),
  enrollment_id uuid,
  session_booking_id uuid,
  basis_reference uuid,
  status text not null check (status in ('held', 'admitted', 'withdrawn')),
  issues jsonb not null default '[]'::jsonb check (jsonb_typeof(issues) = 'array'),
  checked_in_at timestamptz not null,
  evaluated_at timestamptz not null,
  admitted_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 2000),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, visit_id, facility_id) references visits (organization_id, id, facility_id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  foreign key (organization_id, enrollment_id) references enrollments (organization_id, id),
  foreign key (organization_id, session_booking_id) references session_bookings (organization_id, id),
  check (activity_start < activity_end),
  check ((activity_type = 'session') = (offering_session_id is not null and offering_id is not null)),
  check (activity_type <> 'session' or offering_session_id = activity_id),
  check (activity_type <> 'event' or scheduling_event_id = activity_id),
  check ((coalesce(basis_kind, '') = 'enrollment') = (enrollment_id is not null)),
  check ((coalesce(basis_kind, '') = 'session_booking') = (session_booking_id is not null)),
  check (basis_kind not in ('event_commitment', 'roster_membership') or activity_type = 'event'),
  check (basis_kind not in ('enrollment', 'session_booking') or activity_type = 'session'),
  check (status <> 'admitted' or admitted_at is not null),
  check ((status = 'withdrawn') = (withdrawn_at is not null and withdrawn_reason is not null)),
  -- SPK-ENTRY-006: admission needs a real participation basis (no fabricated enrollment).
  constraint session_checkins_admitted_has_basis check (status <> 'admitted' or basis_kind is not null),
  -- SPK-ENTRY-004: a check-in is never admitted while a blocking issue is recorded on it.
  constraint session_checkins_admitted_without_blocking check (
    status <> 'admitted' or not jsonb_path_exists(issues, '$[*] ? (@.severity == "blocking")')
  )
);
-- One live (held or admitted) check-in per person and activity.
create unique index session_checkins_live_idx on session_checkins (organization_id, person_id, activity_type, activity_id)
  where status in ('held', 'admitted');
create index session_checkins_activity_idx on session_checkins (organization_id, activity_type, activity_id);
create index session_checkins_facility_idx on session_checkins (organization_id, facility_id, checked_in_at);
create trigger session_checkins_touch before update on session_checkins
  for each row execute function touch_updated_at();
create trigger session_checkins_no_delete before delete on session_checkins
  for each row execute function forbid_mutation();

create or replace function session_checkins_guard() returns trigger
language plpgsql as $$
begin
  if new.person_id <> old.person_id
     or new.activity_type <> old.activity_type
     or new.activity_id <> old.activity_id
     or new.facility_id <> old.facility_id
     or new.checked_in_at <> old.checked_in_at then
    raise exception 'session check-in % person, activity and time are immutable', old.id
      using errcode = 'check_violation', constraint = 'session_checkins_machine';
  end if;
  if new.status = old.status then
    if old.status = 'withdrawn' then
      raise exception 'session check-in % is withdrawn', old.id
        using errcode = 'check_violation', constraint = 'session_checkins_machine';
    end if;
    return new;
  end if;
  if (old.status = 'held' and new.status in ('admitted', 'withdrawn'))
     or (old.status = 'admitted' and new.status = 'withdrawn') then
    return new;
  end if;
  raise exception 'session check-in % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'session_checkins_machine';
end
$$;
create trigger session_checkins_guard before update on session_checkins
  for each row execute function session_checkins_guard();

-- ---------------------------------------------------------------------------------------------
-- Attendance observations (§4.4 AttendanceObservation, §4.5, §4.8, SPK-ENTRY-005, §4.15).
-- Append-only. A correction is a new row naming the observation it corrects (same person and
-- activity, enforced by the composite foreign key) with the reason; the actor and time of the
-- correction are its own `recorded_by` and `received_at`. An observation is corrected at most
-- once, so the current state of a chain is always its single head. Offline items carry the
-- device, client observation id (unique per device: a re-uploaded batch inserts nothing), the
-- roster snapshot they were observed against and the received time (§4.15). Conflicting
-- observations are both kept and flagged for review.
-- ---------------------------------------------------------------------------------------------
create table attendance_observations (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  person_id uuid not null,
  activity_type text not null check (activity_type in ('session', 'event')),
  activity_id uuid not null,
  offering_id uuid,
  offering_session_id uuid,
  scheduling_event_id uuid,
  observed_state text not null check (observed_state in ('present', 'absent', 'late', 'left_early')),
  observed_at timestamptz not null,
  received_at timestamptz not null,
  source text not null check (source in ('online', 'offline_sync')),
  device_id text check (device_id is null or length(device_id) between 1 and 200),
  client_observation_id uuid,
  sync_batch_id uuid,
  snapshot_reference text check (snapshot_reference is null or length(snapshot_reference) between 1 and 200),
  snapshot_taken_at timestamptz,
  flags text[] not null default '{}' check (flags <@ array['stale_snapshot', 'conflict']::text[]),
  corrects_observation_id uuid,
  correction_reason text check (correction_reason is null or length(correction_reason) between 1 and 2000),
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, person_id, activity_type, activity_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  foreign key (organization_id, sync_batch_id) references offline_sync_batches (organization_id, id)
    deferrable initially deferred,
  constraint attendance_observations_correction_same_subject
    foreign key (organization_id, corrects_observation_id, person_id, activity_type, activity_id)
    references attendance_observations (organization_id, id, person_id, activity_type, activity_id),
  check ((activity_type = 'session') = (offering_session_id is not null and offering_id is not null)),
  check (activity_type <> 'session' or offering_session_id = activity_id),
  check (activity_type <> 'event' or scheduling_event_id = activity_id),
  -- SPK-ENTRY-005: a correction always carries its reason.
  constraint attendance_observations_correction_reason
    check ((corrects_observation_id is null) = (correction_reason is null)),
  check (corrects_observation_id is null or corrects_observation_id <> id),
  check (client_observation_id is null or device_id is not null),
  check ((source = 'offline_sync') = (sync_batch_id is not null)),
  -- §4.15: every queued observation carries its unique id, snapshot reference and snapshot time.
  constraint attendance_observations_offline_fields check (
    source <> 'offline_sync'
    or (client_observation_id is not null and snapshot_reference is not null and snapshot_taken_at is not null)
  )
);
create unique index attendance_observations_client_idx
  on attendance_observations (organization_id, device_id, client_observation_id)
  where client_observation_id is not null;
-- An observation is corrected at most once (corrections of corrections form a chain).
create unique index attendance_observations_one_correction_idx
  on attendance_observations (organization_id, corrects_observation_id)
  where corrects_observation_id is not null;
create index attendance_observations_activity_idx
  on attendance_observations (organization_id, activity_type, activity_id, person_id, observed_at);
create index attendance_observations_person_idx
  on attendance_observations (organization_id, person_id, observed_at);
create trigger attendance_observations_append_only before update or delete on attendance_observations
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Release records: supervised release (SPK-ENTRY-007, §4.8 POST /v1/releases, SPK-AT-016).
-- Append-only. Every field SPK-ENTRY-007 names is a column: child, collecting person (or a
-- description when the collector has no record), verification outcome, staff actor, time,
-- restriction or escalation, release outcome. Current pickup authority is the identity module's
-- `collect` permission checked online at the moment of release; schedule visibility (`view`) and
-- payment permission (`pay`) never establish it, and the permissions the collector does hold are
-- recorded as evidence. A release queued offline is never authorized from a cached roster: only a
-- separately approved manual outage procedure (DEC-005, DEC-034) can release offline, and the
-- online authority is re-checked at synchronization (post_sync_authority).
-- ---------------------------------------------------------------------------------------------
create table release_records (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  child_person_id uuid not null,
  collector_person_id uuid,
  collector_description text check (collector_description is null or length(collector_description) between 1 and 200),
  activity_type text check (activity_type in ('session', 'event')),
  activity_id uuid,
  offering_id uuid,
  offering_session_id uuid,
  scheduling_event_id uuid,
  visit_id uuid,
  verification_method text not null
    check (verification_method in ('online_relationship_check', 'manual_outage_procedure')),
  verification_outcome text not null
    check (verification_outcome in ('verified', 'denied', 'escalated', 'manual_outage_procedure')),
  authority_basis text check (authority_basis in ('relationship_permission:collect')),
  authority_checked_at timestamptz not null,
  collector_permissions text[] not null default '{}'
    check (collector_permissions <@ array['view', 'register', 'pay', 'receive_messages', 'complete_forms', 'collect']::text[]),
  denial_reason text check (denial_reason is null or length(denial_reason) between 1 and 2000),
  restriction_notes text check (restriction_notes is null or length(restriction_notes) between 1 and 2000),
  escalation_notes text check (escalation_notes is null or length(escalation_notes) between 1 and 2000),
  escalation_exception_id uuid references operational_exceptions(id),
  manual_procedure_reference text check (manual_procedure_reference is null or length(manual_procedure_reference) between 1 and 200),
  post_sync_authority text check (post_sync_authority in ('held', 'not_held')),
  outcome text not null check (outcome in ('released', 'not_released')),
  decided_at timestamptz not null,
  released_at timestamptz,
  staff_actor jsonb not null,
  staff_person_id uuid,
  source text not null check (source in ('online', 'offline_sync')),
  device_id text check (device_id is null or length(device_id) between 1 and 200),
  client_observation_id uuid,
  sync_batch_id uuid,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, child_person_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, child_person_id) references persons (organization_id, id),
  foreign key (organization_id, collector_person_id) references persons (organization_id, id),
  foreign key (organization_id, offering_id) references offerings (organization_id, id),
  foreign key (organization_id, offering_session_id) references offering_sessions (organization_id, id),
  foreign key (organization_id, scheduling_event_id) references events (organization_id, id),
  foreign key (organization_id, visit_id, facility_id) references visits (organization_id, id, facility_id),
  foreign key (organization_id, sync_batch_id) references offline_sync_batches (organization_id, id)
    deferrable initially deferred,
  check (collector_person_id is not null or collector_description is not null),
  check ((activity_type is null) = (activity_id is null)),
  check (activity_type is distinct from 'session' or (offering_session_id = activity_id and offering_id is not null)),
  check (activity_type is distinct from 'event' or scheduling_event_id = activity_id),
  check ((outcome = 'released') = (released_at is not null)),
  -- SPK-ENTRY-007: a release happens only on verified current authority or an approved procedure.
  constraint release_records_released_requires_authority
    check (outcome <> 'released' or verification_outcome in ('verified', 'manual_outage_procedure')),
  constraint release_records_verified_requires_collect check (
    verification_outcome <> 'verified'
    or (collector_person_id is not null
        and authority_basis = 'relationship_permission:collect'
        and 'collect' = any(collector_permissions)
        and verification_method = 'online_relationship_check')
  ),
  constraint release_records_denial_recorded check (
    verification_outcome not in ('denied', 'escalated')
    or (denial_reason is not null and outcome = 'not_released' and authority_basis is null)
  ),
  check (verification_outcome <> 'escalated' or escalation_exception_id is not null),
  check ((verification_outcome = 'manual_outage_procedure') = (verification_method = 'manual_outage_procedure')),
  check (verification_method <> 'manual_outage_procedure' or manual_procedure_reference is not null),
  check ((source = 'offline_sync') = (sync_batch_id is not null)),
  -- §4.15: online releases always use the online check; offline ones only an approved procedure.
  constraint release_records_offline_requires_procedure check (
    (source = 'online' and verification_method = 'online_relationship_check')
    or (source = 'offline_sync' and verification_method = 'manual_outage_procedure')
  ),
  check (post_sync_authority is null or source = 'offline_sync'),
  check (source <> 'offline_sync' or (client_observation_id is not null and post_sync_authority is not null)),
  check (client_observation_id is null or device_id is not null)
);
create unique index release_records_client_idx on release_records (organization_id, device_id, client_observation_id)
  where client_observation_id is not null;
create index release_records_child_idx on release_records (organization_id, child_person_id, decided_at);
create index release_records_facility_idx on release_records (organization_id, facility_id, decided_at);
create trigger release_records_append_only before update or delete on release_records
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Departures (SPK-ENTRY-001, SPK-ENTRY-008). Append-only; one per visit. A departure that follows
-- a supervised release names the release, which must be a `released` record for the same person.
-- ---------------------------------------------------------------------------------------------
create table departures (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  visit_id uuid not null,
  person_id uuid,
  departed_at timestamptz not null,
  release_record_id uuid,
  source text not null check (source in ('desk', 'offline_sync', 'release')),
  device_id text check (device_id is null or length(device_id) between 1 and 200),
  client_observation_id uuid,
  sync_batch_id uuid,
  recorded_by jsonb not null,
  recorded_by_person_id uuid,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint departures_one_per_visit unique (organization_id, visit_id),
  foreign key (organization_id, visit_id, facility_id) references visits (organization_id, id, facility_id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  foreign key (organization_id, release_record_id, person_id)
    references release_records (organization_id, id, child_person_id),
  foreign key (organization_id, sync_batch_id) references offline_sync_batches (organization_id, id)
    deferrable initially deferred,
  check (source <> 'release' or release_record_id is not null),
  check (release_record_id is null or person_id is not null),
  check ((source = 'offline_sync') = (sync_batch_id is not null)),
  check (source <> 'offline_sync' or client_observation_id is not null),
  check (client_observation_id is null or device_id is not null)
);
create unique index departures_client_idx on departures (organization_id, device_id, client_observation_id)
  where client_observation_id is not null;
create index departures_facility_time_idx on departures (organization_id, facility_id, departed_at);
create trigger departures_append_only before update or delete on departures
  for each row execute function forbid_mutation();

-- A departure that names a release follows a release that actually released the child.
create or replace function departures_release_guard() returns trigger
language plpgsql as $$
begin
  if new.release_record_id is not null and not exists (
    select 1 from release_records r
     where r.organization_id = new.organization_id
       and r.id = new.release_record_id
       and r.outcome = 'released'
  ) then
    raise exception 'departure % names release % which did not release the child', new.id, new.release_record_id
      using errcode = 'check_violation', constraint = 'departures_release_released';
  end if;
  return new;
end
$$;
create trigger departures_release_guard before insert on departures
  for each row execute function departures_release_guard();

-- ---------------------------------------------------------------------------------------------
-- Occupancy snapshots (SPK-ENTRY-008). Append-only. Arrivals and departures are counted
-- separately; the records-derived on-site figure is never verified occupancy. A snapshot is
-- reconciled only by a physical count, and only a reconciled snapshot carries a verified figure.
-- ---------------------------------------------------------------------------------------------
create table occupancy_snapshots (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  taken_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  arrivals integer not null check (arrivals >= 0),
  departures integer not null check (departures >= 0),
  recorded_on_site integer not null check (recorded_on_site >= 0),
  open_from_earlier_days integer not null check (open_from_earlier_days >= 0),
  reconciled boolean not null,
  counted_on_site integer check (counted_on_site is null or counted_on_site >= 0),
  verified_occupancy integer check (verified_occupancy is null or verified_occupancy >= 0),
  discrepancy integer,
  reconciliation_note text check (reconciliation_note is null or length(reconciliation_note) between 1 and 2000),
  taken_by jsonb not null,
  taken_by_person_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check (window_start < window_end),
  -- SPK-ENTRY-008: verified occupancy exists only on a reconciled snapshot (a physical count).
  constraint occupancy_snapshots_verified_only_when_reconciled check (
    reconciled = (counted_on_site is not null)
    and (verified_occupancy is not null) = reconciled
    and (verified_occupancy is null or verified_occupancy = counted_on_site)
    and (discrepancy is not null) = reconciled
    and (discrepancy is null or discrepancy = counted_on_site - recorded_on_site)
  )
);
create index occupancy_snapshots_facility_idx on occupancy_snapshots (organization_id, facility_id, taken_at desc);
create trigger occupancy_snapshots_append_only before update or delete on occupancy_snapshots
  for each row execute function forbid_mutation();
