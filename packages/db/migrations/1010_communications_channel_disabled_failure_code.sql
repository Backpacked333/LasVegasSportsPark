-- 1010_communications_channel_disabled_failure_code.sql
-- Communications module, R4-COMMS-AUTOMATION-05 (SPK-COMMS-007 "essential operational
-- communications and promotional preferences must be separately represented", SPK-COMMS-001):
-- the delivery worker re-reads the recipient's channel preferences inside the hand-off claim
-- transaction, immediately before a push/email/SMS attempt is handed to a provider. An attempt on
-- a channel the person switched off after dispatch queued it (or after a staff retry, or while
-- the organization was paused in recovery) is failed with failure code CHANNEL_DISABLED and never
-- handed over, like SUPERSEDED for an obsolete notice. Migration 1001 lists the failure codes in
-- the check constraint `delivery_attempts_failure_code_check`; it is replaced with the same list
-- plus CHANNEL_DISABLED. A CHANNEL_DISABLED attempt may be retried once the person switches the
-- channel on again (the retry service re-checks the preference; the 1005 retry guard is unchanged).

alter table delivery_attempts drop constraint delivery_attempts_failure_code_check;
alter table delivery_attempts add constraint delivery_attempts_failure_code_check check (
  failure_code is null or failure_code in (
    'RECIPIENT_REVOKED', 'NO_ADDRESS', 'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'SUPERSEDED',
    'CHANNEL_DISABLED'
  )
);
