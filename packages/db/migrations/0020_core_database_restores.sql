-- §5.8 recovery, SPK-AT-028 (recovery runbook §5.3): every restore of this database from a
-- backup, written by db:restore once the restored rows and applied migrations equal the backup
-- manifest's, so the restore instant, the backup and the operator are facts in the database the
-- processes start on. RecoveryMode reads it at boot for RECOVERY_RESTORE_REFERENCE and carries it
-- into the reliability.recovery_mode exception and the operations.recovery_entered audit record.
-- Append-only: a wrong row is answered by a later row that references it, never edited.
--
-- Documented exception to "every operational table has organization_id" (CLAUDE.md): a restore
-- is a fact about the whole database, like schema_migrations and periodic_job_leases; no
-- organization is known when the CLI runs, before any process starts.
create table database_restores (
  id uuid primary key,
  backup_id text not null check (length(backup_id) between 1 and 200),
  backup_taken_at timestamptz not null,
  migrations_digest text not null check (length(migrations_digest) between 1 and 128),
  restored_at timestamptz not null,
  restored_by text not null check (length(restored_by) between 1 and 200),
  app_version text check (app_version is null or length(app_version) between 1 and 200),
  schema_current boolean not null,
  verification jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index database_restores_backup_idx on database_restores (backup_id, restored_at desc);
create trigger database_restores_append_only
  before update or delete on database_restores
  for each row execute function forbid_mutation();
