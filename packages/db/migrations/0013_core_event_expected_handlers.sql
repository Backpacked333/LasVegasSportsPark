-- 0013_core_event_expected_handlers.sql
-- §4.7 invariant 12 (no lost required follow-up after a committed operation), §4.12, SPK-AT-023,
-- §5.8 software rollback (R3-OPERATIONS-01). An event used to be settled once the handlers of the
-- build that happened to process it had run, even when that build registered none for its type.
-- A worker of an older build (during a rollback or a rolling deploy) therefore consumed for good
-- the events a newer build produced, and the newer build's handlers never ran for them, with no
-- dead letter.
--
-- Each event now records, when it is written, the handlers the producing build registers for it.
-- A build that lacks one of them runs the handlers it has and leaves the event pending (not counted
-- as an attempt) until a build that registers the missing handler runs it; event_consumptions keeps
-- every handler that already ran from running again. A handler removed on purpose is declared
-- retired (EventHandlerRegistry.retire), so events recorded before its removal do not wait for it.
--
-- null: a row written before this migration; no expectation is known and the event is settled by
-- the handlers the processing build registers, as before. Inbox names are the consumption names
-- (`inbox:<provider>:<handler>`).
alter table outbox_events add column expected_handlers text[];
alter table inbox_events add column expected_handlers text[];
