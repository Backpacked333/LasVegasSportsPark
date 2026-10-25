-- §4.3, §4.7 invariant 1: references to kernel operations, audit records and operational
-- exceptions are organization-scoped composite foreign keys (targets added in
-- 0005_core_org_scoped_keys.sql). Numbered high in the range so it cannot collide with the
-- module's next schema change.
alter table fee_export_batches
  drop constraint fee_export_batches_operation_id_fkey,
  add constraint fee_export_batches_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
