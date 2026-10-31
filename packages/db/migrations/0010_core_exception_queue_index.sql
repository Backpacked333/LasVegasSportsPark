-- §4.12 failure owner, SPK-UX-006 (K-10, IF-29): an owner queue lists its exceptions by status,
-- newest first.
create index operational_exceptions_queue_idx
  on operational_exceptions (organization_id, owner_queue, status, opened_at desc);
