-- 0805_entry_access_hardware.sql
-- ENT-05: §3.16 "Access hardware" (device inventory, access policy, revocation, event ingestion,
-- outages, audit), SPK-COND-004 (hardware access never establishes attendance or pickup
-- authority), SPK-ENTRY-002 (passes), §4.7 (integrity enforced in the database), §4.12 (durable
-- background delivery). Whether the complex uses access hardware is pending (DEC-080, DEC-016):
-- the application gates new devices and policies behind the `access_hardware` capability; the
-- tables exist regardless. The hardware vendor is not selected (DEC-023): commands are delivered
-- through ACCESS_DEVICE_PORT, whose only adapter is the deterministic fake.
--
-- The module owns these tables and is their only writer (§4.2). References are organization-scoped
-- composite keys (§4.3).

-- ---------------------------------------------------------------------------------------------
-- Access devices (inventory). AccessDeviceMachine: active → retired (terminal). The provider's
-- device reference identifies one physical device within the organization for good: a retired
-- device's reference is never reassigned. Health is observed (heartbeats, the outage job); the
-- heartbeat timeout is device configuration with no default (null: outages are not detected).
-- ---------------------------------------------------------------------------------------------
create table access_devices (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  kind text not null check (kind in ('door', 'turnstile', 'gate', 'scanner')),
  name text not null check (length(name) between 1 and 200),
  provider_device_ref text not null check (length(provider_device_ref) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'retired')),
  health text not null default 'unknown' check (health in ('online', 'offline', 'unknown')),
  heartbeat_timeout_seconds integer
    constraint access_devices_heartbeat_timeout_positive
      check (heartbeat_timeout_seconds is null or heartbeat_timeout_seconds > 0),
  last_heartbeat_at timestamptz,
  registered_at timestamptz not null,
  registered_by jsonb not null,
  registered_by_person_id uuid,
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(retired_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, id, facility_id),
  constraint access_devices_ref_unique unique (organization_id, provider_device_ref),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check ((status = 'retired') = (retired_at is not null)),
  check ((status = 'retired') = (retired_reason is not null))
);
create index access_devices_facility_idx on access_devices (organization_id, facility_id, status);
create trigger access_devices_touch before update on access_devices
  for each row execute function touch_updated_at();
create trigger access_devices_no_delete before delete on access_devices
  for each row execute function forbid_mutation();

create or replace function access_devices_guard() returns trigger
language plpgsql as $$
begin
  if new.facility_id <> old.facility_id
     or new.kind <> old.kind
     or new.provider_device_ref <> old.provider_device_ref
     or new.registered_at <> old.registered_at then
    raise exception 'access device % facility, kind, provider reference and registration are immutable', old.id
      using errcode = 'check_violation', constraint = 'access_devices_machine';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'active' and new.status = 'retired' then
    return new;
  end if;
  raise exception 'access device % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'access_devices_machine';
end
$$;
create trigger access_devices_guard before update on access_devices
  for each row execute function access_devices_guard();

-- ---------------------------------------------------------------------------------------------
-- Access policies. Drafted by one person and approved by another (four eyes); at most one active
-- policy per device. A policy admits active passes only (a revoked pass is never admitted).
-- AccessPolicyMachine: draft → active | retired (withdrawn); active → retired. The content of a
-- policy never changes: a change is a new draft.
-- ---------------------------------------------------------------------------------------------
create table access_policies (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  device_id uuid not null,
  facility_id uuid not null,
  allowed_holder_kinds text[] not null
    check (cardinality(allowed_holder_kinds) between 1 and 2
           and allowed_holder_kinds <@ array['person', 'household']::text[]),
  allowed_pass_statuses text[] not null default '{active}'
    constraint access_policies_active_passes_only
      check (cardinality(allowed_pass_statuses) >= 1 and allowed_pass_statuses <@ array['active']::text[]),
  schedule jsonb not null
    check (jsonb_typeof(schedule) = 'array' and jsonb_array_length(schedule) between 1 and 28),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  authored_by jsonb not null,
  authored_by_person_id uuid not null,
  approved_by jsonb,
  approved_by_person_id uuid,
  approved_at timestamptz,
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(retired_reason) between 1 and 2000),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, device_id, facility_id)
    references access_devices (organization_id, id, facility_id),
  foreign key (organization_id, authored_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, approved_by_person_id) references persons (organization_id, id),
  -- Four eyes: the author never approves their own policy.
  constraint access_policies_four_eyes
    check (approved_by_person_id is null or approved_by_person_id <> authored_by_person_id),
  -- An active policy always has an approver.
  constraint access_policies_active_approved
    check (status <> 'active' or approved_by_person_id is not null),
  check ((approved_by_person_id is null) = (approved_at is null)),
  check ((approved_by_person_id is null) = (approved_by is null)),
  check ((status = 'retired') = (retired_at is not null)),
  check ((status = 'retired') = (retired_reason is not null))
);
create unique index access_policies_one_active_idx on access_policies (organization_id, device_id)
  where status = 'active';
create index access_policies_device_idx on access_policies (organization_id, device_id, created_at);
create trigger access_policies_touch before update on access_policies
  for each row execute function touch_updated_at();
create trigger access_policies_no_delete before delete on access_policies
  for each row execute function forbid_mutation();

create or replace function access_policies_guard() returns trigger
language plpgsql as $$
begin
  if new.device_id <> old.device_id
     or new.facility_id <> old.facility_id
     or new.allowed_holder_kinds <> old.allowed_holder_kinds
     or new.allowed_pass_statuses <> old.allowed_pass_statuses
     or new.schedule <> old.schedule
     or new.authored_by_person_id <> old.authored_by_person_id
     or new.authored_by <> old.authored_by
     or (old.approved_by_person_id is not null
         and new.approved_by_person_id is distinct from old.approved_by_person_id) then
    raise exception 'access policy % content, author and approver are immutable', old.id
      using errcode = 'check_violation', constraint = 'access_policies_machine';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'draft' and new.status in ('active', 'retired'))
     or (old.status = 'active' and new.status = 'retired') then
    return new;
  end if;
  raise exception 'access policy % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'access_policies_machine';
end
$$;
create trigger access_policies_guard before update on access_policies
  for each row execute function access_policies_guard();

-- ---------------------------------------------------------------------------------------------
-- Device commands: what a device must be told (revoke a credential, synchronize its policy; a
-- sync without a policy is deny-all). Delivered by the job entry.deliver_device_commands outside
-- transactions (§4.11); the outcome is recorded as a fact and `unknown` stays explicit until a
-- retry or the device's receipt settles it. One revocation per device and pass.
-- DeviceCommandMachine: pending → delivered | failed | unknown | superseded;
-- unknown → delivered | failed | pending (retry) | superseded; failed → pending (retry) |
-- superseded; delivered and superseded are terminal. A newer policy synchronization supersedes an
-- undelivered older one, so a retried old sync can never overwrite the newer policy.
-- ---------------------------------------------------------------------------------------------
create table device_commands (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  device_id uuid not null,
  kind text not null check (kind in ('revoke_credential', 'sync_policy')),
  pass_id uuid,
  policy_id uuid,
  policy_snapshot jsonb check (policy_snapshot is null or jsonb_typeof(policy_snapshot) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'failed', 'unknown', 'superseded')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error is null or length(last_error) between 1 and 2000),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  settled_by text check (settled_by in ('adapter', 'receipt')),
  escalation_exception_id uuid,
  requested_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, device_id) references access_devices (organization_id, id),
  foreign key (organization_id, pass_id) references passes (organization_id, id),
  foreign key (organization_id, policy_id) references access_policies (organization_id, id),
  foreign key (organization_id, escalation_exception_id)
    references operational_exceptions (organization_id, id),
  check ((kind = 'revoke_credential') = (pass_id is not null)),
  check (kind = 'sync_policy' or (policy_id is null and policy_snapshot is null)),
  check ((policy_id is null) = (policy_snapshot is null)),
  check ((status = 'delivered') = (delivered_at is not null)),
  check ((status in ('delivered', 'failed')) = (settled_by is not null)),
  check (status <> 'superseded' or kind = 'sync_policy')
);
create unique index device_commands_one_revoke_idx on device_commands (organization_id, device_id, pass_id)
  where kind = 'revoke_credential';
create index device_commands_due_idx on device_commands (created_at, id)
  where status in ('pending', 'failed', 'unknown');
create index device_commands_device_idx on device_commands (organization_id, device_id, created_at desc, id desc);
create trigger device_commands_touch before update on device_commands
  for each row execute function touch_updated_at();
create trigger device_commands_no_delete before delete on device_commands
  for each row execute function forbid_mutation();

create or replace function device_commands_guard() returns trigger
language plpgsql as $$
begin
  if new.device_id <> old.device_id
     or new.kind <> old.kind
     or new.pass_id is distinct from old.pass_id
     or new.policy_id is distinct from old.policy_id
     or new.policy_snapshot is distinct from old.policy_snapshot
     or new.created_at <> old.created_at then
    raise exception 'device command % target and content are immutable', old.id
      using errcode = 'check_violation', constraint = 'device_commands_machine';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'pending' and new.status in ('delivered', 'failed', 'unknown', 'superseded'))
     or (old.status = 'unknown' and new.status in ('delivered', 'failed', 'pending', 'superseded'))
     or (old.status = 'failed' and new.status in ('pending', 'superseded')) then
    return new;
  end if;
  raise exception 'device command % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'device_commands_machine';
end
$$;
create trigger device_commands_guard before update on device_commands
  for each row execute function device_commands_guard();

-- ---------------------------------------------------------------------------------------------
-- Visits: an access-control arrival names the registered device it came through (when its
-- reference matches an active device of the visit's facility). Still an arrival fact only
-- (SPK-COND-004). The device is part of the arrival facts, so it is immutable like them.
-- ---------------------------------------------------------------------------------------------
alter table visits
  add column access_device_id uuid,
  add constraint visits_access_device_fk
    foreign key (organization_id, access_device_id, facility_id)
    references access_devices (organization_id, id, facility_id),
  add constraint visits_access_device_source
    check (access_device_id is null or source = 'access_control');

create or replace function visits_guard() returns trigger
language plpgsql as $$
begin
  if new.person_id is distinct from old.person_id
     or new.facility_id <> old.facility_id
     or new.visitor_category <> old.visitor_category
     or new.arrived_at <> old.arrived_at
     or new.party_size <> old.party_size
     or new.source <> old.source
     or new.access_device_id is distinct from old.access_device_id then
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
