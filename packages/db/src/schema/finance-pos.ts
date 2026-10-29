import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  MinorUnits,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Finance point-of-sale tables (migration 0607, FIN-06; §3.16 POS row, SPK-PAY-002/008/010/012).
 * Behind the per-organization capability `point_of_sale` (DEC-016, DEC-079). Money is bigint minor
 * units next to a currency; a sale, its lines, tenders and returns share one currency.
 */

type GeneratedMinor = Generated<number>;

export type PosProductKind = 'merchandise' | 'concession' | 'service';
export type PosLifecycleStatus = 'active' | 'retired';

export interface PosProductsTable {
  id: string;
  organization_id: string;
  facility_id: string | null;
  sku: string;
  name: string;
  kind: PosProductKind;
  price_minor: MinorUnits;
  currency: string;
  status: Generated<PosLifecycleStatus>;
  retired_at: NullableTimestamp;
  retire_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PosProductChargesTable {
  organization_id: string;
  product_id: string;
  tax_fee_policy_key: string;
  position: number;
  created_at: GeneratedTimestamp;
}

export interface PosRegistersTable {
  id: string;
  organization_id: string;
  facility_id: string;
  code: string;
  name: string;
  status: Generated<PosLifecycleStatus>;
  retired_at: NullableTimestamp;
  retire_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PosRegisterSessionStatus = 'open' | 'closed';
export interface PosRegisterSessionsTable {
  id: string;
  organization_id: string;
  register_id: string;
  facility_id: string;
  currency: string;
  /** Facility-local opening date, `YYYYMMDD` (SPK-SCHED-008); sale numbers carry it. */
  business_date: string;
  opening_float_minor: MinorUnits;
  opened_by: Json<Record<string, unknown>>;
  opened_by_person_id: string;
  opened_at: Timestamp;
  next_sale_number: Generated<number>;
  status: Generated<PosRegisterSessionStatus>;
  counted_cash_minor: MinorUnits | null;
  expected_cash_minor: MinorUnits | null;
  variance_minor: MinorUnits | null;
  closed_by: Json<Record<string, unknown>> | null;
  closed_by_person_id: string | null;
  closed_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PosSaleStatus = 'open' | 'paid' | 'voided' | 'partially_returned' | 'returned';
export interface PosSalesTable {
  id: string;
  organization_id: string;
  register_session_id: string;
  facility_id: string;
  currency: string;
  sale_number: string;
  customer_person_id: string | null;
  status: Generated<PosSaleStatus>;
  subtotal_minor: GeneratedMinor;
  charges_minor: GeneratedMinor;
  total_minor: GeneratedMinor;
  paid_at: NullableTimestamp;
  void_reason: string | null;
  voided_at: NullableTimestamp;
  voided_by: Json<Record<string, unknown>> | null;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** One approved tax or fee applied to a sale line, with the policy version it came from. */
export interface PosLineChargeRecord {
  policyVersionId: string;
  code: string;
  label: string;
  kind: 'tax' | 'fee';
  amountMinor: number;
}

export interface PosSaleLinesTable {
  id: string;
  organization_id: string;
  sale_id: string;
  currency: string;
  line_number: number;
  product_id: string;
  sku: string;
  name: string;
  kind: PosProductKind;
  unit_price_minor: MinorUnits;
  quantity: number;
  base_minor: MinorUnits;
  charges: GeneratedJson<PosLineChargeRecord[]>;
  charges_minor: GeneratedMinor;
  line_total_minor: MinorUnits;
  created_at: GeneratedTimestamp;
}

export type PosTenderKind = 'cash' | 'card' | 'external';
export type PosTenderStatus = 'pending' | 'settled' | 'failed';
export interface PosTendersTable {
  id: string;
  organization_id: string;
  sale_id: string;
  currency: string;
  kind: PosTenderKind;
  amount_minor: MinorUnits;
  payment_attempt_id: string | null;
  evidence: Json<Record<string, unknown>> | null;
  status: PosTenderStatus;
  failure_reason: string | null;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string;
  recorded_at: Timestamp;
  settled_at: NullableTimestamp;
  failed_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

/** One returned line: quantity and the amounts returned (largest-remainder shares of the line). */
export interface PosReturnLineRecord {
  saleLineId: string;
  quantity: number;
  amountMinor: number;
  baseMinor: number;
  charges: Array<{ code: string; kind: 'tax' | 'fee'; amountMinor: number }>;
}

export interface PosReturnsTable {
  id: string;
  organization_id: string;
  sale_id: string;
  currency: string;
  lines: Json<PosReturnLineRecord[]>;
  amount_minor: MinorUnits;
  tender_kind: PosTenderKind;
  refund_attempt_id: string | null;
  register_session_id: string | null;
  evidence: Json<Record<string, unknown>> | null;
  reason: string;
  approved_by: Json<Record<string, unknown>>;
  approved_by_person_id: string;
  returned_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface FinancePosTables {
  pos_products: PosProductsTable;
  pos_product_charges: PosProductChargesTable;
  pos_registers: PosRegistersTable;
  pos_register_sessions: PosRegisterSessionsTable;
  pos_sales: PosSalesTable;
  pos_sale_lines: PosSaleLinesTable;
  pos_tenders: PosTendersTable;
  pos_returns: PosReturnsTable;
}
