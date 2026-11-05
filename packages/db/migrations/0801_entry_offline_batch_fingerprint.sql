-- 0801_entry_offline_batch_fingerprint.sql
-- §4.9 ("the same key with different contents returns a conflict"), §4.15 / SPK-AT-018
-- (observations synchronize once, never zero times), §4.14 (object-level authorization).
--
-- A re-uploaded offline batch (same device and client batch id) replays its stored outcome only
-- when it carries the same facility, snapshot and items. The request fingerprint is the SHA-256 of
-- that canonical content, written once with the batch (the table stays append-only). Batches
-- stored before this migration carry null and are compared by facility, snapshot and item ids.
alter table offline_sync_batches
  add column request_fingerprint text
    constraint offline_sync_batches_request_fingerprint_check
    check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$');
