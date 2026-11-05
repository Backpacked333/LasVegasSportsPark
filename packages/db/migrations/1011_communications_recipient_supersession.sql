-- 1011_communications_recipient_supersession.sql
-- Communications module, SPK-COMMS-005 "suppress obsolete unsent reminders", SPK-COMMS-004,
-- §4.12 (R4-COMMS-AUTOMATION-03 rework). A newer schedule notice that reaches only some of an
-- older notice's recipients (one team of a fixture, the one family support resends to) makes the
-- older notice obsolete for those people only. That fact is recorded on the recipient, durably,
-- so that every later step refuses to send the stale notice to them:
--   - dispatch never authorizes a recipient who carries it (no in-app, push, email or SMS copy of
--     a queued notice that was replaced for them before it went out);
--   - the delivery worker's hand-off and a staff retry refuse their attempts (NOTICE_SUPERSEDED);
--   - their inbox item shows the notice that replaced it.
-- Migration 1001 records the same for a notice replaced as a whole
-- (`notifications.superseded_by_notification_id`).
--
-- The database guarantees the part that matters: no delivery attempt (a dispatch, a retry) is
-- ever created for a recipient whose notice was replaced for them, or for a notice replaced as a
-- whole. The pointer, once set, is never cleared or moved to another notice.

alter table notification_recipients
  add column superseded_by_notification_id uuid,
  add column superseded_at timestamptz;
alter table notification_recipients
  add constraint notification_recipients_superseded_by
    foreign key (organization_id, superseded_by_notification_id)
    references notifications (organization_id, id),
  add constraint notification_recipients_superseded_pair
    check ((superseded_by_notification_id is null) = (superseded_at is null)),
  add constraint notification_recipients_superseded_not_self
    check (superseded_by_notification_id is null or superseded_by_notification_id <> notification_id);

create or replace function notification_recipients_supersession_fixed() returns trigger
language plpgsql as $$
begin
  if old.superseded_by_notification_id is not null
     and (new.superseded_by_notification_id is distinct from old.superseded_by_notification_id
          or new.superseded_at is distinct from old.superseded_at) then
    raise exception 'recipient % was already superseded by notification %; the fact is not rewritten',
      old.id, old.superseded_by_notification_id
      using errcode = 'check_violation', constraint = 'notification_recipients_supersession_fixed';
  end if;
  return new;
end;
$$;

create trigger notification_recipients_supersession_fixed
  before update of superseded_by_notification_id, superseded_at on notification_recipients
  for each row execute function notification_recipients_supersession_fixed();

create or replace function delivery_attempts_supersession_guard() returns trigger
language plpgsql as $$
declare
  replaced uuid;
begin
  select coalesce(r.superseded_by_notification_id, n.superseded_by_notification_id) into replaced
    from notification_recipients r
    join notifications n on n.organization_id = r.organization_id and n.id = r.notification_id
   where r.organization_id = new.organization_id and r.id = new.recipient_id;
  if replaced is not null then
    raise exception 'delivery attempt % would send a notice that notification % replaced for its recipient',
      new.id, replaced
      using errcode = 'check_violation', constraint = 'delivery_attempts_supersession_guard';
  end if;
  return new;
end;
$$;

create trigger delivery_attempts_supersession_guard
  before insert on delivery_attempts
  for each row execute function delivery_attempts_supersession_guard();
