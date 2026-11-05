/**
 * Fixtures for the stage-3 customer money lists (SCR-C-25, SCR-C-34, SCR-C-35): live attempts,
 * checkouts in recovery, payment details with refunds, contribution requests and session
 * packages, shaped like the OpenAPI components (`docs/api/openapi.json`) with stable ids and the
 * fixed test clock (2026-10-24T12:00Z). Names and amounts are invented test values; no facility
 * fact (price, policy, expiry rule) is implied.
 */
import { IDS, inDays, order, paymentAttempt } from './fixtures';

export const LIST_IDS = {
  attemptUnknown: '0192f1a0-0000-7000-8000-000000000802',
  attemptProcessing: '0192f1a0-0000-7000-8000-000000000803',
  attemptContribution: '0192f1a0-0000-7000-8000-000000000804',
  checkout: '0192f1a0-0000-7000-8000-000000002001',
  refund: '0192f1a0-0000-7000-8000-000000002101',
  refundUnknown: '0192f1a0-0000-7000-8000-000000002102',
  receiptCash: '0192f1a0-0000-7000-8000-000000002201',
  contribution: '0192f1a0-0000-7000-8000-000000002301',
  contributionChild: '0192f1a0-0000-7000-8000-000000002302',
  teamObligation: '0192f1a0-0000-7000-8000-000000002401',
  package: '0192f1a0-0000-7000-8000-000000002501',
  packageB: '0192f1a0-0000-7000-8000-000000002502',
  packageOffering: '0192f1a0-0000-7000-8000-000000002601',
  redemption: '0192f1a0-0000-7000-8000-000000002701',
  reversal: '0192f1a0-0000-7000-8000-000000002702',
  sessionBooking: '0192f1a0-0000-7000-8000-000000002801',
} as const;

export const pageOf = <T>(items: T[], nextCursor: string | null = null) => ({
  status: 200,
  body: { items, nextCursor },
});

export function liveAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: LIST_IDS.attemptUnknown,
    status: 'unknown',
    amountMinor: 4000,
    currency: 'USD',
    unknownSince: inDays(-1),
    createdAt: inDays(-1),
    ...overrides,
  };
}

export function unknownPayment(overrides: Record<string, unknown> = {}) {
  return paymentAttempt({
    id: LIST_IDS.attemptUnknown,
    status: 'unknown',
    evidenceSource: null,
    resolvedAt: null,
    unknownSince: inDays(-1),
    createdAt: inDays(-1),
    posSaleId: null,
    ...overrides,
  });
}

export function paymentDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...paymentAttempt({ posSaleId: null }),
    refundableMinor: 4000,
    refunds: [],
    ...overrides,
  };
}

export function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: LIST_IDS.refund,
    status: 'succeeded',
    amountMinor: 1000,
    currency: 'USD',
    requestedAt: inDays(-2),
    ...overrides,
  };
}

export function checkout(overrides: Record<string, unknown> = {}) {
  return {
    id: LIST_IDS.checkout,
    quoteId: IDS.policy,
    orderId: IDS.order,
    basketId: IDS.policy,
    payerPersonId: IDS.self,
    status: 'recovery_required',
    paymentKind: 'provider',
    payment: paymentAttempt({
      purpose: 'checkout',
      checkoutId: LIST_IDS.checkout,
      posSaleId: null,
    }),
    receipt: null,
    holdIds: [],
    enrollmentIds: [],
    operationId: IDS.operation,
    failure: null,
    recovery: {
      reasonCode: 'FULFILLMENT_FAILED',
      message: 'A place could not be confirmed.',
      plan: 'manual',
      refundAttemptId: null,
      creditId: null,
      exceptionId: null,
    },
    nextAction: 'await_recovery',
    revision: 3,
    createdAt: inDays(-2),
    updatedAt: inDays(-2),
    completedAt: null,
    ...overrides,
  };
}

export function myOrder(overrides: Record<string, unknown> = {}) {
  return order(overrides);
}

export function contributionRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: LIST_IDS.contribution,
    obligationId: LIST_IDS.teamObligation,
    requestedPersonId: IDS.self,
    amountMinor: 7500,
    currency: 'USD',
    message: null,
    status: 'requested',
    paidAt: null,
    obligation: {
      description: 'Fall 2026 team fee',
      totals: {
        amountMinor: 90000,
        receivedMinor: 30000,
        allocatedMinor: 30000,
        remainingMinor: 60000,
        excessMinor: 0,
        currency: 'USD',
      },
      status: 'open',
    },
    revision: 1,
    createdAt: inDays(-2),
    ...overrides,
  };
}

export function packageEntitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: LIST_IDS.package,
    participantPersonId: IDS.child,
    enrollmentId: IDS.enrollment,
    offeringId: LIST_IDS.packageOffering,
    offeringName: 'Open skate 10-pack',
    entitlementDefinitionId: IDS.policy,
    appliesTo: { offeringIds: [IDS.offering], programIds: [] },
    credits: 10,
    redeemedCount: 3,
    remainingCredits: 7,
    status: 'active',
    expiresAt: inDays(60),
    issuedAt: inDays(-20),
    expiredAt: null,
    revokedAt: null,
    revokedReason: null,
    redemptions: [
      {
        id: LIST_IDS.redemption,
        sessionBookingId: LIST_IDS.sessionBooking,
        kind: 'redeem',
        reversesRedemptionId: null,
        reason: null,
        redeemedAt: inDays(-10),
      },
      {
        id: LIST_IDS.reversal,
        sessionBookingId: LIST_IDS.sessionBooking,
        kind: 'reversal',
        reversesRedemptionId: LIST_IDS.redemption,
        reason: 'Session canceled by the facility',
        redeemedAt: inDays(-5),
      },
    ],
    revision: 4,
    createdAt: inDays(-20),
    updatedAt: inDays(-5),
    ...overrides,
  };
}

/** The public offering of a package, with its facility time zone (SPK-SCHED-008). */
export function packageOffering(timezone = 'America/Los_Angeles') {
  return {
    id: LIST_IDS.packageOffering,
    programId: IDS.program,
    facilityId: IDS.facility,
    facility: { id: IDS.facility, name: 'North Rink', timezone },
    name: 'Open skate 10-pack',
    kind: 'package',
  };
}
