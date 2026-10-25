-- §4.3, §4.7 invariant 1 (CLAUDE.md data rules): operations, audit records and operational
-- exceptions become targets of organization-scoped composite foreign keys, so a row can never
-- point at another organization's operation, audit record or exception. Each owning module
-- replaces its single-column references in a migration of its own range.
alter table operations
  add constraint operations_organization_id_id_key unique (organization_id, id);
alter table audit_records
  add constraint audit_records_organization_id_id_key unique (organization_id, id);
alter table operational_exceptions
  add constraint operational_exceptions_organization_id_id_key unique (organization_id, id);

alter table idempotency_keys
  drop constraint idempotency_keys_operation_id_fkey,
  add constraint idempotency_keys_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
