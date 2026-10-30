/**
 * Staff-visible status labels for the point of sale (SCR-S-55), access hardware (SCR-S-56) and
 * accounting export (SCR-S-57) screens. Staff labels are the machine state names
 * (docs/package-a/journeys.md section 3, SPK-UX-010), always shown through `StatusBadge` with a
 * glyph and text, never by colour alone (SPK-UX-009). A sale is "paid" only when the API says so:
 * an open sale with a card tender whose outcome is unknown is labelled as such (SPK-PAY-007).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export interface Badge {
  tone: StatusTone;
  label: string;
}

type Labels<K extends string> = Readonly<Record<K, Badge>>;

// ---------------------------------------------------------------------------------------------
// Point of sale (FIN-06)
// ---------------------------------------------------------------------------------------------

export const POS_LIFECYCLE: Labels<Schema<'PosLifecycleStatus'>> = {
  active: { tone: 'success', label: 'active' },
  retired: { tone: 'neutral', label: 'retired' },
};

export const POS_PRODUCT_KIND: Readonly<Record<Schema<'PosProductKind'>, string>> = {
  merchandise: 'Merchandise',
  concession: 'Concession',
  service: 'Service',
};

export const POS_SESSION_STATUS: Labels<'open' | 'closed'> = {
  open: { tone: 'info', label: 'session open' },
  closed: { tone: 'neutral', label: 'session closed' },
};

export const POS_SALE_STATUS: Labels<Schema<'PosSaleStatus'>> = {
  open: { tone: 'pending', label: 'open: not paid' },
  paid: { tone: 'success', label: 'paid' },
  voided: { tone: 'neutral', label: 'voided' },
  partially_returned: { tone: 'info', label: 'partially_returned' },
  returned: { tone: 'neutral', label: 'returned' },
};

export const POS_TENDER_KIND: Readonly<Record<Schema<'PosTenderKind'>, string>> = {
  cash: 'Cash',
  card: 'Card',
  external: 'External (recorded with evidence)',
};

export const POS_TENDER_STATUS: Labels<Schema<'PosTender'>['status']> = {
  pending: { tone: 'pending', label: 'tender pending' },
  settled: { tone: 'success', label: 'tender settled' },
  failed: { tone: 'danger', label: 'tender failed' },
};

type CardPaymentStatus = NonNullable<Schema<'PosTender'>['paymentStatus']>;

/** The card payment's own status; `unknown` is recovery, never success (SPK-PAY-007). */
export const CARD_PAYMENT_STATUS: Labels<CardPaymentStatus> = {
  created: { tone: 'pending', label: 'card payment created' },
  action_required: { tone: 'pending', label: 'card payment needs a customer action' },
  processing: { tone: 'pending', label: 'card payment processing' },
  succeeded: { tone: 'success', label: 'card payment succeeded' },
  failed: { tone: 'danger', label: 'card payment failed' },
  canceled: { tone: 'neutral', label: 'card payment canceled' },
  unknown: { tone: 'warning', label: 'card payment outcome unknown' },
};

type RefundStatus = NonNullable<Schema<'PosReturn'>['refundStatus']>;

export const RETURN_REFUND_STATUS: Labels<RefundStatus> = {
  requested: { tone: 'pending', label: 'card refund requested' },
  processing: { tone: 'pending', label: 'card refund processing' },
  succeeded: { tone: 'success', label: 'card refund succeeded' },
  failed: { tone: 'danger', label: 'card refund failed' },
  canceled: { tone: 'neutral', label: 'card refund canceled' },
  unknown: { tone: 'warning', label: 'card refund outcome unknown' },
};

// ---------------------------------------------------------------------------------------------
// Access hardware (ENT-05)
// ---------------------------------------------------------------------------------------------

export const DEVICE_KIND: Readonly<Record<Schema<'AccessDeviceKind'>, string>> = {
  door: 'Door',
  turnstile: 'Turnstile',
  gate: 'Gate',
  scanner: 'Scanner',
};

export const DEVICE_STATUS: Labels<Schema<'AccessDevice'>['status']> = {
  active: { tone: 'success', label: 'active' },
  retired: { tone: 'neutral', label: 'retired' },
};

/** Observed health: `unknown` when no heartbeat timeout is configured (no default exists). */
export const DEVICE_HEALTH: Labels<Schema<'AccessDevice'>['health']> = {
  online: { tone: 'success', label: 'online' },
  offline: { tone: 'danger', label: 'offline: outage' },
  unknown: { tone: 'neutral', label: 'health unknown' },
};

export const POLICY_STATUS: Labels<Schema<'AccessPolicy'>['status']> = {
  draft: { tone: 'pending', label: 'draft: awaiting approval' },
  active: { tone: 'success', label: 'active' },
  retired: { tone: 'neutral', label: 'retired' },
};

export const COMMAND_KIND: Readonly<Record<Schema<'DeviceCommand'>['kind'], string>> = {
  revoke_credential: 'Revoke a credential',
  sync_policy: 'Synchronize the policy',
};

export const COMMAND_STATUS: Labels<Schema<'DeviceCommandStatus'>> = {
  pending: { tone: 'pending', label: 'pending delivery' },
  delivered: { tone: 'success', label: 'delivered' },
  failed: { tone: 'danger', label: 'failed: retried' },
  unknown: { tone: 'warning', label: 'outcome unknown: asked again' },
  superseded: { tone: 'neutral', label: 'superseded' },
};

export const WEEKDAYS: readonly { value: Schema<'Weekday'>; label: string }[] = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];

export const HOLDER_KINDS: readonly { value: 'person' | 'household'; label: string }[] = [
  { value: 'person', label: 'Personal passes' },
  { value: 'household', label: 'Household passes' },
];

// ---------------------------------------------------------------------------------------------
// Accounting export (FIN-07)
// ---------------------------------------------------------------------------------------------

export const MAPPING_STATUS: Labels<Schema<'AccountingMappingStatus'>> = {
  proposed: { tone: 'pending', label: 'proposed: awaiting approval' },
  approved: { tone: 'success', label: 'approved' },
  retired: { tone: 'neutral', label: 'retired' },
};

export const BATCH_STATUS: Labels<Schema<'AccountingBatchStatus'>> = {
  prepared: { tone: 'pending', label: 'prepared: not sent' },
  submitted: { tone: 'info', label: 'submitted: awaiting the answer' },
  accepted: { tone: 'success', label: 'accepted' },
  rejected: { tone: 'danger', label: 'rejected: entries can be exported again' },
  unknown: { tone: 'warning', label: 'outcome unknown: recovery required' },
  canceled: { tone: 'neutral', label: 'canceled' },
};

/** The ledger accounts the API exports (`LedgerAccount`), in the API's order, with staff names. */
export const LEDGER_ACCOUNTS: readonly { value: Schema<'LedgerAccount'>; label: string }[] = [
  { value: 'customer_receivable', label: 'Customer receivable' },
  { value: 'cash_processor', label: 'Cash at the processor' },
  { value: 'deferred_revenue', label: 'Deferred revenue' },
  { value: 'credits_payable', label: 'Credits payable' },
  { value: 'processor_fees', label: 'Processor fees' },
  { value: 'refunds', label: 'Refunds' },
  { value: 'cash_on_hand', label: 'Cash on hand' },
  { value: 'overpayment_liability', label: 'Overpayment liability' },
  { value: 'pos_revenue', label: 'Point-of-sale revenue' },
  { value: 'taxes_payable', label: 'Taxes payable' },
  { value: 'fees_payable', label: 'Fees payable' },
];

/** "Point-of-sale revenue (pos_revenue)"; an account the client does not know keeps its code. */
export function ledgerAccountLabel(account: string): string {
  const known = LEDGER_ACCOUNTS.find((a) => a.value === account);
  return known ? `${known.label} (${account})` : account;
}
