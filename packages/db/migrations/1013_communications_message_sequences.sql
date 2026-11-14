-- 1013_communications_message_sequences.sql
-- Communications module: message templates and sequences (SPK-COMMS-009, proposed amendment
-- PA-05; Proposed until DEC-099 is answered; capability `message_sequences`).
--
-- Staff keep reusable message templates (a title and a body with named placeholders) and
-- sequences (ordered steps, each a template and a time relative to an anchor date of a season or
-- an offering). A sequence produces a season's or an offering's schedule: one scheduled message
-- per step. Nothing is sent until a staff member confirms it; a confirmed message is sent when it
-- is due as an ordinary notification, so recipients, consent and preferences are resolved then
-- (SPK-COMMS-003, SPK-COMMS-006, SPK-COMMS-007).
--
--   * message_templates: reusable text, essential or promotional, versioned by `revision`.
--   * message_sequences: for seasons or offerings, read in one facility's local time; optionally
--     limited to one competition or program (`scope_id`, a reference without a cross-module key).
--   * message_sequence_steps: a template, an anchor date and days before or after it.
--   * scheduled_messages: one per step and season or offering (a unique index, so a replayed
--     event creates nothing twice), with its lifecycle, an edited copy of title and body, the
--     exact text staff confirmed and the notification it produced.
-- The lifecycle is ScheduledMessageMachine (packages/contracts/src/state-machines.ts), mirrored
-- by the status check and the transition guard below.

create table message_templates (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  name text not null check (length(name) between 1 and 200),
  category text not null check (category in ('operational', 'promotional')),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
-- One active template per name, whatever its letter case.
create unique index message_templates_active_name_idx
  on message_templates (organization_id, lower(name)) where status = 'active';
create trigger message_templates_touch before update on message_templates
  for each row execute function touch_updated_at();

-- A template stays essential or promotional for good (SPK-COMMS-007): a message confirmed as one
-- is never sent as the other. A different category is a new template.
create or replace function message_templates_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.category <> old.category then
    raise exception 'message template % cannot change its category', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger message_templates_guard before update on message_templates
  for each row execute function message_templates_guard();

create table message_sequences (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  subject_type text not null check (subject_type in ('season', 'offering')),
  scope_id uuid,                                     -- a competition or a program; null: every one
  active boolean not null default false,
  created_by jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id)
);
create unique index message_sequences_name_idx
  on message_sequences (organization_id, facility_id, lower(name));
create index message_sequences_match_idx
  on message_sequences (organization_id, subject_type, active);
create trigger message_sequences_touch before update on message_sequences
  for each row execute function touch_updated_at();

-- What a sequence is about and where it is read never change: its steps and the messages they
-- produced were made for that kind of record and that facility's clock.
create or replace function message_sequences_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.facility_id <> old.facility_id
     or new.subject_type <> old.subject_type then
    raise exception 'message sequence % cannot change its facility or what it is about', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger message_sequences_guard before update on message_sequences
  for each row execute function message_sequences_guard();

create table message_sequence_steps (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  sequence_id uuid not null,
  template_id uuid not null,
  position integer not null check (position between 1 and 500),
  anchor text not null check (anchor in (
    'registration_opens', 'registration_closes', 'starts', 'ends', 'first_game'
  )),
  offset_days integer not null check (offset_days between -365 and 365),
  -- Facility-local time of day; null: the time of the message sequence policy.
  send_time_local text check (send_time_local is null or send_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  retired_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- A scheduled message names its step together with the step's sequence.
  unique (organization_id, sequence_id, id),
  foreign key (organization_id, sequence_id) references message_sequences (organization_id, id),
  foreign key (organization_id, template_id) references message_templates (organization_id, id)
);
create index message_sequence_steps_sequence_idx
  on message_sequence_steps (organization_id, sequence_id, position, id);
create trigger message_sequence_steps_touch before update on message_sequence_steps
  for each row execute function touch_updated_at();

-- A step stays in its sequence, and a removed step is never brought back (its unsent messages
-- were canceled with it).
create or replace function message_sequence_steps_guard() returns trigger
language plpgsql as $$
begin
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.sequence_id <> old.sequence_id then
    raise exception 'message sequence step % cannot move to another sequence', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
    raise exception 'message sequence step % was removed and cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger message_sequence_steps_guard before update on message_sequence_steps
  for each row execute function message_sequence_steps_guard();

create table scheduled_messages (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  facility_id uuid not null,
  sequence_id uuid not null,
  sequence_step_id uuid not null,
  subject_type text not null check (subject_type in ('season', 'offering')),
  subject_id uuid not null,
  anchor_at timestamptz,                             -- the anchor date the due time counts from
  due_at timestamptz,                                -- null while the record has no such date
  status text not null default 'needs_confirmation' check (status in (
    'needs_confirmation', 'confirmed', 'skipped', 'sent', 'canceled'
  )),
  -- Why a message that had been confirmed needs confirming again.
  attention text check (attention is null or attention in (
    'anchor_moved', 'text_changed', 'no_audience', 'audience_too_large'
  )),
  -- The edited copy kept for this message only; the template is never changed by it.
  edited_title text check (edited_title is null or length(edited_title) between 1 and 200),
  edited_body text check (edited_body is null or length(edited_body) between 1 and 4000),
  edited_by jsonb,
  edited_at timestamptz,
  -- The exact text a staff member confirmed, which is the text that is sent.
  confirmed_title text check (confirmed_title is null or length(confirmed_title) between 1 and 200),
  confirmed_body text check (confirmed_body is null or length(confirmed_body) between 1 and 4000),
  confirmed_by jsonb,
  confirmed_at timestamptz,
  skipped_by jsonb,
  skipped_at timestamptz,
  skip_reason text check (skip_reason is null or length(skip_reason) between 1 and 2000),
  canceled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) between 1 and 200),
  notification_id uuid,                              -- the notification it produced when sent
  sent_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, facility_id) references facilities (organization_id, id),
  foreign key (organization_id, sequence_id) references message_sequences (organization_id, id),
  foreign key (organization_id, sequence_id, sequence_step_id)
    references message_sequence_steps (organization_id, sequence_id, id),
  foreign key (organization_id, notification_id) references notifications (organization_id, id),
  constraint scheduled_messages_edit_complete
    check ((edited_title is null) = (edited_body is null)
       and (edited_title is null) = (edited_at is null)
       and (edited_title is null) = (edited_by is null)),
  -- Confirmed and sent messages carry the confirmed text, who confirmed it, when, and a due time;
  -- no other state does, so a message that returns to needing confirmation keeps no stale text.
  constraint scheduled_messages_confirmed_fact
    check ((status in ('confirmed', 'sent')) = (confirmed_title is not null)
       and (confirmed_title is null) = (confirmed_body is null)
       and (confirmed_title is null) = (confirmed_at is null)
       and (confirmed_title is null) = (confirmed_by is null)
       and (status not in ('confirmed', 'sent') or due_at is not null)),
  -- A placeholder that could not be filled is never confirmed, so it is never sent as raw text.
  constraint scheduled_messages_no_raw_placeholder
    check (confirmed_title is null
       or (position('{{' in confirmed_title) = 0 and position('}}' in confirmed_title) = 0
       and position('{{' in confirmed_body) = 0 and position('}}' in confirmed_body) = 0)),
  constraint scheduled_messages_sent_fact
    check ((status = 'sent') = (notification_id is not null)
       and (status = 'sent') = (sent_at is not null)),
  constraint scheduled_messages_skipped_fact
    check ((status = 'skipped') = (skipped_at is not null)
       and (status = 'skipped') = (skipped_by is not null)
       and (status = 'skipped' or skip_reason is null)),
  constraint scheduled_messages_canceled_fact
    check ((status = 'canceled') = (canceled_at is not null)
       and (status = 'canceled') = (cancel_reason is not null)),
  constraint scheduled_messages_due_with_anchor
    check ((due_at is null) = (anchor_at is null)),
  constraint scheduled_messages_attention_state
    check (attention is null or status = 'needs_confirmation')
);
-- One scheduled message per sequence step and season or offering: a replayed event, a second
-- worker or a repeated "produce the schedule" creates nothing twice.
create unique index scheduled_messages_step_subject_idx
  on scheduled_messages (organization_id, sequence_step_id, subject_type, subject_id);
-- A notification is what one scheduled message produced.
create unique index scheduled_messages_notification_idx
  on scheduled_messages (organization_id, notification_id) where notification_id is not null;
create index scheduled_messages_subject_idx
  on scheduled_messages (organization_id, subject_type, subject_id, due_at, id);
-- The periodic job's read: confirmed messages that are due.
create index scheduled_messages_due_idx
  on scheduled_messages (due_at, id) where status = 'confirmed';
create trigger scheduled_messages_touch before update on scheduled_messages
  for each row execute function touch_updated_at();

-- needs_confirmation -> confirmed | skipped | canceled; confirmed -> sent | needs_confirmation |
-- skipped | canceled; skipped -> needs_confirmation | canceled; sent and canceled are final and
-- such a row is never changed again (what was sent stays what was sent). The step, the sequence
-- and the season or offering a message is about never change.
create or replace function scheduled_messages_guard() returns trigger
language plpgsql as $$
begin
  if old.status in ('sent', 'canceled') then
    raise exception 'scheduled message % is % and cannot be changed', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.facility_id <> old.facility_id
     or new.sequence_id <> old.sequence_id
     or new.sequence_step_id <> old.sequence_step_id
     or new.subject_type <> old.subject_type
     or new.subject_id <> old.subject_id
     or new.created_at <> old.created_at then
    raise exception 'scheduled message % cannot change its step or what it is about', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if (old.status = 'needs_confirmation' and new.status in ('confirmed', 'skipped', 'canceled'))
     or (old.status = 'confirmed'
         and new.status in ('sent', 'needs_confirmation', 'skipped', 'canceled'))
     or (old.status = 'skipped' and new.status in ('needs_confirmation', 'canceled')) then
    return new;
  end if;
  raise exception 'scheduled message % cannot move from % to %', old.id, old.status, new.status
    using errcode = 'check_violation', constraint = 'scheduled_messages_machine';
end
$$;
create trigger scheduled_messages_guard before update on scheduled_messages
  for each row execute function scheduled_messages_guard();
create trigger scheduled_messages_no_delete before delete on scheduled_messages
  for each row execute function forbid_mutation();

-- A message can only be inserted as needing confirmation: every other state is reached through
-- the guard above.
create or replace function scheduled_messages_insert_guard() returns trigger
language plpgsql as $$
begin
  if new.status <> 'needs_confirmation' then
    raise exception 'a scheduled message starts as needs_confirmation, not %', new.status
      using errcode = 'check_violation', constraint = 'scheduled_messages_machine';
  end if;
  return new;
end
$$;
create trigger scheduled_messages_insert_guard before insert on scheduled_messages
  for each row execute function scheduled_messages_insert_guard();
