-- 0014_core_dead_letter_replay.sql
-- §5.11 ("operational issues must have owners and supported resolution actions"), §4.12 ("workers
-- must tolerate interruption and replay"), SPK-UX-006 (R3-OPERATIONS-03). A dead-lettered outbox or
-- inbox event could only be re-run with direct SQL: nothing moved `dead` back to `pending`
-- (`received` for the inbox). POST /v1/outbox-events/{id}/replay and
-- POST /v1/provider-events/{id}/replay now do it as an audited command (OutboxEventMachine and
-- InboxEventMachine `replay`), with the attempts reset and the consumptions kept, so the handlers
-- that already ran are skipped. Each replay is counted here; the dispatcher resolves the
-- dead-letter exception once a replayed event is dispatched (or processed).
alter table outbox_events
  add column replay_count integer not null default 0 check (replay_count >= 0),
  add column replayed_at timestamptz;
alter table inbox_events
  add column replay_count integer not null default 0 check (replay_count >= 0),
  add column replayed_at timestamptz;
