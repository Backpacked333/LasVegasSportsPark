-- 0016_core_audit_correlation_index.sql
-- R3-PERFORMANCE-05 (§5.4, §5.10): creation-audit lookups by correlation id (migration
-- ImportTargets.recover / creationsFor) and by operation id (support AuditEvidence.ofOperation)
-- read every creation audit record of a type without an index on those columns, so a resumed
-- apply's recovery and reconciliation's unlinked_creation check scanned. Partial indexes: most
-- audit records carry neither id.
create index audit_records_correlation_idx on audit_records (organization_id, correlation_id)
  where correlation_id is not null;
create index audit_records_operation_idx on audit_records (organization_id, operation_id)
  where operation_id is not null;
