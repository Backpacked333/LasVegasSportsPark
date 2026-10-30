import type { Generated } from 'kysely';
import type {
  GeneratedJson,
  GeneratedTimestamp,
  Json,
  JsonObject,
  MinorUnits,
  NullableTimestamp,
  Timestamp,
} from './core';

/**
 * Finance module tables (migration 0600, specification §3.15 SPK-PAY-001..012, §4.4 Finance +
 * Accounting support, §4.6 PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7,
 * §4.11). Money is bigint minor units (read as safe-integer numbers) next to a currency.
 */

type GeneratedMinor = Generated<number>;

export type QuoteStatus = 'active' | 'expired' | 'consumed';
export type PaymentPlanKind = 'full' | 'installments';
export interface QuotesTable {
  id: string;
  organization_id: string;
  basket_id: string;
  payer_person_id: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  currency: string;
  subtotal_minor: MinorUnits;
  discount_minor: MinorUnits;
  tax_minor: MinorUnits;
  fee_minor: MinorUnits;
  included_tax_minor: GeneratedMinor;
  total_minor: MinorUnits;
  credits_applied_minor: GeneratedMinor;
  due_now_minor: MinorUnits;
  future_minor: GeneratedMinor;
  payment_plan: Generated<PaymentPlanKind>;
  future_obligations: GeneratedJson<JsonObject>;
  applied_credits: GeneratedJson<JsonObject>;
  discount_codes: GeneratedJson<JsonObject>;
  discounts: GeneratedJson<JsonObject>;
  policy_references: Json<Record<string, unknown>>;
  basket_revision: number;
  status: Generated<QuoteStatus>;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  consumed_by_checkout_id: string | null;
  expired_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface QuoteLinesTable {
  id: string;
  organization_id: string;
  quote_id: string;
  sequence: number;
  basket_line_id: string;
  participant_person_id: string;
  offering_id: string;
  description: string;
  quantity: number;
  price_rule_id: string | null;
  unit_price_minor: MinorUnits;
  base_amount_minor: MinorUnits;
  discount_minor: GeneratedMinor;
  tax_minor: GeneratedMinor;
  fee_minor: GeneratedMinor;
  included_tax_minor: GeneratedMinor;
  total_minor: MinorUnits;
  currency: string;
  discount_lines: GeneratedJson<JsonObject>;
  charge_lines: GeneratedJson<JsonObject>;
  policy_references: Json<Record<string, unknown>>;
  equivalence_key: string | null;
  enrollment_id: string | null;
  created_at: GeneratedTimestamp;
}

export type OrderPaymentStatus = 'awaiting_payment' | 'paid' | 'canceled';
export type OrderFulfillmentStatus =
  'pending' | 'fulfilled' | 'recovery_required' | 'compensated' | 'canceled';
export interface OrdersTable {
  id: string;
  organization_id: string;
  quote_id: string;
  basket_id: string;
  payer_person_id: string;
  currency: string;
  total_minor: MinorUnits;
  credits_applied_minor: GeneratedMinor;
  due_now_minor: MinorUnits;
  payment_status: Generated<OrderPaymentStatus>;
  fulfillment_status: Generated<OrderFulfillmentStatus>;
  paid_at: NullableTimestamp;
  fulfilled_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  policy_references: Json<Record<string, unknown>>;
  created_by: Json<Record<string, unknown>>;
  created_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OrderLinesTable {
  id: string;
  organization_id: string;
  order_id: string;
  quote_line_id: string;
  sequence: number;
  basket_line_id: string;
  enrollment_id: string | null;
  participant_person_id: string;
  offering_id: string;
  description: string;
  quantity: number;
  price_rule_id: string | null;
  unit_price_minor: MinorUnits;
  base_amount_minor: MinorUnits;
  discount_minor: GeneratedMinor;
  tax_minor: GeneratedMinor;
  fee_minor: GeneratedMinor;
  total_minor: MinorUnits;
  currency: string;
  price_basis: Json<Record<string, unknown>>;
  policy_references: Json<Record<string, unknown>>;
  created_at: GeneratedTimestamp;
}

export type InstallmentPlanStatus = 'active' | 'completed' | 'defaulted' | 'canceled';
export interface InstallmentPlansTable {
  id: string;
  organization_id: string;
  order_id: string;
  payer_person_id: string;
  currency: string;
  total_minor: MinorUnits;
  installment_count: number;
  status: Generated<InstallmentPlanStatus>;
  payment_authorization: Json<Record<string, unknown>>;
  retry_policy: Json<Record<string, unknown>>;
  notice_policy: Json<Record<string, unknown>>;
  policy_version_id: string | null;
  created_by: Json<Record<string, unknown>>;
  completed_at: NullableTimestamp;
  defaulted_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ObligationDebtorKind = 'person' | 'team_entry';
export type ObligationMode = 'individual' | 'single_team_payer' | 'team_with_contributions';
export type ObligationSourceKind = 'order' | 'installment' | 'team_fee' | 'manual';
export type ObligationStatus = 'open' | 'settled' | 'written_off' | 'canceled';
export interface ObligationsTable {
  id: string;
  organization_id: string;
  debtor_kind: ObligationDebtorKind;
  debtor_person_id: string | null;
  debtor_team_entry_id: string | null;
  mode: ObligationMode;
  responsible_payer_person_id: string | null;
  source_kind: ObligationSourceKind;
  source_id: string | null;
  order_id: string | null;
  installment_plan_id: string | null;
  description: string;
  amount_minor: MinorUnits;
  allocated_minor: GeneratedMinor;
  currency: string;
  due_at: Timestamp;
  status: Generated<ObligationStatus>;
  settled_at: NullableTimestamp;
  written_off_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  status_reason: string | null;
  created_by: Json<Record<string, unknown>>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type InstallmentStatus = 'scheduled' | 'paid' | 'failed' | 'canceled';
export interface InstallmentsTable {
  id: string;
  organization_id: string;
  plan_id: string;
  sequence: number;
  obligation_id: string;
  amount_minor: MinorUnits;
  currency: string;
  due_at: Timestamp;
  original_due_at: Timestamp;
  status: Generated<InstallmentStatus>;
  attempt_count: Generated<number>;
  last_attempt_at: NullableTimestamp;
  last_failure_reason: string | null;
  next_retry_at: NullableTimestamp;
  paid_at: NullableTimestamp;
  failed_at: NullableTimestamp;
  extension_count: Generated<number>;
  extension_reason: string | null;
  notice_sent_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type ContributionRequestStatus = 'requested' | 'paid' | 'canceled';
export interface ContributionRequestsTable {
  id: string;
  organization_id: string;
  obligation_id: string;
  obligation_mode: Generated<'team_with_contributions'>;
  requested_person_id: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  amount_minor: MinorUnits;
  currency: string;
  message: string | null;
  status: Generated<ContributionRequestStatus>;
  receipt_id: string | null;
  paid_at: NullableTimestamp;
  canceled_at: NullableTimestamp;
  cancel_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CheckoutStatusValue =
  | 'prepared'
  | 'awaiting_payment'
  | 'finalizing'
  | 'completed'
  | 'recovery_required'
  | 'compensated'
  | 'aborted';
export type CheckoutPaymentKind = 'provider' | 'cash' | 'none';
export interface CheckoutsTable {
  id: string;
  organization_id: string;
  quote_id: string;
  order_id: string;
  basket_id: string;
  payer_person_id: string;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  status: Generated<CheckoutStatusValue>;
  payment_kind: CheckoutPaymentKind;
  hold_ids: GeneratedJson<string[]>;
  enrollment_ids: GeneratedJson<string[]>;
  payment_attempt_id: string | null;
  cash_tender_id: string | null;
  operation_id: string;
  failure_code: string | null;
  failure_details: Json<Record<string, unknown>> | null;
  recovery: Json<Record<string, unknown>> | null;
  recovery_attempts: Generated<number>;
  completed_at: NullableTimestamp;
  aborted_at: NullableTimestamp;
  compensated_at: NullableTimestamp;
  recovery_required_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type PaymentAttemptPurpose =
  'checkout' | 'obligation' | 'contribution' | 'installment' | 'pos_sale';
export type PaymentAttemptStatusValue =
  'created' | 'action_required' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type EvidenceSource = 'sync_response' | 'webhook' | 'reconciliation';
export interface PaymentAttemptsTable {
  id: string;
  organization_id: string;
  purpose: PaymentAttemptPurpose;
  checkout_id: string | null;
  order_id: string | null;
  obligation_id: string | null;
  contribution_request_id: string | null;
  installment_id: string | null;
  /** FIN-06 (migration 0607): the point-of-sale sale a card tender pays. */
  pos_sale_id: string | null;
  payer_person_id: string;
  amount_minor: MinorUnits;
  currency: string;
  provider: string;
  payment_method_ref: string;
  provider_reference: string | null;
  status: Generated<PaymentAttemptStatusValue>;
  action_required_payload: Json<Record<string, unknown>> | null;
  failure_reason: string | null;
  processor_fee_minor: MinorUnits | null;
  evidence_source: EvidenceSource | null;
  evidence_inbox_event_id: string | null;
  evidence_sequence: number | null;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  submitted_at: NullableTimestamp;
  unknown_since: NullableTimestamp;
  resolved_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CashTenderKind = 'cash' | 'check' | 'external_terminal';
export interface CashTendersTable {
  id: string;
  organization_id: string;
  facility_id: string;
  tender_kind: CashTenderKind;
  payer_person_id: string;
  amount_minor: MinorUnits;
  currency: string;
  obligation_id: string | null;
  checkout_id: string | null;
  evidence: Json<Record<string, unknown>>;
  recorded_by: Json<Record<string, unknown>>;
  recorded_by_person_id: string;
  recorded_at: Timestamp;
  status: Generated<'recorded' | 'reconciled'>;
  reconciliation_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type LedgerAccountCode =
  | 'customer_receivable'
  | 'cash_processor'
  | 'deferred_revenue'
  | 'credits_payable'
  | 'processor_fees'
  | 'refunds'
  | 'cash_on_hand'
  | 'overpayment_liability'
  // FIN-06 (migration 0607): point-of-sale revenue, approved taxes and fees (DEC-057).
  | 'pos_revenue'
  | 'taxes_payable'
  | 'fees_payable';
export interface JournalsTable {
  id: string;
  organization_id: string;
  source_type: string;
  source_id: string;
  purpose: string;
  description: string;
  currency: string;
  reversal_of_journal_id: string | null;
  posted_at: Timestamp;
  posted_by: Json<Record<string, unknown>>;
  correlation_id: string | null;
  operation_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface JournalEntriesTable {
  id: string;
  organization_id: string;
  journal_id: string;
  line_number: number;
  account_code: LedgerAccountCode;
  debit_minor: GeneratedMinor;
  credit_minor: GeneratedMinor;
  currency: string;
  person_id: string | null;
  order_id: string | null;
  obligation_id: string | null;
  reversal_of_entry_id: string | null;
  memo: string | null;
  created_at: GeneratedTimestamp;
}

export interface ReceiptsTable {
  id: string;
  organization_id: string;
  source_kind: 'payment_attempt' | 'cash_tender';
  payment_attempt_id: string | null;
  cash_tender_id: string | null;
  payer_person_id: string;
  amount_minor: MinorUnits;
  allocated_minor: MinorUnits;
  excess_minor: MinorUnits;
  currency: string;
  processor_fee_minor: GeneratedMinor;
  order_id: string | null;
  obligation_id: string | null;
  journal_id: string;
  received_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface PaymentRefundablesTable {
  payment_attempt_id: string;
  organization_id: string;
  /** The receipt of a captured payment; null for a point-of-sale card tender (0607). */
  receipt_id: string | null;
  /** FIN-06: the point-of-sale card tender whose capture this is (exactly one of the two). */
  pos_tender_id: string | null;
  currency: string;
  captured_minor: MinorUnits;
  refunded_minor: GeneratedMinor;
  reserved_minor: GeneratedMinor;
  /** MONEY-02 (0612): what a compensation credit took from these funds; only accumulates. */
  compensated_minor: GeneratedMinor;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type RefundStatusValue =
  'requested' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type RefundPurpose = 'customer_refund' | 'compensation';
export type RefundReservationStatus = 'reserved' | 'settled' | 'released';
export interface RefundAttemptsTable {
  id: string;
  organization_id: string;
  payment_attempt_id: string;
  amount_minor: MinorUnits;
  currency: string;
  purpose: Generated<RefundPurpose>;
  checkout_id: string | null;
  status: Generated<RefundStatusValue>;
  reservation_status: Generated<RefundReservationStatus>;
  reason: string;
  provider: string;
  provider_reference: string | null;
  failure_reason: string | null;
  evidence_source: EvidenceSource | null;
  evidence_inbox_event_id: string | null;
  evidence_sequence: number | null;
  requested_by: Json<Record<string, unknown>>;
  requested_by_person_id: string | null;
  operation_id: string | null;
  submitted_at: NullableTimestamp;
  unknown_since: NullableTimestamp;
  resolved_at: NullableTimestamp;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type CreditSourceKind = 'overpayment' | 'compensation' | 'goodwill' | 'adjustment';
export type CreditStatusValue = 'pending_approval' | 'active' | 'exhausted' | 'expired' | 'revoked';
export interface CreditsTable {
  id: string;
  organization_id: string;
  owner_person_id: string;
  currency: string;
  original_minor: MinorUnits;
  remaining_minor: MinorUnits;
  permitted_uses: Json<string[]>;
  source_kind: CreditSourceKind;
  source_id: string | null;
  status: CreditStatusValue;
  expires_at: NullableTimestamp;
  reason: string;
  issued_by: Json<Record<string, unknown>>;
  issued_by_person_id: string | null;
  approved_at: NullableTimestamp;
  approved_by: Json<Record<string, unknown>> | null;
  revoked_at: NullableTimestamp;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CreditRedemptionsTable {
  id: string;
  organization_id: string;
  credit_id: string;
  kind: 'redeem' | 'reversal';
  amount_minor: MinorUnits;
  currency: string;
  reference_type: string;
  reference_id: string;
  reverses_redemption_id: string | null;
  actor: Json<Record<string, unknown>>;
  redeemed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface PaymentAllocationsTable {
  id: string;
  organization_id: string;
  obligation_id: string;
  source_kind: 'receipt' | 'credit_redemption';
  receipt_id: string | null;
  credit_redemption_id: string | null;
  amount_minor: MinorUnits;
  currency: string;
  allocated_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export type SettlementKind = 'processor_settlement' | 'cash_drawer';
export interface SettlementReconciliationsTable {
  id: string;
  organization_id: string;
  kind: SettlementKind;
  provider: string | null;
  facility_id: string | null;
  period_start: Timestamp;
  period_end: Timestamp;
  currency: string;
  expected_minor: MinorUnits;
  reported_minor: MinorUnits;
  difference_minor: MinorUnits;
  breakdown: Json<Record<string, unknown>>;
  status: 'balanced' | 'discrepancy';
  external_reference: string | null;
  notes: string | null;
  performed_by: Json<Record<string, unknown>>;
  performed_by_person_id: string | null;
  performed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface FinanceTables {
  quotes: QuotesTable;
  quote_lines: QuoteLinesTable;
  orders: OrdersTable;
  order_lines: OrderLinesTable;
  installment_plans: InstallmentPlansTable;
  obligations: ObligationsTable;
  installments: InstallmentsTable;
  contribution_requests: ContributionRequestsTable;
  checkouts: CheckoutsTable;
  payment_attempts: PaymentAttemptsTable;
  cash_tenders: CashTendersTable;
  journals: JournalsTable;
  journal_entries: JournalEntriesTable;
  receipts: ReceiptsTable;
  payment_refundables: PaymentRefundablesTable;
  refund_attempts: RefundAttemptsTable;
  credits: CreditsTable;
  credit_redemptions: CreditRedemptionsTable;
  payment_allocations: PaymentAllocationsTable;
  settlement_reconciliations: SettlementReconciliationsTable;
}
