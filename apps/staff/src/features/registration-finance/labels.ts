/**
 * Staff-visible status labels for the registration and finance screens (SCR-S-14, SCR-S-15,
 * SCR-S-24 to SCR-S-27, SCR-S-35 to SCR-S-38). Staff labels are the machine state names of
 * docs/package-a/journeys.md section 3 (SPK-UX-010), always shown through `StatusBadge` with a
 * glyph and text, never by colour alone (SPK-UX-009, SPK-UX-004: "payment processing",
 * "awaiting placement" and "confirmed" never look alike).
 *
 * The transition tables mirror the §4.6 machines (OfferingPublicationMachine in
 * apps/api/src/modules/catalog/catalog.state-machines.ts; the others in
 * packages/contracts/src/state-machines.ts). They only decide which commands are worth offering
 * for a state; the API remains the authority and answers INVALID_TRANSITION or ACCESS_DENIED.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export interface Badge {
  tone: StatusTone;
  label: string;
}

type Labels<K extends string> = Record<K, Badge>;

export const PROGRAM_STATUS: Labels<Schema<'ProgramStatus'>> = {
  draft: { tone: 'pending', label: 'draft' },
  active: { tone: 'success', label: 'active' },
  archived: { tone: 'neutral', label: 'archived' },
};

export const PUBLICATION_STATE: Labels<Schema<'PublicationState'>> = {
  draft: { tone: 'pending', label: 'draft' },
  published: { tone: 'info', label: 'published' },
  registration_open: { tone: 'success', label: 'registration_open' },
  registration_paused: { tone: 'warning', label: 'registration_paused' },
  closed: { tone: 'neutral', label: 'closed' },
  archived: { tone: 'neutral', label: 'archived' },
};

export type PublicationCommand =
  | 'publish'
  | 'registration/open'
  | 'registration/pause'
  | 'registration/resume'
  | 'close'
  | 'archive';

/** OfferingPublicationMachine (SPK-CAT-004): publication and registration are distinct actions. */
export const PUBLICATION_COMMANDS: Record<
  Schema<'PublicationState'>,
  readonly { command: PublicationCommand; label: string }[]
> = {
  draft: [
    { command: 'publish', label: 'Validate and publish' },
    { command: 'archive', label: 'Archive' },
  ],
  published: [
    { command: 'registration/open', label: 'Open registration' },
    { command: 'close', label: 'Close' },
  ],
  registration_open: [
    { command: 'registration/pause', label: 'Pause registration' },
    { command: 'close', label: 'Close' },
  ],
  registration_paused: [
    { command: 'registration/resume', label: 'Resume registration' },
    { command: 'close', label: 'Close' },
  ],
  closed: [{ command: 'archive', label: 'Archive' }],
  archived: [],
};

/** States in which the offering's configuration may still be edited (catalog module). */
export const EDITABLE_PUBLICATION_STATES: readonly Schema<'PublicationState'>[] = [
  'draft',
  'published',
  'registration_open',
  'registration_paused',
];

export const SESSION_STATUS: Labels<Schema<'OfferingSessionStatus'>> = {
  scheduled: { tone: 'info', label: 'scheduled' },
  canceled: { tone: 'neutral', label: 'canceled' },
  completed: { tone: 'success', label: 'completed' },
};

export const POLICY_STATUS: Labels<Schema<'PolicyApprovalStatus'>> = {
  draft: { tone: 'pending', label: 'draft' },
  approved: { tone: 'success', label: 'approved' },
  retired: { tone: 'neutral', label: 'retired' },
};

export const APPLICATION_STATUS: Labels<Schema<'ApplicationStatus'>> = {
  draft: { tone: 'neutral', label: 'draft' },
  submitted: { tone: 'pending', label: 'submitted' },
  awaiting_review: { tone: 'pending', label: 'awaiting_review' },
  accepted: { tone: 'success', label: 'accepted' },
  declined: { tone: 'neutral', label: 'declined' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
};

/** ApplicationMachine: accept and decline from `submitted` or `awaiting_review`. */
export function applicationDecidable(status: Schema<'ApplicationStatus'>): boolean {
  return status === 'submitted' || status === 'awaiting_review';
}

export const ENROLLMENT_STATUS: Labels<Schema<'EnrollmentStatus'>> = {
  pending: { tone: 'pending', label: 'pending' },
  confirmed: { tone: 'success', label: 'confirmed' },
  canceled: { tone: 'neutral', label: 'canceled' },
  transferred: { tone: 'neutral', label: 'transferred' },
  completed: { tone: 'neutral', label: 'completed' },
};

export const BASKET_STATUS: Labels<Schema<'BasketStatus'>> = {
  open: { tone: 'info', label: 'open' },
  held: { tone: 'pending', label: 'held' },
  checking_out: { tone: 'pending', label: 'checking_out' },
  fulfilled: { tone: 'success', label: 'fulfilled' },
  partially_fulfilled: { tone: 'warning', label: 'partially_fulfilled' },
  expired: { tone: 'neutral', label: 'expired' },
  released: { tone: 'neutral', label: 'released' },
  abandoned: { tone: 'neutral', label: 'abandoned' },
};

export const LINE_OUTCOME: Labels<Schema<'BasketLineOutcome'>> = {
  pending: { tone: 'pending', label: 'pending' },
  held: { tone: 'pending', label: 'held' },
  confirmed: { tone: 'success', label: 'confirmed' },
  failed: { tone: 'danger', label: 'failed' },
  released: { tone: 'neutral', label: 'released' },
};

export const HOLD_STATUS: Labels<Schema<'HoldStatus'>> = {
  active: { tone: 'pending', label: 'Hold active' },
  committed: { tone: 'success', label: 'Hold committed' },
  released: { tone: 'neutral', label: 'Hold released, terminal' },
  expired: { tone: 'neutral', label: 'Hold expired, terminal' },
};

export const WAITLIST_ENTRY_STATUS: Labels<Schema<'WaitlistEntryStatus'>> = {
  waiting: { tone: 'info', label: 'waiting' },
  offered: { tone: 'pending', label: 'offered' },
  accepted: { tone: 'success', label: 'accepted' },
  expired: { tone: 'neutral', label: 'expired' },
  withdrawn: { tone: 'neutral', label: 'withdrawn' },
  removed: { tone: 'neutral', label: 'removed' },
};

export const WAITLIST_OFFER_STATUS: Labels<Schema<'WaitlistOfferStatus'>> = {
  offered: { tone: 'pending', label: 'Offer open, reserved place' },
  accepted: { tone: 'success', label: 'accepted' },
  expired: { tone: 'neutral', label: 'expired' },
  declined: { tone: 'neutral', label: 'declined' },
};

export const QUOTE_STATUS: Labels<Schema<'QuoteStatus'>> = {
  active: { tone: 'info', label: 'Quote active' },
  expired: { tone: 'warning', label: 'Quote expired' },
  consumed: { tone: 'neutral', label: 'Quote consumed' },
};

export const CHECKOUT_STATUS: Labels<Schema<'CheckoutStatus'>> = {
  prepared: { tone: 'pending', label: 'prepared' },
  awaiting_payment: { tone: 'pending', label: 'Checkout awaiting payment' },
  finalizing: { tone: 'pending', label: 'Checkout finalizing' },
  completed: { tone: 'success', label: 'completed' },
  recovery_required: {
    tone: 'danger',
    label: 'Recovery required: received money plus incomplete fulfillment',
  },
  compensated: { tone: 'neutral', label: 'Compensated' },
  aborted: { tone: 'neutral', label: 'aborted' },
};

export const PAYMENT_STATUS: Labels<Schema<'PaymentAttemptStatus'>> = {
  created: { tone: 'pending', label: 'Attempt created' },
  action_required: { tone: 'pending', label: 'Attempt action required' },
  processing: { tone: 'pending', label: 'Attempt processing' },
  succeeded: { tone: 'success', label: 'Attempt succeeded' },
  failed: { tone: 'danger', label: 'Attempt failed' },
  canceled: { tone: 'neutral', label: 'Attempt canceled' },
  unknown: { tone: 'warning', label: 'Attempt unknown: reconcile before any retry' },
};

/** PaymentAttemptMachine: an outcome that is not terminal may still need reconciliation. */
export function paymentUnresolved(status: Schema<'PaymentAttemptStatus'>): boolean {
  return status !== 'succeeded' && status !== 'failed' && status !== 'canceled';
}

export const REFUND_STATUS: Labels<Schema<'RefundStatus'>> = {
  requested: { tone: 'pending', label: 'Refund requested' },
  processing: { tone: 'pending', label: 'Refund processing' },
  succeeded: { tone: 'success', label: 'Refund succeeded' },
  failed: { tone: 'danger', label: 'Refund failed' },
  canceled: { tone: 'neutral', label: 'Refund canceled' },
  unknown: { tone: 'warning', label: 'Refund unknown: reservation retained' },
};

export const RESERVATION_STATUS: Record<'reserved' | 'settled' | 'released', Badge> = {
  reserved: { tone: 'pending', label: 'Amount reserved' },
  settled: { tone: 'success', label: 'Reservation settled' },
  released: { tone: 'neutral', label: 'Reservation released' },
};

export const OBLIGATION_STATUS: Labels<Schema<'ObligationStatus'>> = {
  open: { tone: 'pending', label: 'open' },
  settled: { tone: 'success', label: 'settled' },
  written_off: { tone: 'neutral', label: 'written_off' },
  canceled: { tone: 'neutral', label: 'canceled' },
};

export const OBLIGATION_MODE: Record<Schema<'ObligationMode'>, string> = {
  individual: 'Individual player billing',
  single_team_payer: 'One responsible team payer',
  team_with_contributions: 'Team obligation with player contributions',
};

export const INSTALLMENT_STATUS: Labels<Schema<'Installment'>['status']> = {
  scheduled: { tone: 'info', label: 'scheduled' },
  paid: { tone: 'success', label: 'paid' },
  failed: { tone: 'danger', label: 'Financial state failed installment' },
  canceled: { tone: 'neutral', label: 'canceled' },
};

export const CREDIT_STATUS: Labels<Schema<'CreditStatus'>> = {
  pending_approval: { tone: 'pending', label: 'pending_approval' },
  active: { tone: 'success', label: 'active' },
  exhausted: { tone: 'neutral', label: 'exhausted' },
  expired: { tone: 'neutral', label: 'expired' },
  revoked: { tone: 'neutral', label: 'revoked' },
};

export const SETTLEMENT_STATUS: Labels<Schema<'SettlementReconciliation'>['status']> = {
  balanced: { tone: 'success', label: 'balanced' },
  discrepancy: { tone: 'danger', label: 'discrepancy' },
};

export const EXCEPTION_STATUS: Labels<Schema<'ExceptionStatus'>> = {
  open: { tone: 'warning', label: 'open' },
  acknowledged: { tone: 'info', label: 'acknowledged' },
  resolved: { tone: 'success', label: 'resolved' },
  closed: { tone: 'neutral', label: 'closed' },
};

export const EXCEPTION_SEVERITY: Labels<Schema<'ExceptionSeverity'>> = {
  info: { tone: 'info', label: 'Severity info' },
  warning: { tone: 'warning', label: 'Severity warning' },
  high: { tone: 'danger', label: 'Severity high' },
  critical: { tone: 'danger', label: 'Severity critical' },
};

const ELIGIBILITY_SEVERITY: Record<string, Badge> = {
  blocking: { tone: 'danger', label: 'Blocking' },
  warning: { tone: 'warning', label: 'Warning' },
  info: { tone: 'info', label: 'Information' },
};

/** Eligibility and placement reason severity; anything else is shown as unknown, never as fine. */
export function severityBadge(severity: string): Badge {
  return ELIGIBILITY_SEVERITY[severity] ?? { tone: 'pending', label: 'Unknown' };
}

export const CONSEQUENCE_KIND: Record<NonNullable<Schema<'FinancialConsequence'>>['kind'], Badge> =
  {
    none: { tone: 'neutral', label: 'No financial change' },
    refund: { tone: 'info', label: 'Refund' },
    credit: { tone: 'info', label: 'Credit' },
    charge: { tone: 'warning', label: 'Additional charge' },
    review_required: { tone: 'pending', label: 'Finance review required' },
  };

export const REGISTRATION_INTENT: Record<Schema<'RegistrationIntent'>, string> = {
  individual_league: 'Individual league entry',
  join_team: 'Join a known team',
  create_team_entry: 'Create a team entry',
  youth: 'Youth enrollment',
  trial: 'Trial',
  makeup: 'Makeup',
  pickup: 'Pickup',
  rental_request: 'Rental request',
};

export const OFFERING_KIND: Record<Schema<'OfferingKind'>, string> = {
  season: 'Season participation',
  term: 'Term program',
  camp: 'Camp',
  session: 'Individual session',
  trial: 'Trial',
  makeup: 'Makeup',
  pickup: 'Pickup session',
  private_coaching: 'Private or small-group coaching',
  rental: 'Rental (when applicable)',
  package: 'Package (when applicable)',
  membership: 'Membership (when applicable)',
};

export const CAPACITY_UNIT: Record<Schema<'CapacityUnitKind'>, string> = {
  team_entries: 'Team entries',
  roster_places: 'Roster places',
  seats: 'Offering seats',
  session_seats: 'Session seats',
  camp_group_places: 'Camp-group places',
  rental_resources: 'Rental resources',
};

export const LEDGER_ACCOUNT: Record<Schema<'LedgerAccount'>, string> = {
  customer_receivable: 'Customer receivable',
  cash_processor: 'Cash at processor',
  deferred_revenue: 'Deferred revenue',
  credits_payable: 'Credits payable',
  processor_fees: 'Processor fees',
  refunds: 'Refunds',
  cash_on_hand: 'Cash on hand',
  overpayment_liability: 'Overpayment liability',
};

export const TENDER_KIND: Record<Schema<'CashTenderKind'>, string> = {
  cash: 'Cash',
  check: 'Check',
  external_terminal: 'External terminal',
};
