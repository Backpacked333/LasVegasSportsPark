-- §4.3, §4.7 invariant 1: references to kernel operations, audit records and operational
-- exceptions are organization-scoped composite foreign keys (targets added in
-- 0005_core_org_scoped_keys.sql). Numbered high in the range so it cannot collide with the
-- module's next schema change.
-- The organization guard triggers of 1400 stay: they fire first and keep their messages.
alter table assistant_requests
  drop constraint assistant_requests_operation_id_fkey,
  add constraint assistant_requests_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
alter table recommendations
  drop constraint recommendations_apply_operation_id_fkey,
  drop constraint recommendations_applied_command_operation_id_fkey,
  drop constraint recommendations_applied_audit_record_id_fkey,
  add constraint recommendations_apply_operation_fk
    foreign key (organization_id, apply_operation_id) references operations (organization_id, id),
  add constraint recommendations_applied_command_operation_fk
    foreign key (organization_id, applied_command_operation_id)
    references operations (organization_id, id),
  add constraint recommendations_applied_audit_record_fk
    foreign key (organization_id, applied_audit_record_id)
    references audit_records (organization_id, id);
alter table tool_invocations
  drop constraint tool_invocations_operation_id_fkey,
  add constraint tool_invocations_operation_fk
    foreign key (organization_id, operation_id) references operations (organization_id, id);
