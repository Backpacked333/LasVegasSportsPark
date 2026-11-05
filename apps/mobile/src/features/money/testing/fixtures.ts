/**
 * Fixtures for the SCR-C-32 to SCR-C-38 screen tests: API bodies shaped like the OpenAPI
 * components (`docs/api/openapi.json`), with stable ids and the fixed test clock (2026-10-24T12:00Z).
 * Names are invented test values; no facility fact (price, policy, hours) is implied.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { TEST_NOW } from '../../../testing/test-app';

export const IDS = {
  self: '0192f1a0-0000-7000-8000-000000000001',
  child: '0192f1a0-0000-7000-8000-000000000002',
  enrollment: '0192f1a0-0000-7000-8000-000000000101',
  enrollmentB: '0192f1a0-0000-7000-8000-000000000102',
  enrollmentC: '0192f1a0-0000-7000-8000-000000000103',
  offering: '0192f1a0-0000-7000-8000-000000000201',
  offeringB: '0192f1a0-0000-7000-8000-000000000202',
  offeringClosed: '0192f1a0-0000-7000-8000-000000000203',
  program: '0192f1a0-0000-7000-8000-000000000301',
  placement: '0192f1a0-0000-7000-8000-000000000401',
  order: '0192f1a0-0000-7000-8000-000000000501',
  plan: '0192f1a0-0000-7000-8000-000000000601',
  obligation: '0192f1a0-0000-7000-8000-000000000701',
  obligationB: '0192f1a0-0000-7000-8000-000000000702',
  attempt: '0192f1a0-0000-7000-8000-000000000801',
  credit: '0192f1a0-0000-7000-8000-000000000901',
  makeup: '0192f1a0-0000-7000-8000-000000001001',
  session: '0192f1a0-0000-7000-8000-000000001101',
  sessionPast: '0192f1a0-0000-7000-8000-000000001102',
  booking: '0192f1a0-0000-7000-8000-000000001201',
  operation: '0192f1a0-0000-7000-8000-000000001301',
  policy: '0192f1a0-0000-7000-8000-000000001401',
  facility: '0192f1a0-0000-7000-8000-000000001501',
} as const;

const T = TEST_NOW.toISOString();
export const inDays = (days: number) =>
  new Date(TEST_NOW.getTime() + days * 86_400_000).toISOString();

export function person(id: string, givenName: string, kind: 'adult' | 'child' = 'adult') {
  return {
    id,
    kind,
    givenName,
    familyName: 'Rivera',
    dateOfBirth: null,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
  };
}

export function me(options: { child?: boolean; person?: boolean } = {}) {
  const { child = true, person: linked = true } = options;
  return {
    principal: {
      kind: 'customer',
      organizationId: '0192f1a0-0000-7000-8000-00000000a000',
      accountId: '0192f1a0-0000-7000-8000-0000000000aa',
      personId: linked ? IDS.self : null,
      staffRoles: [],
      facilityIds: [],
    },
    person: linked ? person(IDS.self, 'Alex') : null,
    staffMemberships: [],
    authorities: child
      ? [{ subjectPersonId: IDS.child, permissions: ['view', 'register', 'pay'] }]
      : [],
  };
}

/** `GET /me` and the child's person record, the base of every screen test here. */
export function accountRoutes(options: { child?: boolean; person?: boolean } = {}) {
  return {
    'GET /me': { status: 200, body: me(options) },
    'GET /people/{id}': (req: { params: Record<string, string> }) =>
      req.params.id === IDS.child
        ? fakeResponse(200, { ...person(IDS.child, 'Sam', 'child'), contactPoints: [] })
        : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
  } satisfies Record<string, FakeHandler>;
}

export function offering(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.offering,
    programId: IDS.program,
    facilityId: IDS.facility,
    name: 'Autumn U10 League',
    description: null,
    kind: 'season',
    activityType: 'soccer',
    format: null,
    locationLabel: null,
    startsOn: '2026-09-05',
    endsOn: '2026-11-28',
    registrationOpensAt: null,
    registrationClosesAt: null,
    publicationState: 'registration_open',
    ageBand: null,
    capacity: [],
    price: null,
    eligibilityPolicyVersionId: null,
    cancellationPolicyVersionId: IDS.policy,
    requiredFormPolicyVersionIds: [],
    entitlementDefinitionId: null,
    staff: null,
    ...overrides,
  };
}

export function enrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.enrollment,
    offeringId: IDS.offering,
    participantPersonId: IDS.child,
    intent: 'youth',
    entitlementDefinitionId: null,
    equivalenceKey: null,
    status: 'confirmed',
    payerPersonId: IDS.self,
    registeredBy: {
      kind: 'customer',
      accountId: null,
      personId: IDS.self,
      staffRoles: [],
      actorLabel: 'Alex',
    },
    assistedByPersonId: null,
    sourceApplicationId: null,
    basketId: null,
    basketLineId: null,
    placementRequestId: null,
    trialParticipationId: null,
    orderRef: null,
    lastOperationId: null,
    price: { priceRuleId: IDS.policy, basePriceMinor: 12000, currency: 'USD', chargeLines: [] },
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: IDS.policy,
      requiredFormPolicyVersionIds: [],
      approvalPolicyVersionId: null,
    },
    confirmedAt: inDays(-30),
    canceledAt: null,
    cancellationReason: null,
    cancellationPolicyVersionId: null,
    cancellationConsequence: null,
    transferredAt: null,
    transferredToEnrollmentId: null,
    transferredFromEnrollmentId: null,
    completedAt: null,
    revision: 3,
    createdAt: inDays(-31),
    updatedAt: inDays(-30),
    ...overrides,
  };
}

export const page = <T>(items: T[]) => ({ status: 200, body: { items, nextCursor: null } });

export function consequence(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'refund',
    amountMinor: 6000,
    currency: 'USD',
    explanation: 'The cancellation policy grants a refund of 50% of the price.',
    policyVersionId: IDS.policy,
    ...overrides,
  };
}

export function cancellationPreview(overrides: Record<string, unknown> = {}) {
  return {
    enrollmentId: IDS.enrollment,
    status: 'confirmed',
    existing: {
      offeringId: IDS.offering,
      offeringName: 'Autumn U10 League',
      startsOn: '2026-09-05',
      endsOn: '2026-11-28',
      entitlementDefinitionId: null,
      price: null,
    },
    affectedDates: { startsOn: '2026-09-05', endsOn: '2026-11-28' },
    capacity: { released: [{ poolId: IDS.placement, unit: 'participant', quantity: 1 }] },
    cancellationPolicyVersionId: IDS.policy,
    financialConsequence: consequence(),
    requiredApproval: false,
    permitted: true,
    ...overrides,
  };
}

export function transferPreview(overrides: Record<string, unknown> = {}) {
  return {
    enrollmentId: IDS.enrollment,
    existing: {
      offeringId: IDS.offering,
      offeringName: 'Autumn U10 League',
      startsOn: '2026-09-05',
      endsOn: '2026-11-28',
      entitlementDefinitionId: null,
      price: null,
    },
    proposed: {
      offeringId: IDS.offeringB,
      offeringName: 'Autumn U10 Sunday League',
      startsOn: '2026-09-06',
      endsOn: '2026-11-29',
      entitlementDefinitionId: null,
      price: null,
    },
    affectedDates: {
      existingRange: { startsOn: '2026-09-05', endsOn: '2026-11-28' },
      proposedRange: { startsOn: '2026-09-06', endsOn: '2026-11-29' },
      overlapping: true,
    },
    capacity: {
      released: [],
      required: [
        { poolId: IDS.placement, unit: 'participant', constraintKind: 'commercial', available: 3 },
      ],
      waitlistAhead: 0,
      sufficient: true,
    },
    eligibility: {
      eligible: true,
      policyVersionId: null,
      referenceDate: null,
      evaluatedAt: T,
      reasons: [],
      alternatives: [],
      overridden: false,
    },
    financialConsequence: consequence({
      kind: 'charge',
      amountMinor: 1500,
      explanation: 'The new activity costs more; the difference is charged.',
    }),
    requiredApproval: false,
    committed: false,
    newEnrollment: null,
    previousEnrollment: null,
    ...overrides,
  };
}

export function obligation(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.obligation,
    debtor: { kind: 'person', personId: IDS.self, teamEntryId: null },
    mode: 'individual',
    responsiblePayerPersonId: null,
    source: { kind: 'installment', id: IDS.plan },
    orderId: IDS.order,
    description: 'Installment 2 of 3',
    dueAt: inDays(10),
    status: 'open',
    totals: {
      amountMinor: 4000,
      receivedMinor: 0,
      allocatedMinor: 0,
      remainingMinor: 4000,
      excessMinor: 0,
      currency: 'USD',
    },
    contributions: null,
    revision: 1,
    createdAt: inDays(-30),
    ...overrides,
  };
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.order,
    quoteId: IDS.policy,
    basketId: IDS.policy,
    payerPersonId: IDS.self,
    currency: 'USD',
    totalMinor: 12000,
    creditsAppliedMinor: 0,
    dueNowMinor: 4000,
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    lines: [
      {
        id: IDS.placement,
        sequence: 1,
        basketLineId: IDS.placement,
        enrollmentId: IDS.enrollment,
        participantPersonId: IDS.child,
        offeringId: IDS.offering,
        description: 'Autumn U10 League',
        quantity: 1,
        priceRuleId: null,
        unitPriceMinor: 12000,
        baseAmountMinor: 12000,
        discountMinor: 0,
        taxMinor: 0,
        feeMinor: 0,
        totalMinor: 12000,
        currency: 'USD',
        policies: {},
      },
    ],
    obligationIds: [IDS.obligation],
    installmentPlanId: IDS.plan,
    paidAt: inDays(-30),
    fulfilledAt: inDays(-30),
    canceledAt: null,
    revision: 2,
    createdAt: inDays(-30),
    ...overrides,
  };
}

export function installment(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `0192f1a0-0000-7000-8000-00000000060${sequence}`,
    sequence,
    obligationId: IDS.obligation,
    amountMinor: 4000,
    currency: 'USD',
    dueAt: inDays((sequence - 1) * 30 - 20),
    originalDueAt: inDays((sequence - 1) * 30 - 20),
    status: 'scheduled',
    attemptCount: 0,
    lastFailureReason: null,
    nextRetryAt: null,
    paidAt: null,
    extensionCount: 0,
    noticeSentAt: null,
    revision: 1,
    ...overrides,
  };
}

export function installmentPlan(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.plan,
    orderId: IDS.order,
    payerPersonId: IDS.self,
    currency: 'USD',
    totalMinor: 12000,
    status: 'active',
    authorization: { authorizedAt: inDays(-30), authorizedByPersonId: IDS.self },
    retryPolicy: { maxAttempts: 3, retryIntervalHours: 24 },
    noticePolicy: { daysBefore: 3 },
    outstandingMinor: 8000,
    installments: [
      installment(1, { status: 'paid', paidAt: inDays(-30), dueAt: inDays(-30) }),
      installment(2, { dueAt: inDays(10) }),
      installment(3, { dueAt: inDays(40) }),
    ],
    revision: 1,
    ...overrides,
  };
}

export function paymentAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.attempt,
    purpose: 'obligation',
    status: 'succeeded',
    amountMinor: 4000,
    currency: 'USD',
    provider: 'fake',
    providerReference: 'fake_ref_1',
    actionRequired: null,
    failureReason: null,
    evidenceSource: 'sync_response',
    payerPersonId: IDS.self,
    checkoutId: null,
    orderId: IDS.order,
    obligationId: IDS.obligation,
    contributionRequestId: null,
    installmentId: null,
    unknownSince: null,
    resolvedAt: T,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.booking,
    sourceKind: 'payment_attempt',
    paymentAttemptId: IDS.attempt,
    cashTenderId: null,
    amountMinor: 4000,
    allocatedMinor: 4000,
    excessMinor: 0,
    currency: 'USD',
    receivedAt: T,
    ...overrides,
  };
}

export function credit(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.credit,
    ownerPersonId: IDS.self,
    currency: 'USD',
    originalMinor: 5000,
    remainingMinor: 3000,
    permittedUses: ['registration', 'obligation'],
    sourceKind: 'goodwill',
    sourceId: null,
    status: 'active',
    expiresAt: inDays(60),
    reason: 'Field closure in September',
    approvedAt: inDays(-10),
    redemptions: [
      {
        id: IDS.booking,
        kind: 'redeem',
        amountMinor: 2000,
        referenceType: 'obligation',
        referenceId: IDS.obligation,
        redeemedAt: inDays(-5),
      },
    ],
    revision: 1,
    createdAt: inDays(-10),
    ...overrides,
  };
}

export function makeup(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.makeup,
    participantPersonId: IDS.self,
    originatingEnrollmentId: IDS.enrollment,
    originatingSessionId: IDS.sessionPast,
    originKind: 'session_canceled',
    originReference: null,
    eligibleOfferingIds: [IDS.offering],
    eligibleProgramIds: [],
    reason: 'Rain closure',
    expiresAt: inDays(30),
    redemptionLimit: 2,
    redeemedCount: 1,
    status: 'active',
    redemptions: [
      {
        id: IDS.booking,
        sessionBookingId: IDS.booking,
        kind: 'redeem',
        reversesRedemptionId: null,
        redeemedAt: inDays(-3),
      },
    ],
    revokedAt: null,
    revision: 2,
    createdAt: inDays(-7),
    ...overrides,
  };
}

export function offeringSession(
  id: string,
  startsInDays: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    offeringId: IDS.offering,
    sequence: 4,
    title: 'Week 4',
    scheduledStart: inDays(startsInDays),
    scheduledEnd: new Date(new Date(inDays(startsInDays)).getTime() + 3_600_000).toISOString(),
    schedulingEventId: null,
    capacityOverride: null,
    status: 'scheduled',
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    createdAt: T,
    ...overrides,
  };
}

export function sessionBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.booking,
    offeringId: IDS.offering,
    sessionId: IDS.session,
    participantPersonId: IDS.self,
    kind: 'makeup',
    status: 'confirmed',
    poolId: null,
    holdId: null,
    makeupEntitlementId: IDS.makeup,
    scheduledStart: inDays(2),
    scheduledEnd: new Date(new Date(inDays(2)).getTime() + 3_600_000).toISOString(),
    bookedBy: {
      kind: 'customer',
      accountId: null,
      personId: IDS.self,
      staffRoles: [],
      actorLabel: 'Alex',
    },
    assistedByPersonId: null,
    payerPersonId: null,
    price: null,
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: null,
      requiredFormPolicyVersionIds: [],
      approvalPolicyVersionId: null,
    },
    eligibility: null,
    expiresAt: null,
    confirmedAt: T,
    canceledAt: null,
    cancelReason: null,
    expiredAt: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

/** A mock of expo-router's `useRouter`, recording navigation for assertions. */
export function createRouterMock() {
  return { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
}
