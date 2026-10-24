-- 1000_communications_core.sql
-- Communications module (specification §3.18 SPK-COMMS-001..008, §4.4 Communications,
-- §4.5 "Messages must represent actual delivery states", §4.7 invariant 10, SPK-IAM-006,
-- SPK-AT-017, SPK-UX-003/006 inbox).
--
-- A notification is composed once (by a service or by staff), its recipients are resolved from the
-- permissions in force when it is queued and re-checked before dispatch, and every hand-off to a
-- channel is a delivery attempt whose state is exactly what the platform knows (queued, provider
-- accepted, delivered where confirmed, failed, unknown, read, acknowledged). Nothing here ever
-- infers delivery from a provider "accept".

-- ---------------------------------------------------------------------------------------------
-- Notifications (SPK-COMMS-002 triggers, SPK-COMMS-005 old/new practical details,
-- SPK-COMMS-006 staff composition, SPK-COMMS-007 operational vs promotional category).
-- `protected` marks content that includes participant-private information: recipients are
-- re-checked against current authority immediately before any dispatch (SPK-COMMS-003, invariant 10).
-- `supersedes_notification_id` records which obsolete unsent notice a newer change replaced; the
-- replaced notice becomes `suppressed` (or, when already dispatched, carries `superseded_by`).
-- Status values are exactly the NotificationMachine states (communications.machines.ts).
-- ---------------------------------------------------------------------------------------------
create table notifications (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid,
  kind text not null check (kind in (
    'registration_outcome', 'team_invitation', 'placement', 'waitlist_offer',
    'schedule_published', 'schedule_changed', 'cancellation', 'payment_attention',
    'assignment_offer', 'result_published', 'renewal_opportunity', 'youth_feedback',
    'staff_broadcast'
  )),
  category text not null check (category in ('operational', 'promotional')),
  subject_type text check (subject_type is null or length(subject_type) between 1 and 100),
  subject_id text check (subject_id is null or length(subject_id) between 1 and 200),
  audience jsonb not null,
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  details_before jsonb,
  details_after jsonb,
  protected boolean not null default false,
  created_by jsonb not null,
  created_by_person_id uuid,
  source_event_id uuid,
  scheduled_for timestamptz,
  status text not null default 'composed' check (status in ('composed', 'queued', 'dispatched', 'suppressed')),
  supersedes_notification_id uuid,
  superseded_by_notification_id uuid,
  suppression_reason text check (suppression_reason is null or suppression_reason in ('obsolete', 'no_recipients', 'authority_revoked')),
  queued_at timestamptz,
  dispatched_at timestamptz,
  suppressed_at timestamptz,
  correlation_id text,
  operation_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, created_by_person_id) references persons (organization_id, id),
  foreign key (organization_id, supersedes_notification_id) references notifications (organization_id, id),
  foreign key (organization_id, superseded_by_notification_id) references notifications (organization_id, id),
  check (supersedes_notification_id is null or supersedes_notification_id <> id),
  check (superseded_by_notification_id is null or superseded_by_notification_id <> id),
  check ((subject_type is null) = (subject_id is null)),
  check ((status = 'suppressed') = (suppressed_at is not null)),
  check ((status = 'suppressed') = (suppression_reason is not null)),
  check (status not in ('queued', 'dispatched') or queued_at is not null),
  check ((status = 'dispatched') = (dispatched_at is not null))
);
-- One notice per source domain event: a replayed outbox event never composes a second notice.
create unique index notifications_source_event_idx on notifications (organization_id, source_event_id)
  where source_event_id is not null;
create index notifications_subject_idx on notifications (organization_id, subject_type, subject_id, created_at desc)
  where subject_type is not null;
create index notifications_status_idx on notifications (organization_id, status, created_at desc);
create trigger notifications_touch before update on notifications
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Recipients (SPK-COMMS-003). One row per person per notification; `subject_person_ids` names the
-- participants whose `receive_messages` grants justified inclusion so revocation can be re-evaluated
-- (SPK-IAM-006, SPK-AT-017). `authorized` is set at the moment of dispatch; `revoked` means the
-- authority disappeared before anything was handed to an external channel.
-- ---------------------------------------------------------------------------------------------
create table notification_recipients (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  notification_id uuid not null,
  person_id uuid not null,
  resolved_basis text not null check (resolved_basis in ('self', 'receive_messages', 'staff_role', 'team_member', 'explicit')),
  basis_detail text check (basis_detail is null or length(basis_detail) between 1 and 200),
  subject_person_ids uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'authorized', 'revoked')),
  resolved_at timestamptz not null,
  authorized_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, notification_id, person_id),
  foreign key (organization_id, notification_id) references notifications (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check (status <> 'authorized' or authorized_at is not null),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index notification_recipients_person_idx on notification_recipients (organization_id, person_id, created_at desc);
create index notification_recipients_notification_idx on notification_recipients (organization_id, notification_id, status);
create index notification_recipients_subjects_idx on notification_recipients using gin (subject_person_ids)
  where status in ('pending', 'authorized');
create trigger notification_recipients_touch before update on notification_recipients
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Delivery attempts (SPK-COMMS-004, §4.5). The in-app channel is delivered by the platform itself
-- (provider 'in_app'); push, email and SMS are handed to a channel provider outside any transaction
-- and the outcome recorded afterwards. `unknown` stays explicit until a provider event resolves it.
-- A push is never marked delivered without a receipt. Status values are exactly the
-- DeliveryAttemptMachine states.
-- ---------------------------------------------------------------------------------------------
create table delivery_attempts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  notification_id uuid not null,
  recipient_id uuid not null,
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  provider text not null check (length(provider) between 1 and 100),
  provider_message_id text,
  status text not null default 'queued' check (status in (
    'queued', 'provider_accepted', 'delivered', 'failed', 'unknown', 'read', 'acknowledged'
  )),
  queued_at timestamptz not null,
  ready_at timestamptz,
  locked_until timestamptz,
  attempted_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  read_at timestamptz,
  acknowledged_at timestamptz,
  provider_response jsonb,
  failure_code text check (failure_code is null or failure_code in (
    'RECIPIENT_REVOKED', 'NO_ADDRESS', 'PROVIDER_REJECTED', 'PROVIDER_ERROR'
  )),
  error text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, notification_id) references notifications (organization_id, id),
  foreign key (organization_id, recipient_id) references notification_recipients (organization_id, id),
  check ((status = 'failed') = (failed_at is not null)),
  check ((status = 'failed') = (failure_code is not null)),
  check (status not in ('delivered', 'read', 'acknowledged') or delivered_at is not null),
  check (status not in ('read', 'acknowledged') or read_at is not null),
  check ((status = 'acknowledged') = (acknowledged_at is not null)),
  check (status <> 'provider_accepted' or accepted_at is not null),
  check ((channel = 'in_app') = (provider = 'in_app'))
);
-- At most one live (non-failed) attempt per recipient and channel: a replayed follow-up cannot
-- deliver the same notice twice on one channel; a retry after failure is a new row.
create unique index delivery_attempts_live_idx on delivery_attempts (organization_id, recipient_id, channel)
  where status <> 'failed';
-- A provider receipt maps to exactly one attempt.
create unique index delivery_attempts_provider_message_idx on delivery_attempts (provider, provider_message_id)
  where provider_message_id is not null;
create index delivery_attempts_queue_idx on delivery_attempts (ready_at)
  where status = 'queued' and channel <> 'in_app';
create index delivery_attempts_notification_idx on delivery_attempts (organization_id, notification_id, status);
create index delivery_attempts_recipient_idx on delivery_attempts (organization_id, recipient_id, channel);
create index delivery_attempts_inbox_idx on delivery_attempts (organization_id, recipient_id, created_at desc, id desc)
  where channel = 'in_app';
create trigger delivery_attempts_touch before update on delivery_attempts
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Preferences (SPK-COMMS-007). Operational essentials and promotional messages are separate
-- categories; the person chooses the external channels for each, but the in-app operational
-- notice can never be switched off (the database refuses that row).
-- ---------------------------------------------------------------------------------------------
create table communication_preferences (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  category text not null check (category in ('operational', 'promotional')),
  enabled boolean not null,
  updated_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, person_id, channel, category),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  constraint communication_preferences_operational_in_app_required
    check (not (category = 'operational' and channel = 'in_app' and enabled = false))
);
create trigger communication_preferences_touch before update on communication_preferences
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Acknowledgments (SPK-COMMS-004 "acknowledged"): an append-only fact, at most one per recipient.
-- ---------------------------------------------------------------------------------------------
create table notification_acknowledgments (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  notification_id uuid not null,
  recipient_id uuid not null,
  delivery_attempt_id uuid,
  acknowledged_at timestamptz not null,
  via text not null check (via in ('in_app', 'push', 'email', 'sms')),
  acknowledged_by jsonb not null,
  note text check (note is null or length(note) between 1 and 2000),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, recipient_id),
  foreign key (organization_id, notification_id) references notifications (organization_id, id),
  foreign key (organization_id, recipient_id) references notification_recipients (organization_id, id),
  foreign key (organization_id, delivery_attempt_id) references delivery_attempts (organization_id, id)
);
create trigger notification_acknowledgments_append_only before update or delete on notification_acknowledgments
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Calendar feeds (SPK-COMMS-008): a private, revocable authorization to read a person's activities
-- as an ICS feed. Only the token hash is stored; event identities in the feed are stable (event
-- ids). Revocation stops future access; it cannot recall what an external calendar already fetched.
-- ---------------------------------------------------------------------------------------------
create table calendar_feeds (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  person_id uuid not null,
  label text check (label is null or length(label) between 1 and 100),
  token_hash text not null unique,
  scope jsonb not null,
  created_by jsonb not null,
  last_accessed_at timestamptz,
  access_count integer not null default 0 check (access_count >= 0),
  revoked_at timestamptz,
  revoked_by jsonb,
  revocation_reason text,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, person_id) references persons (organization_id, id),
  check ((revoked_at is null) = (revoked_by is null))
);
create index calendar_feeds_person_idx on calendar_feeds (organization_id, person_id, created_at desc);
create trigger calendar_feeds_touch before update on calendar_feeds
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Calendar entries: this module's own projection of scheduled events, built from
-- `scheduling.event_changed` (the scheduling module stays the only writer of its tables, §4.2).
-- The feed reads from here; `event_id` is the stable iCalendar UID and `sequence` increases with
-- every change so external calendars pick up moves and cancellations (SPK-COMMS-008).
-- ---------------------------------------------------------------------------------------------
create table calendar_entries (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  event_id uuid not null,
  facility_id uuid not null,
  title text not null,
  kind text not null,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  timezone text not null,
  resources jsonb not null default '[]'::jsonb,
  status text not null check (status in ('draft', 'published', 'canceled')),
  sequence integer not null default 0 check (sequence >= 0),
  last_change text not null,
  last_source_event_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, event_id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  check (scheduled_start < scheduled_end)
);
create index calendar_entries_time_idx on calendar_entries (organization_id, scheduled_start);
create trigger calendar_entries_touch before update on calendar_entries
  for each row execute function touch_updated_at();

create table calendar_entry_parties (
  organization_id uuid not null references organizations(id),
  entry_id uuid not null,
  party_type text not null check (party_type in ('team', 'person')),
  party_id uuid not null,
  role text not null,
  primary key (organization_id, entry_id, party_type, party_id),
  foreign key (organization_id, entry_id) references calendar_entries (organization_id, id) on delete cascade
);
create index calendar_entry_parties_party_idx on calendar_entry_parties (organization_id, party_type, party_id);
