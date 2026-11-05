-- §4.14 audited privileged actions and §4.12 the provider inbox (K-08): the audit log is read by
-- actor and by action, newest first; provider events are read per organization and provider,
-- newest first (events not yet attributed to an organization are never listed).
create index audit_records_actor_idx
  on audit_records (organization_id, (actor ->> 'personId'), occurred_at desc);
create index audit_records_action_idx
  on audit_records (organization_id, action, occurred_at desc);
create index inbox_events_provider_idx
  on inbox_events (organization_id, provider, received_at desc)
  where organization_id is not null;
