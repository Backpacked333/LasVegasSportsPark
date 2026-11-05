-- §4.12 events are durable facts consumers may replay (K-07, IF-27): OutboxHistory pages the
-- committed events of one organization and event types by (occurred_at, id), whatever their
-- dispatch status, with a keyset cursor.
create index outbox_events_history_idx
  on outbox_events (organization_id, event_type, occurred_at, id);
