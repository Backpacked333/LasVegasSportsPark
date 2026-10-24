import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Staff who take payments with the customer at the desk (§2.1). */
const DESK: readonly StaffRole[] = [
  'front_desk',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];
/** Financial corrections and money movements (DEC-009): refunds, credits, recovery, reconciliation. */
const FINANCE: readonly StaffRole[] = [
  'finance_operator',
  'general_manager',
  'system_administrator',
];
/** Staff who read financial records (never coaches or officials). */
const READERS: readonly StaffRole[] = [
  'front_desk',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'league_manager',
  'program_manager',
];

/**
 * Finance actions (specification §3.15, §4.11, §4.14). Customer authority is the `pay`
 * permission over every participant or debtor (SPK-IAM-003); an adult pays for themselves
 * (`allowSelf`), a child never holds `pay` over themselves. Team obligations add the captain role
 * on the team entry (SPK-PAY-004). Contribution requests grant no authority over anyone's account.
 */
export const FinanceActions = defineActions({
  createQuote: {
    id: 'finance.create_quote',
    description:
      'Price an authorized basket from server-side price rules (payer with pay authority or desk staff)',
    staffRoles: DESK,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['SPK-PAY-001', 'SPK-PAY-002', 'SPK-PAY-003', '§4.8'],
  },
  readQuote: {
    id: 'finance.read_quote',
    description: 'Read a quote (its payer or finance readers)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['SPK-PAY-002'],
  },
  checkout: {
    id: 'finance.checkout',
    description:
      'Check out a stored quote: holds, order, payment and fulfillment (payer with pay over every participant, or desk staff)',
    staffRoles: DESK,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['§4.11', 'SPK-PAY-007', 'SPK-PAY-012', 'SPK-AT-006'],
  },
  readCheckout: {
    id: 'finance.read_checkout',
    description: 'Read a checkout, order or payment (its payer or finance readers)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['§4.11', '§4.10'],
  },
  recoverCheckout: {
    id: 'finance.recover_checkout',
    description: 'Retry or compensate a checkout whose money was received but fulfillment failed',
    staffRoles: FINANCE,
    requirements: ['§4.11', 'SPK-AT-006'],
  },
  refund: {
    id: 'finance.refund',
    description: 'Reserve and request a refund of captured funds',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-008', 'SPK-AT-007'],
  },
  reconcilePayment: {
    id: 'finance.reconcile_payment',
    description:
      'Resolve an unknown payment or refund outcome from authoritative provider evidence',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-007', 'SPK-PAY-008'],
  },
  manageObligations: {
    id: 'finance.manage_obligations',
    description: 'Create individual or team obligations (team fees, manual charges)',
    staffRoles: ['finance_operator', 'league_manager', 'general_manager', 'system_administrator'],
    requirements: ['SPK-PAY-004'],
  },
  readObligation: {
    id: 'finance.read_obligation',
    description:
      'Read an obligation: the debtor (view authority), the team captain, the responsible payer or finance readers',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    teamRole: 'captain',
    requirements: ['SPK-PAY-004'],
  },
  payObligation: {
    id: 'finance.pay_obligation',
    description: 'Pay toward an obligation (the debtor with pay authority, or the team captain)',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'pay',
    teamRole: 'captain',
    requirements: ['SPK-PAY-004', 'SPK-PAY-005'],
  },
  requestContribution: {
    id: 'finance.request_contribution',
    description:
      'Request a player contribution toward the team obligation (captain or finance staff)',
    staffRoles: ['finance_operator', 'league_manager', 'general_manager', 'system_administrator'],
    teamRole: 'captain',
    requirements: ['SPK-PAY-004'],
  },
  payContribution: {
    id: 'finance.pay_contribution',
    description:
      'Pay a requested contribution (the requested player, or someone with pay over them)',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['SPK-PAY-004', 'SPK-AT-022'],
  },
  issueCredit: {
    id: 'finance.issue_credit',
    description: 'Issue a goodwill or adjustment credit',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-009'],
  },
  approveCredit: {
    id: 'finance.approve_credit',
    description: 'Approve an overpayment credit held pending approval (POL-015)',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-005', 'SPK-PAY-009', 'SPK-AT-022'],
  },
  redeemCredit: {
    id: 'finance.redeem_credit',
    description:
      'Redeem a credit against an obligation (the owner with pay authority, or desk staff)',
    staffRoles: DESK,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['SPK-PAY-009', '§4.7 invariant 7'],
  },
  readCredit: {
    id: 'finance.read_credit',
    description: "Read a person's credits and their redemption history",
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'pay',
    requirements: ['SPK-PAY-009'],
  },
  manageInstallments: {
    id: 'finance.manage_installments',
    description: 'Collect or extend installments',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-006'],
  },
  recordTender: {
    id: 'finance.record_tender',
    description: 'Record cash or an externally recorded tender with evidence',
    staffRoles: ['front_desk', 'finance_operator', 'general_manager', 'system_administrator'],
    requirements: ['SPK-PAY-012'],
  },
  reconcile: {
    id: 'finance.reconcile',
    description:
      'Reconcile processor settlements and cash drawers; read reconciliation reports and balances',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-010', 'SPK-PAY-011'],
  },
});
