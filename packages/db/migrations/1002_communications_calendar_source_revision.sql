-- SPK-COMMS-008 stable calendar identities, §4.12 handlers tolerate reordering, §4.6 independent
-- facts never overwrite one another. The outbox does not order events per aggregate, so the
-- calendar projection records the scheduling event revision each entry was built from and never
-- applies an older one (scheduling.event_changed carries `revision`). Null for entries built
-- before the payload carried it; those keep the event-id ordering until their next change.

alter table calendar_entries add column source_revision integer
  check (source_revision is null or source_revision >= 1);
