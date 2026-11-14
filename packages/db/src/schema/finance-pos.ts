import type { ColumnType, Generated } from 'kysely';
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
/**
 * 0695 (SPK-PAY-016, proposed amendment PA-08): a line is a product line of one of the product
 * kinds, or an open-amount line (`open_amount`: no product, a typed description and a category).
 */
export type PosSaleLineKind = PosProductKind | 'open_amount';
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
  /** Null on an open-amount line (0695, constraint pos_sale_lines_shape). */
  product_id: string | null;
  /** Null on an open-amount line. */
  sku: string | null;
  /** The product's name as sold; on an open-amount line the reason category's approved label. */
  name: string;
  kind: PosSaleLineKind;
  unit_price_minor: MinorUnits;
  quantity: number;
  base_minor: MinorUnits;
  charges: GeneratedJson<PosLineChargeRecord[]>;
  charges_minor: GeneratedMinor;
  line_total_minor: MinorUnits;
  /** 0686: the line this one corrects (quantity change or removal, quantity 0); null otherwise. */
  supersedes_line_id: Generated<string | null>;
  /**
   * 0695, open-amount lines only (all null on a product line): the typed description, the reason
   * category code, the revenue category the line books to, who entered it, the ceiling that
   * applied to that person, whether the amount is above it (derived by the database), and the
   * approved policy version the category and ceiling came from (null: the engineering default).
   */
  description: Generated<string | null>;
  reason_category: Generated<string | null>;
  revenue_category: Generated<string | null>;
  entered_by: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  entered_by_person_id: Generated<string | null>;
  approval_ceiling_minor: Generated<number | null>;
  approval_required: Generated<boolean | null>;
  policy_version_id: Generated<string | null>;
  created_at: GeneratedTimestamp;
}

/**
 * 0696 (SPK-PAY-016): the second approval of an open-amount line above the ceiling of the person
 * who entered it. Append-only; one per line; the approver is never that person.
 */
export interface PosLineApprovalsTable {
  id: string;
  organization_id: string;
  sale_id: string;
  sale_line_id: string;
  currency: string;
  amount_minor: MinorUnits;
  ceiling_minor: MinorUnits;
  reason: string;
  approved_by: Json<Record<string, unknown>>;
  approved_by_person_id: string;
  approved_at: Timestamp;
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
  pos_line_approvals: PosLineApprovalsTable;
  pos_tenders: PosTendersTable;
  pos_returns: PosReturnsTable;
}
