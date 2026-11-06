-- 0685_finance_payment_reminders.sql
-- Payment reminders for past-due obligations (SPK-COMMS-002 "payment attention", SPK-PAY-004,
-- SPK-PAY-006; park UI redesign gap "payment reminder command"). A reminder is a fact: finance
-- staff asked for the debtor to be told an obligation is past due, with the balance and due date
-- as they stood at that moment. The notice itself is composed by finance's event handler through
-- the communications service (essential `payment_attention`; channel approval pending DEC-062);
-- this table never stores a message or a contact detail.
--
-- Append-only (corrections are new facts). The remaining balance is the obligation's amount less
-- what was allocated to it when the reminder was recorded; a reminder for an obligation with
-- nothing left to pay, or not yet due, is refused here as well as in the service.
create table payment_reminders (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  obligation_id uuid not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  remaining_minor bigint not null constraint payment_reminders_remaining check (remaining_minor > 0),
  due_at timestamptz not null,
  -- Who is told: the debtor person, or the responsible payer of a team obligation (SPK-PAY-004).
  recipient_person_id uuid not null,
  reason text check (reason is null or length(reason) between 1 and 2000),
  requested_by jsonb not null,
  requested_by_person_id uuid,
  requested_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, obligation_id, currency)
    references obligations (organization_id, id, currency),
  -- A reminder is only for an obligation already past its due date when it was requested.
  constraint payment_reminders_past_due check (requested_at > due_at)
);
create index payment_reminders_obligation_idx
  on payment_reminders (organization_id, obligation_id, requested_at desc);
create trigger payment_reminders_append_only before update or delete on payment_reminders
  for each row execute function forbid_mutation();
