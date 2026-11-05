-- 0015_core_event_handler_wait.sql
-- §5.11 ("monitor worker age and retries"; "operational issues must have owners"), §4.7 invariant
-- 12, §4.12 (completing R3-OPERATIONS-01). An outbox or inbox event whose producing build expected
-- a handler the processing build lacks waits, pending and uncounted (migration 0013). Nothing
-- bounded that wait: a later build that renamed or dropped a handler without declaring it retired
-- left every event recorded before the deploy pending for good, with no attempt counted, no dead
-- letter and no exception; the only signal was a warn log every retry.
--
-- waiting_since: when the event was first left waiting for a missing handler; null while it is not
-- waiting (and once it settles). After OUTBOX_MISSING_HANDLER_ESCALATE_AFTER_SECONDS of waiting the
-- worker raises an owned operational exception (reliability.outbox_waiting_for_handler or
-- reliability.inbox_waiting_for_handler, system administration) that names the missing handlers,
-- and resolves it when the event settles.
alter table outbox_events add column waiting_since timestamptz;
alter table inbox_events add column waiting_since timestamptz;
