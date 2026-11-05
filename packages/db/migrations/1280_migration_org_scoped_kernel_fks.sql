-- §4.3, §4.7 invariant 1: references to kernel operations, audit records and operational
-- exceptions are organization-scoped composite foreign keys (targets added in
-- 0005_core_org_scoped_keys.sql). Numbered high in the range so it cannot collide with the
-- module's next schema change.
alter table import_batches
  drop constraint import_batches_apply_lock_operation_id_fkey,
  drop constraint import_batches_applied_operation_id_fkey,
  add constraint import_batches_apply_lock_operation_fk
    foreign key (organization_id, apply_lock_operation_id) references operations (organization_id, id),
  add constraint import_batches_applied_operation_fk
    foreign key (organization_id, applied_operation_id) references operations (organization_id, id);
