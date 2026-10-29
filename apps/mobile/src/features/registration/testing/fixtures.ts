/**
 * Contract-shaped records for the registration screen tests (types from docs/api/openapi.json, so
 * a fixture that drifts from the API fails to compile). Names are synthetic; nothing here is a
 * facility fact, price or policy.
 */
import type { Schema } from '@sportspark/api-client';
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { TEST_NOW, TEST_SESSION } from '../../../testing/test-app';

export const IDS = {
  org: '0192f1a0-0000-7000-8000-000000000001',
  facility: '0192f1a0-0000-7000-8000-000000000002',
  program: '0192f1a0-0000-7000-8000-000000000003',
  offering: '0192f1a0-0000-7000-8000-000000000010',
  offering2: '0192f1a0-0000-7000-8000-000000000011',
  parent: '0192f1a0-0000-7000-8000-000000000020',
  childA: '0192f1a0-0000-7000-8000-000000000021',
  childB: '0192f1a0-0000-7000-8000-000000000022',
  viewOnlyChild: '0192f1a0-0000-7000-8000-000000000023',
  basket: '0192f1a0-0000-7000-8000-000000000030',
  lineA: '0192f1a0-0000-7000-8000-000000000031',
  lineB: '0192f1a0-0000-7000-8000-000000000032',
  quote: '0192f1a0-0000-7000-8000-000000000040',
  quote2: '0192f1a0-0000-7000-8000-000000000041',
  checkout: '0192f1a0-0000-7000-8000-000000000050',
  operation: '0192f1a0-0000-7000-8000-000000000051',
  payment: '0192f1a0-0000-7000-8000-000000000052',
  order: '0192f1a0-0000-7000-8000-000000000053',
  enrollmentA: '0192f1a0-0000-7000-8000-000000000060',
  enrollmentB: '0192f1a0-0000-7000-8000-000000000061',
  formPolicy: '0192f1a0-0000-7000-8000-000000000070',
  cancellationPolicy: '0192f1a0-0000-7000-8000-000000000071',
  priceRule: '0192f1a0-0000-7000-8000-000000000072',
  ack: '0192f1a0-0000-7000-8000-000000000073',
  entry: '0192f1a0-0000-7000-8000-000000000080',
  offer: '0192f1a0-0000-7000-8000-000000000081',
  pool: '0192f1a0-0000-7000-8000-000000000082',
  hold: '0192f1a0-0000-7000-8000-000000000083',
  season: '0192f1a0-0000-7000-8000-000000000090',
  credit: '0192f1a0-0000-7000-8000-000000000091',
  placement: '0192f1a0-0000-7000-8000-000000000092',
} as const;

const T = TEST_NOW.toISOString();
export const inMinutes = (minutes: number) =>
  new Date(TEST_NOW.getTime() + minutes * 60_000).toISOString();

export function offering(overrides: Partial<Schema<'Offering'>> = {}): Schema<'Offering'> {
  return {
    id: IDS.offering,
    programId: IDS.program,
    facilityId: IDS.facility,
    name: 'Autumn Youth Program',
    description: 'Skills sessions for young players.',
    kind: 'term',
    activityType: 'soccer',
    format: '7v7',
    locationLabel: 'Field 2',
    startsOn: '2026-11-02',
    endsOn: '2026-12-14',
    registrationOpensAt: '2026-10-01T15:00:00.000Z',
    registrationClosesAt: '2026-10-30T15:00:00.000Z',
    publicationState: 'registration_open',
    ageBand: { minAgeYears: 8, maxAgeYears: 10 },
    capacity: [{ unit: 'seats', limit: 20 }],
    price: {
      priceRuleId: IDS.priceRule,
      basePriceMinor: 12000,
      currency: 'USD',
      chargeLines: [
        {
          code: 'facility',
          label: 'Facility fee',
          kind: 'fee',
          amountMinor: 500,
          inclusive: false,
        },
      ],
    },
    eligibilityPolicyVersionId: null,
    cancellationPolicyVersionId: IDS.cancellationPolicy,
    requiredFormPolicyVersionIds: [IDS.formPolicy],
    entitlementDefinitionId: null,
    bookingTermsPolicyVersionId: null,
    facility: { id: IDS.facility, name: 'Test complex', timezone: 'America/Los_Angeles' },
    staff: null,
    ...overrides,
  };
}

export function page<T>(items: T[], nextCursor: string | null = null) {
  return { status: 200, body: { items, nextCursor } };
}

export function me(overrides: Partial<Schema<'Me'>> = {}): Schema<'Me'> {
  return {
    principal: {
      kind: 'customer',
      organizationId: IDS.org,
      accountId: TEST_SESSION.accountId,
      personId: IDS.parent,
      staffRoles: [],
      facilityIds: [],
    },
    person: {
      id: IDS.parent,
      kind: 'adult',
      givenName: 'Robin',
      familyName: 'Example',
      dateOfBirth: null,
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: T,
      updatedAt: T,
    },
    staffMemberships: [],
    authorities: [
      {
        subjectPersonId: IDS.childA,
        permissions: ['view', 'register', 'pay', 'complete_forms', 'receive_messages'],
      },
      {
        subjectPersonId: IDS.childB,
        permissions: ['view', 'register', 'pay', 'complete_forms', 'receive_messages'],
      },
      { subjectPersonId: IDS.viewOnlyChild, permissions: ['view'] },
    ],
    ...overrides,
  };
}

export function person(id: string, givenName: string, kind: 'adult' | 'child' = 'child') {
  return {
    id,
    kind,
    givenName,
    familyName: 'Example',
    dateOfBirth: null,
    status: 'active' as const,
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    contactPoints: [],
  };
}

/** Routes every screen needs to name the signed-in parent and two children. */
export function familyRoutes() {
  return {
    'GET /me': { status: 200, body: me() },
    'GET /people/{id}': (req: FakeRequest) => {
      const names: Record<string, string> = {
        [IDS.childA]: 'Ada',
        [IDS.childB]: 'Ben',
        [IDS.viewOnlyChild]: 'Cy',
      };
      const name = names[req.params.id ?? ''];
      return name
        ? fakeResponse(200, person(req.params.id as string, name))
        : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }));
    },
  };
}

export function eligible(): Schema<'EligibilityResult'> {
  return {
    eligible: true,
    policyVersionId: null,
    referenceDate: null,
    evaluatedAt: T,
    reasons: [],
    alternatives: [],
    overridden: false,
  };
}

export function line(overrides: Partial<Schema<'BasketLine'>> = {}): Schema<'BasketLine'> {
  return {
    id: IDS.lineA,
    basketId: IDS.basket,
    sequence: 1,
    participantPersonId: IDS.childA,
    offeringId: IDS.offering,
    offeringKind: 'term',
    sessionId: null,
    teamEntryId: null,
    intent: 'youth',
    quantity: 1,
    applicationId: '0192f1a0-0000-7000-8000-0000000000d1',
    applicationStatus: 'accepted',
    trialParticipationId: null,
    entitlementDefinitionId: null,
    equivalenceKey: null,
    eligibility: eligible(),
    price: { priceRuleId: IDS.priceRule, basePriceMinor: 12000, currency: 'USD', chargeLines: [] },
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: IDS.cancellationPolicy,
      requiredFormPolicyVersionIds: [IDS.formPolicy],
      approvalPolicyVersionId: null,
    },
    requiresApproval: false,
    enrollmentId: null,
    outcome: 'pending',
    outcomeReason: null,
    revision: 1,
    ...overrides,
  };
}

export function basket(overrides: Partial<Schema<'Basket'>> = {}): Schema<'Basket'> {
  return {
    id: IDS.basket,
    ownerPersonId: IDS.parent,
    payerPersonId: IDS.parent,
    createdBy: {
      kind: 'customer',
      accountId: TEST_SESSION.accountId,
      personId: IDS.parent,
      staffRoles: [],
      actorLabel: 'customer',
    },
    assistedByPersonId: null,
    fulfillmentMode: 'all_or_nothing',
    partialAcceptedAt: null,
    status: 'open',
    holdExpiresAt: null,
    currency: 'USD',
    subtotalMinor: 24000,
    approvalPending: false,
    orderRef: null,
    lastOperationId: null,
    lines: [line(), line({ id: IDS.lineB, sequence: 2, participantPersonId: IDS.childB })],
    holds: [],
    revision: 3,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function quoteLine(overrides: Partial<Schema<'QuoteLine'>> = {}): Schema<'QuoteLine'> {
  return {
    id: '0192f1a0-0000-7000-8000-0000000000a1',
    sequence: 1,
    basketLineId: IDS.lineA,
    participantPersonId: IDS.childA,
    offeringId: IDS.offering,
    description: 'Autumn Youth Program',
    quantity: 1,
    priceRuleId: IDS.priceRule,
    unitPriceMinor: 12000,
    baseAmountMinor: 12000,
    discountMinor: 1200,
    taxMinor: 0,
    feeMinor: 500,
    includedTaxMinor: 0,
    totalMinor: 11300,
    currency: 'USD',
    discounts: [
      {
        discountDefinitionId: '0192f1a0-0000-7000-8000-0000000000b1',
        code: null,
        name: 'Sibling discount',
        amountMinor: 1200,
        explanation: ['10% off the second and later children.'],
      },
    ],
    charges: [
      {
        code: 'facility',
        label: 'Facility fee',
        kind: 'fee',
        inclusive: false,
        basisPoints: null,
        amountMinor: 500,
      },
    ],
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: IDS.cancellationPolicy,
      requiredFormPolicyVersionIds: [IDS.formPolicy],
      approvalPolicyVersionId: null,
    },
    enrollmentId: null,
    ...overrides,
  };
}

export function quote(overrides: Partial<Schema<'Quote'>> = {}): Schema<'Quote'> {
  return {
    id: IDS.quote,
    basketId: IDS.basket,
    payerPersonId: IDS.parent,
    status: 'active',
    currency: 'USD',
    lines: [
      quoteLine(),
      quoteLine({
        id: '0192f1a0-0000-7000-8000-0000000000a2',
        sequence: 2,
        basketLineId: IDS.lineB,
        participantPersonId: IDS.childB,
      }),
    ],
    subtotalMinor: 24000,
    discountMinor: 2400,
    taxMinor: 0,
    feeMinor: 1000,
    includedTaxMinor: 0,
    totalMinor: 22600,
    creditsAppliedMinor: 0,
    appliedCredits: [],
    dueNowMinor: 22600,
    paymentPlan: 'full',
    futureObligations: [],
    discounts: [],
    policies: {
      overpaymentPolicyVersionId: null,
      installmentPolicyVersionId: null,
      refundPolicyVersionId: null,
      defaults: ['refund/compensation: refund (POL-009, DEC-009)'],
    },
    expiresAt: inMinutes(30),
    consumedByCheckoutId: null,
    revision: 1,
    createdAt: T,
    ...overrides,
  };
}

export function payment(
  overrides: Partial<NonNullable<Schema<'PaymentAttempt'>>> = {},
): NonNullable<Schema<'PaymentAttempt'>> {
  return {
    id: IDS.payment,
    purpose: 'checkout',
    status: 'succeeded',
    amountMinor: 22600,
    currency: 'USD',
    provider: 'fake-payments',
    providerReference: 'ref-1',
    actionRequired: null,
    failureReason: null,
    evidenceSource: 'sync_response',
    payerPersonId: IDS.parent,
    checkoutId: IDS.checkout,
    orderId: IDS.order,
    obligationId: null,
    contributionRequestId: null,
    posSaleId: null,
    installmentId: null,
    unknownSince: null,
    resolvedAt: T,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function checkout(overrides: Partial<Schema<'Checkout'>> = {}): Schema<'Checkout'> {
  return {
    id: IDS.checkout,
    quoteId: IDS.quote,
    orderId: IDS.order,
    basketId: IDS.basket,
    payerPersonId: IDS.parent,
    status: 'completed',
    paymentKind: 'provider',
    payment: payment(),
    receipt: {
      id: '0192f1a0-0000-7000-8000-0000000000c1',
      sourceKind: 'payment_attempt',
      paymentAttemptId: IDS.payment,
      cashTenderId: null,
      amountMinor: 22600,
      allocatedMinor: 22600,
      excessMinor: 0,
      currency: 'USD',
      receivedAt: T,
    },
    holdIds: [],
    enrollmentIds: [IDS.enrollmentA, IDS.enrollmentB],
    operationId: IDS.operation,
    failure: null,
    recovery: null,
    nextAction: null,
    revision: 2,
    createdAt: T,
    updatedAt: T,
    completedAt: T,
    ...overrides,
  };
}

export function operation(
  status: Schema<'Operation'>['status'] = 'succeeded',
): Schema<'Operation'> {
  return {
    id: IDS.operation,
    kind: 'finance.checkout',
    status,
    correlationId: null,
    result: null,
    error: null,
    createdAt: T,
    updatedAt: T,
    completedAt: status === 'succeeded' ? T : null,
  };
}

export function enrollment(
  id: string,
  participantPersonId: string,
  overrides: Partial<Schema<'Enrollment'>> = {},
): Schema<'Enrollment'> {
  return {
    id,
    offeringId: IDS.offering,
    participantPersonId,
    intent: 'youth',
    entitlementDefinitionId: null,
    equivalenceKey: null,
    status: 'confirmed',
    payerPersonId: IDS.parent,
    registeredBy: {
      kind: 'customer',
      accountId: TEST_SESSION.accountId,
      personId: IDS.parent,
      staffRoles: [],
      actorLabel: 'customer',
    },
    assistedByPersonId: null,
    sourceApplicationId: null,
    basketId: IDS.basket,
    basketLineId: null,
    placementRequestId: null,
    trialParticipationId: null,
    orderRef: null,
    lastOperationId: null,
    offering: null,
    pendingReason: null,
    price: null,
    policies: {
      eligibilityPolicyVersionId: null,
      cancellationPolicyVersionId: null,
      requiredFormPolicyVersionIds: [],
      approvalPolicyVersionId: null,
    },
    confirmedAt: T,
    canceledAt: null,
    cancellationReason: null,
    cancellationPolicyVersionId: null,
    cancellationConsequence: null,
    transferredAt: null,
    transferredToEnrollmentId: null,
    transferredFromEnrollmentId: null,
    transferConsequence: null,
    completedAt: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function policyVersion(
  id: string,
  title: string,
  kind: Schema<'PolicyVersion'>['kind'] = 'form',
): Schema<'PolicyVersion'> {
  return {
    id,
    kind,
    key: title.toLowerCase().replace(/[^a-z]+/g, '-'),
    version: 2,
    title,
    content: { text: `${title} wording.` },
    effectiveFrom: T,
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: T,
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
  };
}

export function acknowledgment(
  subjectPersonId: string,
  policyVersionId: string,
): Schema<'Acknowledgment'> {
  return {
    id: IDS.ack,
    subjectPersonId,
    policyVersionId,
    signedByPersonId: IDS.parent,
    basis: 'guardian',
    recordedByPersonId: IDS.parent,
    recordedByKind: 'customer',
    signedAt: T,
    evidence: {},
    status: 'active',
    withdrawnAt: null,
    withdrawnReason: null,
    revision: 1,
    createdAt: T,
  };
}

export function offer(overrides: Partial<Schema<'WaitlistOffer'>> = {}): Schema<'WaitlistOffer'> {
  return {
    id: IDS.offer,
    waitlistEntryId: IDS.entry,
    poolId: IDS.pool,
    holdId: IDS.hold,
    quantity: 1,
    offeredAt: T,
    expiresAt: inMinutes(120),
    status: 'offered',
    acceptedAt: null,
    acceptedBasketId: null,
    acceptedEnrollmentId: null,
    acceptedSessionBookingId: null,
    declinedAt: null,
    expiredAt: null,
    revision: 4,
    ...overrides,
  };
}

export function waitlistEntry(
  overrides: Partial<Schema<'WaitlistEntry'>> = {},
): Schema<'WaitlistEntry'> {
  return {
    id: IDS.entry,
    offeringId: IDS.offering,
    poolId: IDS.pool,
    sessionId: null,
    participantPersonId: IDS.childA,
    intent: 'youth',
    priorityBasis: 'joined_at',
    priorityRank: 0,
    joinedAt: T,
    queuedAt: T,
    preferences: {},
    payerPersonId: IDS.parent,
    status: 'waiting',
    position: 3,
    offerCount: 0,
    offers: [],
    acceptedEnrollmentId: null,
    withdrawnAt: null,
    removedAt: null,
    revision: 2,
    createdAt: T,
    ...overrides,
  };
}

/** `GET /offerings/{id}/registration-options` for the youth program (ENR-05). */
export function registrationOptions(
  overrides: Partial<Schema<'RegistrationOptions'>> = {},
): Schema<'RegistrationOptions'> {
  return {
    offeringId: IDS.offering,
    availableIntents: ['youth', 'makeup'],
    seasonId: null,
    participants: [IDS.parent, IDS.childA, IDS.childB].map((personId) => ({
      personId,
      intents: [
        { intent: 'youth' as const, eligibility: eligible() },
        { intent: 'makeup' as const, eligibility: eligible() },
      ],
    })),
    ...overrides,
  };
}

/**
 * Answers registration options for the participants a request names, leaving out anyone the
 * account may not register (the view-only child), as the API does.
 */
export function optionsHandler(base: Partial<Schema<'RegistrationOptions'>> = {}) {
  return (req: FakeRequest) => {
    const options = registrationOptions(base);
    const named = (req.query.participantPersonIds ?? '').split(',').filter(Boolean);
    return fakeResponse(200, {
      ...options,
      participants: options.participants.filter((p) => named.includes(p.personId)),
    });
  };
}

/** A blocking eligibility result with the API's reason and alternative (SPK-REG-002). */
export function ineligible(message: string): Schema<'EligibilityResult'> {
  return {
    ...eligible(),
    eligible: false,
    reasons: [
      {
        code: 'age_band',
        severity: 'blocking',
        message,
        source: { type: 'policy', id: null },
        requiredAction: 'choose_other_offering',
      },
    ],
    alternatives: [
      { kind: 'other_offering', message: 'Choose an activity for this age.', offeringId: null },
    ],
  };
}

/** One of `GET /me/waitlist-entries` (ENR-01): the entry with the offering's name and open offer. */
export function myWaitlistEntry(
  overrides: Partial<Schema<'MyWaitlistEntry'>> = {},
): Schema<'MyWaitlistEntry'> {
  return {
    ...waitlistEntry(),
    offeringName: 'Autumn Youth Program',
    openOffer: null,
    ...overrides,
  };
}
