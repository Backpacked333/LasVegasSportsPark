-- 1003_communications_recipient_scoped_keys.sql
-- Communications module: a delivery attempt or an acknowledgment belongs to a recipient of its own
-- notification (CLAUDE.md composite foreign keys, §4.7 "integrity that matters is enforced in the
-- database", SPK-COMMS-004 "messages must represent actual delivery states"). Migration 1000 is
-- applied and immutable; it referenced the notification and the recipient through two independent
-- keys, so a row for notification X could name a recipient row (person and authority basis) of
-- notification Y, and the inbox would show Y's content to X's recipient.
--
-- 1. notification_recipients gains `unique (organization_id, notification_id, id)`; attempts and
--    acknowledgments reference (organization_id, notification_id, recipient_id) through it.
-- 2. delivery_attempts gains `unique (organization_id, recipient_id, id)`; an acknowledgment's
--    delivery attempt is one of its own recipient's attempts.

alter table notification_recipients
  add constraint notification_recipients_notification_scoped_key
    unique (organization_id, notification_id, id);

alter table delivery_attempts
  add constraint delivery_attempts_recipient_of_notification
    foreign key (organization_id, notification_id, recipient_id)
    references notification_recipients (organization_id, notification_id, id),
  add constraint delivery_attempts_recipient_scoped_key
    unique (organization_id, recipient_id, id);

alter table notification_acknowledgments
  add constraint notification_acknowledgments_recipient_of_notification
    foreign key (organization_id, notification_id, recipient_id)
    references notification_recipients (organization_id, notification_id, id),
  add constraint notification_acknowledgments_attempt_of_recipient
    foreign key (organization_id, recipient_id, delivery_attempt_id)
    references delivery_attempts (organization_id, recipient_id, id);
