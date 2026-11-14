/**
 * Pending decisions that gate parts of these screens (docs/package-a/screen-and-journey-inventory.md
 * section 8; owners copied from docs/package-a/decision-register.md). A screen that depends on one
 * shows `StateView variant="pending-decision"` with the decision and its owner; it never invents
 * the policy value (§6.6: "no answer yet" never becomes "not applicable").
 */
export interface PendingDecision {
  ids: string[];
  subject: string;
  owner: string;
}

export const PENDING = {
  youthStaffing: {
    ids: ['DEC-003'],
    subject: 'Approved age bands, group sizes, space and staffing requirements for youth programs',
    owner: 'Program manager',
  },
  waitlistPolicy: {
    ids: ['DEC-006'],
    subject: 'The waitlist priority basis, offer expiry and hold duration policy',
    owner: 'Product and operations',
  },
  pricesAndTaxes: {
    ids: ['DEC-007'],
    subject: 'Approved prices, taxes, fees and rounding',
    owner: 'Finance',
  },
  teamLiability: {
    ids: ['DEC-008', 'DEC-073'],
    subject: 'Team liability, installment plan shapes and balance consequences',
    owner: 'Finance and league manager (DEC-008); Product owner (DEC-073)',
  },
  installments: {
    ids: ['DEC-073'],
    subject: 'Installment plan shapes and where installments apply',
    owner: 'Product owner',
  },
  refundsCreditsCash: {
    ids: ['DEC-009', 'DEC-058'],
    subject: 'Refund eligibility and amounts, credit expiry and permitted uses, cash procedures',
    owner: 'Finance',
  },
  paymentProvider: {
    ids: ['DEC-019'],
    subject: 'Card payment through a payment provider',
    owner: 'Technical lead/account owners',
  },
  accounting: {
    ids: ['DEC-022'],
    subject: 'Export to an accounting system',
    owner: 'Technical lead/account owners',
  },
  basketFulfillment: {
    ids: ['DEC-026'],
    subject: 'Partial household basket fulfillment',
    owner: 'Product and operations',
  },
  approvals: {
    ids: ['DEC-028', 'DEC-029'],
    subject: 'Which offerings need approval before payment, and whether approval reserves capacity',
    owner: 'Product and operations',
  },
  eventClassification: {
    ids: ['DEC-039'],
    subject: 'The classification target for unresolved payment events',
    owner: 'Technical lead/operator',
  },
  reviewDeadline: {
    ids: ['DEC-028'],
    subject: 'Review deadlines for applications awaiting approval',
    owner: 'Product and operations',
  },
  waitlistOfferExpiry: {
    ids: ['DEC-006'],
    subject: 'How long a waitlist offer holds its place',
    owner: 'Product and operations',
  },
  perSessionPricing: {
    ids: ['DEC-096'],
    subject:
      'Which programs are priced per session, when a session stops counting, and any minimum charge',
    owner: 'Product owner; Finance for the values',
  },
  memberPricing: {
    ids: ['DEC-098'],
    subject:
      'Which offerings carry a member price, the date membership is checked on, and whose membership counts for a child',
    owner: 'Product owner; Finance for the values',
  },
  priceTiersAddons: {
    ids: ['DEC-097'],
    subject: 'The price tiers, their deadlines and prices, which add-ons exist and their capacity',
    owner: 'Product owner; Finance for the values',
  },
  uniforms: {
    ids: ['DEC-101'],
    subject:
      'Whether uniforms are ordered during registration, whether stock is counted, prices and the returning-participant rule',
    owner: 'Product owner; Finance for the values',
  },
  overrideAuthority: {
    ids: ['DEC-066'],
    subject: 'Which roles may override an eligibility failure',
    owner:
      'Product and operations; League manager (competition eligibility); Program manager (youth eligibility)',
  },
} satisfies Record<string, PendingDecision>;
