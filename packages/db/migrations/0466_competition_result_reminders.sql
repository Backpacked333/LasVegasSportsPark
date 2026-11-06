-- 0466_competition_result_reminders.sql
-- Result reminders: league staff nudge the captains of a fixture whose result is missing after
-- the game (SPK-RESULT-001 official standings wait for a result, SPK-UX-006 the "needs your call"
-- queue). Each reminder is an append-only fact; its recipients are named in the audit record and
-- in `competition.result_reminder_requested`, from which communications delivers the notice (no
-- channel is chosen here, DEC-012 / DEC-062). The row keeps how many captains it reached.
create table result_reminders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  fixture_id uuid not null,
  requested_by jsonb not null,
  requested_by_person_id uuid,
  message text check (message is null or length(message) between 1 and 500),
  requested_at timestamptz not null,
  recipient_count integer not null check (recipient_count >= 0),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, fixture_id) references fixtures (organization_id, id),
  foreign key (organization_id, requested_by_person_id) references persons (organization_id, id)
);
create index result_reminders_fixture_idx
  on result_reminders (organization_id, fixture_id, requested_at desc);
create trigger result_reminders_append_only before update or delete on result_reminders
  for each row execute function forbid_mutation();
