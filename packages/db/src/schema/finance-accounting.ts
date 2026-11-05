import type { Generated } from 'kysely';
import type { GeneratedTimestamp, Json, NullableTimestamp, Timestamp } from './core';
import type { LedgerAccountCode } from './finance';

/**
 * Finance accounting export tables (migration 0608, FIN-07; §3.16 Accounting row, SPK-PAY-010,
 * SPK-PAY-011, §5.2 accounting gate). Behind the per-organization capability `accounting`
 * (DEC-016, DEC-081); the accounting connection is pending DEC-022.
 */

export type AccountingMappingStatus = 'proposed' | 'approved' | 'retired';
export interface AccountingMappingsTable {
  id: string;
  organization_id: string;
  ledger_account: LedgerAccountCode;
  external_account_ref: string;
  status: Generated<AccountingMappingStatus>;
  proposed_by: Json<Record<string, unknown>>;
  proposed_by_person_id: string;
  approved_by: Json<Record<string, unknown>> | null;
  approved_by_person_id: string | null;
  approved_at: NullableTimestamp;
  retired_at: NullableTimestamp;
  retire_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type AccountingExportBatchStatus =
  'prepared' | 'submitted' | 'accepted' | 'rejected' | 'unknown' | 'canceled';
export interface AccountingExportBatchesTable {
  id: string;
  organization_id: string;
  period_start: Timestamp;
  period_end: Timestamp;
  status: Generated<AccountingExportBatchStatus>;
  idempotency_key: string;
  checksum: string;
  line_count: number;
  provider_reference: string | null;
  last_error: string | null;
  prepared_by: Json<Record<string, unknown>>;
  prepared_by_person_id: string | null;
  prepared_at: Timestamp;
  submitted_at: NullableTimestamp;
  decided_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AccountingExportLinesTable {
  id: string;
  organization_id: string;
  batch_id: string;
  journal_entry_id: string;
  line_number: number;
  ledger_account: LedgerAccountCode;
  external_account_ref: string;
  debit_minor: Generated<number>;
  credit_minor: Generated<number>;
  currency: string;
  posted_at: Timestamp;
  memo: string;
  live: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

export interface FinanceAccountingTables {
  accounting_mappings: AccountingMappingsTable;
  accounting_export_batches: AccountingExportBatchesTable;
  accounting_export_lines: AccountingExportLinesTable;
}
