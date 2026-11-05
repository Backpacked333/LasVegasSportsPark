-- §4.3, §4.7 invariant 1: references to kernel operations, audit records and operational
-- exceptions are organization-scoped composite foreign keys (targets added in
-- 0005_core_org_scoped_keys.sql). Numbered high in the range so it cannot collide with the
-- module's next schema change.
-- The organization guard triggers of 1100 stay: they fire first and keep their messages.
alter table cases
  drop constraint cases_origin_exception_id_fkey,
  add constraint cases_origin_exception_fk
    foreign key (organization_id, origin_exception_id)
    references operational_exceptions (organization_id, id);
alter table case_actions
  drop constraint case_actions_command_operation_id_fkey,
  drop constraint case_actions_support_operation_id_fkey,
  drop constraint case_actions_audit_record_id_fkey,
  add constraint case_actions_command_operation_fk
    foreign key (organization_id, command_operation_id) references operations (organization_id, id),
  add constraint case_actions_support_operation_fk
    foreign key (organization_id, support_operation_id) references operations (organization_id, id),
  add constraint case_actions_audit_record_fk
    foreign key (organization_id, audit_record_id) references audit_records (organization_id, id);
