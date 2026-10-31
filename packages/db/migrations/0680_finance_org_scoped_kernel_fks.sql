-- §4.3, §4.7 invariant 1: references to kernel operations, audit records and operational
-- exceptions are organization-scoped composite foreign keys (targets added in
-- 0005_core_org_scoped_keys.sql). Numbered high in the range so it cannot collide with the
-- module's next schema change.
alter table checkouts
  drop constraint checkouts_operation_id_fkey,
  add constraint checkouts_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
alter table refund_attempts
  drop constraint refund_attempts_operation_id_fkey,
  add constraint refund_attempts_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
