-- SPK-COMMS-005 "suppress obsolete unsent reminders": an unsent push/email/SMS attempt of a
-- schedule notice that a newer change or cancellation superseded is failed with failure code
-- SUPERSEDED before any hand-off, like RECIPIENT_REVOKED for a revoked recipient. Migration 1000
-- listed the failure codes in an inline column check (named delivery_attempts_failure_code_check);
-- it is replaced with the same list plus SUPERSEDED.

alter table delivery_attempts drop constraint delivery_attempts_failure_code_check;
alter table delivery_attempts add constraint delivery_attempts_failure_code_check check (
  failure_code is null or failure_code in (
    'RECIPIENT_REVOKED', 'NO_ADDRESS', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'SUPERSEDED'
  )
);
