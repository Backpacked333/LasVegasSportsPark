/**
 * API payloads for the registration and finance screen tests, shaped like the OpenAPI schemas
 * (docs/api/openapi.json). Ids are fixed UUIDs; names are invented and carry no real person.
 */
import type { Schema, Schemas } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { FACILITY_A, TEST_NOW } from '../../../testing/test-app';

export const NOW = TEST_NOW.toISOString();
export const PROGRAM_ID = '0192f1a0-0000-7000-8000-000000000101';
export const OFFERING_ID = '0192f1a0-0000-7000-8000-000000000201';
export const OFFERING_B_ID = '0192f1a0-0000-7000-8000-000000000202';
export const PERSON_ID = '0192f1a0-0000-7000-8000-000000000301';
export const ADULT_ID = '0192f1a0-0000-7000-8000-000000000302';
export const MANAGER_ID = '0192f1a0-0000-7000-8000-000000000303';
export const POLICY_ELIGIBILITY_ID = '0192f1a0-0000-7000-8000-000000000401';
export const POLICY_CANCELLATION_ID = '0192f1a0-0000-7000-8000-000000000402';
export const POLICY_FORM_ID = '0192f1a0-0000-7000-8000-000000000403';
export const ENTITLEMENT_ID = '0192f1a0-0000-7000-8000-000000000501';
export const APPLICATION_ID = '0192f1a0-0000-7000-8000-000000000601';
export const BASKET_ID = '0192f1a0-0000-7000-8000-000000000701';
export const LINE_ID = '0192f1a0-0000-7000-8000-000000000702';
export const QUOTE_ID = '0192f1a0-0000-7000-8000-000000000703';
export const CHECKOUT_ID = '0192f1a0-0000-7000-8000-000000000704';
export const ORDER_ID = '0192f1a0-0000-7000-8000-000000000705';
export const POOL_ID = '0192f1a0-0000-7000-8000-000000000801';
export const ENTRY_ID = '0192f1a0-0000-7000-8000-000000000802';
export const ENROLLMENT_ID = '0192f1a0-0000-7000-8000-000000000901';
export const ENROLLMENT_NEW_ID = '0192f1a0-0000-7000-8000-000000000902';
export const OBLIGATION_ID = '0192f1a0-0000-7000-8000-000000001001';
export const PLAN_ID = '0192f1a0-0000-7000-8000-000000001002';
export const PAYMENT_ID = '0192f1a0-0000-7000-8000-000000001101';
export const REFUND_ID = '0192f1a0-0000-7000-8000-000000001102';
export const CREDIT_ID = '0192f1a0-0000-7000-8000-000000001103';
export const EXCEPTION_ID = '0192f1a0-0000-7000-8000-000000001201';
export const PACKAGE_ID = '0192f1a0-0000-7000-8000-000000001401';
export const REDEMPTION_ID = '0192f1a0-0000-7000-8000-000000001402';
export const SUSPENSION_ID = '0192f1a0-0000-7000-8000-000000001403';
export const PROVIDER_EVENT_ID = '0192f1a0-0000-7000-8000-000000001404';
export const OPERATION_ID = '0192f1a0-0000-7000-8000-000000000709';

type Model<N extends keyof Schemas> = NonNullable<Schema<N>>;

export const ok = (body: unknown, status = 200) => ({ status, body });

/**
 * The OpenAPI document encodes a nullable `$ref` as `allOf: [$ref, { type: [..., 'null'] }]`, which
 * the generated types read as non-nullable; the API still sends null there (reported as an API
 * issue). Fixtures use this for those fields.
 */
const NULL_REF = null as never;

export function program(overrides: Partial<Model<'Program'>> = {}): Model<'Program'> {
  return {
    id: PROGRAM_ID,
    name: 'Spring academy',
    description: null,
    activityType: 'soccer',
    format: '7v7',
    ageBand: { minAgeYears: 8, maxAgeYears: 10 },
    status: 'active',
    source: 'staff',
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function offering(
  overrides: Partial<Model<'Offering'>> = {},
  staff: Partial<Model<'OfferingStaffDetails'>> | null = {},
): Model<'Offering'> {
  return {
    id: OFFERING_ID,
    programId: PROGRAM_ID,
    facilityId: FACILITY_A,
    name: 'Spring academy U10',
    description: null,
    kind: 'term',
    activityType: 'soccer',
    format: '7v7',
    locationLabel: 'Field 2',
    startsOn: '2026-11-02',
    endsOn: '2026-12-14',
    registrationOpensAt: '2026-10-20T16:00:00.000Z',
    registrationClosesAt: '2026-11-01T16:00:00.000Z',
    publicationState: 'draft',
    ageBand: { minAgeYears: 8, maxAgeYears: 10 },
    capacity: [{ unit: 'seats', limit: 20 }],
    price: null,
    eligibilityPolicyVersionId: POLICY_ELIGIBILITY_ID,
    cancellationPolicyVersionId: null,
    requiredFormPolicyVersionIds: [],
    entitlementDefinitionId: ENTITLEMENT_ID,
    bookingTermsPolicyVersionId: null,
    facility: { id: FACILITY_A, name: 'North complex', timezone: 'America/Los_Angeles' },
    staff:
      staff === null
        ? null
        : {
            location: { label: 'Field 2' },
            eligibilityReferenceDate: '2026-11-02',
            capacityUnits: [{ unit: 'seats', limit: 20 }],
            responsibleManagerPersonId: MANAGER_ID,
            copiedFromOfferingId: null,
            publishedAt: null,
            registrationOpenedAt: null,
            closedAt: null,
            archivedAt: null,
            bookingTermsKey: null,
            revision: 4,
            createdAt: NOW,
            updatedAt: NOW,
            ...staff,
          },
    ...overrides,
  };
}

export function policy(
  id: string,
  kind: Model<'PolicyKind'>,
  title: string,
): Model<'PolicyVersion'> {
  return {
    id,
    kind,
    key: `${kind}-default`,
    version: 1,
    title,
    content: {},
    effectiveFrom: NOW,
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: NOW,
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function entitlement(): Model<'EntitlementDefinition'> {
  return {
    id: ENTITLEMENT_ID,
    name: 'Term seat',
    description: null,
    kind: 'seat',
    scope: {},
    equivalenceScope: 'offering',
    equivalenceRule: {},
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function person(id: string, givenName: string, familyName: string) {
  return {
    id,
    kind: 'adult',
    givenName,
    familyName,
    dateOfBirth: null,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    contactPoints: [],
  };
}

export const PEOPLE: Record<string, ReturnType<typeof person>> = {
  [PERSON_ID]: person(PERSON_ID, 'Alex', 'Rivera'),
  [ADULT_ID]: person(ADULT_ID, 'Sam', 'Rivera'),
  [MANAGER_ID]: person(MANAGER_ID, 'Pat', 'Lee'),
};

/** `GET /people/{id}` answering the fixed people and protected NOT_FOUND for anyone else. */
export const peopleHandler: FakeHandler = (request) => {
  const found = PEOPLE[request.params.id ?? ''];
  return found
    ? fakeResponse(200, found)
    : fakeResponse(404, {
        code: 'NOT_FOUND',
        message: 'The requested person was not found.',
        correlationId: 'c',
        nextAction: 'verify_reference',
      });
};

/** Routes most screens need to name people and offerings. */
export function nameRoutes(
  offerings: Model<'Offering'>[] = [offering()],
): Record<string, FakeHandler> {
  return {
    'GET /people/{id}': peopleHandler,
    'GET /offerings/{id}': (request) => {
      const found = offerings.find((o) => o.id === request.params.id);
      return found
        ? fakeResponse(200, found)
        : fakeResponse(404, {
            code: 'NOT_FOUND',
            message: 'Not found',
            correlationId: 'c',
            nextAction: 'verify_reference',
          });
    },
  };
}

export function eligibility(eligible: boolean): Model<'EligibilityResult'> {
  return {
    eligible,
    policyVersionId: POLICY_ELIGIBILITY_ID,
    referenceDate: '2026-11-02',
    evaluatedAt: NOW,
    reasons: eligible
      ? []
      : [
          {
            code: 'age_out_of_band',
            severity: 'blocking',
            message: 'The participant is older than the age band on the reference date.',
            source: { type: 'policy_version', id: POLICY_ELIGIBILITY_ID },
            requiredAction: 'choose_other_offering',
          },
        ],
    alternatives: eligible
      ? []
      : [{ kind: 'other_offering', message: 'Try the U12 group.', offeringId: null }],
    overridden: false,
  };
}

const actor = (kind: 'customer' | 'staff', label: string) => ({
  kind,
  accountId: null,
  personId: null,
  staffRoles: kind === 'staff' ? ['front_desk'] : [],
  actorLabel: label,
});

export function application(overrides: Partial<Model<'Application'>> = {}): Model<'Application'> {
  return {
    id: APPLICATION_ID,
    offeringId: OFFERING_ID,
    participantPersonId: PERSON_ID,
    intent: 'youth',
    // The API keeps an application that failed eligibility in `submitted` (only eligible ones
    // move to `awaiting_review`), so the ineligible default is submitted.
    status: 'submitted',
    submittedBy: actor('customer', 'Sam Rivera'),
    submittedByPersonId: ADULT_ID,
    payerPersonId: ADULT_ID,
    eligibility: eligibility(false),
    override: null,
    requiresApproval: true,
    teamEntryId: null,
    sessionId: null,
    notes: null,
    submittedAt: '2026-10-24T09:00:00.000Z',
    decidedAt: null,
    decidedByPersonId: null,
    decisionReason: null,
    withdrawnAt: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const policies = {
  eligibilityPolicyVersionId: POLICY_ELIGIBILITY_ID,
  cancellationPolicyVersionId: null,
  requiredFormPolicyVersionIds: [POLICY_FORM_ID],
  approvalPolicyVersionId: null,
};

export function basket(overrides: Partial<Model<'Basket'>> = {}): Model<'Basket'> {
  return {
    id: BASKET_ID,
    ownerPersonId: ADULT_ID,
    payerPersonId: null,
    createdBy: actor('staff', 'Front desk 1'),
    assistedByPersonId: MANAGER_ID,
    fulfillmentMode: 'all_or_nothing',
    partialAcceptedAt: null,
    status: 'open',
    holdExpiresAt: null,
    currency: 'USD',
    subtotalMinor: 12500,
    approvalPending: false,
    orderRef: null,
    lastOperationId: null,
    lines: [
      {
        id: LINE_ID,
        basketId: BASKET_ID,
        sequence: 1,
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        offeringKind: 'term',
        sessionId: null,
        teamEntryId: null,
        intent: 'youth',
        quantity: 1,
        applicationId: null,
        applicationStatus: NULL_REF,
        trialParticipationId: null,
        entitlementDefinitionId: ENTITLEMENT_ID,
        equivalenceKey: null,
        eligibility: eligibility(true),
        price: {
          priceRuleId: POLICY_FORM_ID,
          basePriceMinor: 12500,
          currency: 'USD',
          chargeLines: [],
        },
        policies,
        requiresApproval: false,
        enrollmentId: null,
        outcome: 'pending',
        outcomeReason: null,
        revision: 1,
      },
    ],
    holds: [],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function hold(): Model<'Hold'> {
  return {
    id: '0192f1a0-0000-7000-8000-000000000799',
    poolId: POOL_ID,
    quantity: 1,
    ownerKind: 'basket',
    ownerId: BASKET_ID,
    basketId: BASKET_ID,
    status: 'active',
    acquiredAt: NOW,
    expiresAt: '2026-10-24T12:10:00.000Z',
    committedAt: null,
    releasedAt: null,
    expiredAt: null,
    releaseReason: null,
    revision: 1,
  };
}

export function quote(overrides: Partial<Model<'Quote'>> = {}): Model<'Quote'> {
  return {
    id: QUOTE_ID,
    basketId: BASKET_ID,
    payerPersonId: ADULT_ID,
    status: 'active',
    currency: 'USD',
    lines: [
      {
        id: '0192f1a0-0000-7000-8000-000000000706',
        sequence: 1,
        basketLineId: LINE_ID,
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        description: 'Spring academy U10',
        quantity: 1,
        priceRuleId: null,
        unitPriceMinor: 12500,
        baseAmountMinor: 12500,
        discountMinor: 0,
        taxMinor: 0,
        feeMinor: 0,
        includedTaxMinor: 0,
        totalMinor: 12500,
        currency: 'USD',
        discounts: [],
        charges: [],
        policies,
        enrollmentId: null,
      },
    ],
    subtotalMinor: 12500,
    discountMinor: 0,
    taxMinor: 0,
    feeMinor: 0,
    includedTaxMinor: 0,
    totalMinor: 12500,
    creditsAppliedMinor: 0,
    appliedCredits: [],
    dueNowMinor: 12500,
    paymentPlan: 'full',
    futureObligations: [],
    discounts: [],
    policies: {
      overpaymentPolicyVersionId: null,
      installmentPolicyVersionId: null,
      refundPolicyVersionId: null,
      defaults: ['refund_default'],
    },
    expiresAt: '2026-10-24T12:15:00.000Z',
    consumedByCheckoutId: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function paymentAttempt(
  overrides: Partial<Model<'PaymentAttempt'>> = {},
): Model<'PaymentAttempt'> {
  return {
    id: PAYMENT_ID,
    purpose: 'checkout',
    status: 'succeeded',
    amountMinor: 12500,
    currency: 'USD',
    provider: 'fake',
    providerReference: 'fake_ref_1',
    actionRequired: null,
    failureReason: null,
    evidenceSource: 'sync_response',
    payerPersonId: ADULT_ID,
    checkoutId: CHECKOUT_ID,
    orderId: ORDER_ID,
    obligationId: null,
    contributionRequestId: null,
    posSaleId: null,
    installmentId: null,
    unknownSince: null,
    resolvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** `GET /payments/{id}` (FIN-02): the attempt with what is still refundable and its refunds. */
export function paymentDetail(
  overrides: Partial<Model<'PaymentAttempt'>> = {},
  detail: { refundableMinor?: number; refunds?: Model<'PaymentRefundSummary'>[] } = {},
): Model<'PaymentDetail'> {
  return {
    ...paymentAttempt(overrides),
    refundableMinor: detail.refundableMinor ?? 12500,
    refunds: detail.refunds ?? [],
  } as Model<'PaymentDetail'>;
}

export function checkout(overrides: Partial<Model<'Checkout'>> = {}): Model<'Checkout'> {
  return {
    id: CHECKOUT_ID,
    quoteId: QUOTE_ID,
    orderId: ORDER_ID,
    basketId: BASKET_ID,
    payerPersonId: ADULT_ID,
    status: 'completed',
    paymentKind: 'cash',
    payment: null,
    receipt: {
      id: '0192f1a0-0000-7000-8000-000000000707',
      sourceKind: 'cash_tender',
      paymentAttemptId: null,
      cashTenderId: '0192f1a0-0000-7000-8000-000000000708',
      amountMinor: 12500,
      allocatedMinor: 12500,
      excessMinor: 0,
      currency: 'USD',
      receivedAt: NOW,
    },
    holdIds: [],
    enrollmentIds: [ENROLLMENT_ID],
    operationId: '0192f1a0-0000-7000-8000-000000000709',
    failure: null,
    recovery: null,
    nextAction: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

export function waitlistEntry(
  overrides: Partial<Model<'WaitlistEntry'>> = {},
): Model<'WaitlistEntry'> {
  return {
    id: ENTRY_ID,
    offeringId: OFFERING_ID,
    poolId: POOL_ID,
    sessionId: null,
    participantPersonId: PERSON_ID,
    intent: 'youth',
    priorityBasis: 'joined_at',
    priorityRank: 0,
    joinedAt: '2026-10-20T10:00:00.000Z',
    queuedAt: '2026-10-20T10:00:00.000Z',
    preferences: { group: 'morning' },
    payerPersonId: ADULT_ID,
    status: 'waiting',
    position: 1,
    offerCount: 0,
    offers: [],
    acceptedEnrollmentId: null,
    withdrawnAt: null,
    removedAt: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function capacityPool(
  overrides: Partial<Model<'CapacityPool'>> = {},
): Model<'CapacityPool'> {
  return {
    id: POOL_ID,
    offeringId: OFFERING_ID,
    scopeType: 'offering',
    scopeId: OFFERING_ID,
    unit: 'seats',
    constraintKind: 'commercial',
    capacity: 20,
    committed: 19,
    held: 1,
    available: 0,
    participantsPerStaff: null,
    staffCount: null,
    status: 'active',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function enrollment(overrides: Partial<Model<'Enrollment'>> = {}): Model<'Enrollment'> {
  return {
    id: ENROLLMENT_ID,
    offeringId: OFFERING_ID,
    participantPersonId: PERSON_ID,
    intent: 'youth',
    entitlementDefinitionId: ENTITLEMENT_ID,
    equivalenceKey: null,
    status: 'confirmed',
    payerPersonId: ADULT_ID,
    registeredBy: actor('customer', 'Sam Rivera'),
    assistedByPersonId: null,
    sourceApplicationId: null,
    basketId: BASKET_ID,
    basketLineId: LINE_ID,
    placementRequestId: null,
    trialParticipationId: null,
    orderRef: null,
    lastOperationId: null,
    offering: null,
    pendingReason: null,
    price: { priceRuleId: POLICY_FORM_ID, basePriceMinor: 12500, currency: 'USD', chargeLines: [] },
    policies,
    confirmedAt: NOW,
    canceledAt: null,
    cancellationReason: null,
    cancellationPolicyVersionId: null,
    cancellationConsequence: null,
    transferredAt: null,
    transferredToEnrollmentId: null,
    transferredFromEnrollmentId: null,
    transferConsequence: null,
    completedAt: null,
    revision: 5,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const summary = (id: string, name: string) => ({
  offeringId: id,
  offeringName: name,
  startsOn: '2026-11-02',
  endsOn: '2026-12-14',
  entitlementDefinitionId: ENTITLEMENT_ID,
  price: { priceRuleId: POLICY_FORM_ID, basePriceMinor: 12500, currency: 'USD', chargeLines: [] },
});

export function cancellationPreview(permitted = true): Model<'CancellationPreview'> {
  return {
    enrollmentId: ENROLLMENT_ID,
    status: 'confirmed',
    existing: summary(OFFERING_ID, 'Spring academy U10'),
    affectedDates: { startsOn: '2026-11-02', endsOn: '2026-12-14' },
    capacity: { released: [{ poolId: POOL_ID, unit: 'seats', quantity: 1 }] },
    cancellationPolicyVersionId: POLICY_CANCELLATION_ID,
    financialConsequence: {
      kind: 'credit',
      amountMinor: 5000,
      currency: 'USD',
      explanation: 'A partial credit applies under the cancellation policy.',
      policyVersionId: POLICY_CANCELLATION_ID,
    },
    requiredApproval: false,
    permitted,
  };
}

export function transferPreview(committed = false): Model<'TransferPreview'> {
  return {
    enrollmentId: ENROLLMENT_ID,
    existing: summary(OFFERING_ID, 'Spring academy U10'),
    proposed: summary(OFFERING_B_ID, 'Spring academy U10 evenings'),
    affectedDates: {
      existingRange: { startsOn: '2026-11-02', endsOn: '2026-12-14' },
      proposedRange: { startsOn: '2026-11-02', endsOn: '2026-12-14' },
      overlapping: true,
    },
    capacity: {
      released: [{ poolId: POOL_ID, unit: 'seats' }],
      required: [
        {
          poolId: '0192f1a0-0000-7000-8000-000000000803',
          unit: 'seats',
          constraintKind: 'commercial',
          available: 3,
        },
      ],
      waitlistAhead: 0,
      sufficient: true,
    },
    eligibility: eligibility(true),
    financialConsequence: {
      kind: 'charge',
      amountMinor: 1500,
      currency: 'USD',
      explanation: 'The evening group costs more.',
      policyVersionId: null,
    },
    requiredApproval: false,
    committed,
    // The generated type of a nullable object ref is unusable (see NULL_REF), hence the casts.
    newEnrollment: committed
      ? (enrollment({ id: ENROLLMENT_NEW_ID, offeringId: OFFERING_B_ID }) as never)
      : NULL_REF,
    previousEnrollment: committed ? (enrollment({ status: 'transferred' }) as never) : NULL_REF,
  };
}

export function obligation(overrides: Partial<Model<'Obligation'>> = {}): Model<'Obligation'> {
  return {
    id: OBLIGATION_ID,
    debtor: { kind: 'person', personId: ADULT_ID, teamEntryId: null },
    mode: 'individual',
    responsiblePayerPersonId: null,
    source: { kind: 'order', id: ORDER_ID },
    orderId: ORDER_ID,
    description: 'Spring academy U10 installments',
    dueAt: '2026-11-01T00:00:00.000Z',
    status: 'open',
    totals: {
      amountMinor: 12500,
      receivedMinor: 6000,
      allocatedMinor: 5000,
      remainingMinor: 7500,
      excessMinor: 1000,
      currency: 'USD',
    },
    contributions: null,
    liveAttempt: null,
    revision: 2,
    createdAt: NOW,
    ...overrides,
  };
}

export function order(overrides: Partial<Model<'Order'>> = {}): Model<'Order'> {
  return {
    id: ORDER_ID,
    quoteId: QUOTE_ID,
    basketId: BASKET_ID,
    payerPersonId: ADULT_ID,
    currency: 'USD',
    totalMinor: 12500,
    creditsAppliedMinor: 0,
    dueNowMinor: 5000,
    paymentStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    lines: [
      {
        id: '0192f1a0-0000-7000-8000-000000000710',
        sequence: 1,
        basketLineId: LINE_ID,
        enrollmentId: ENROLLMENT_ID,
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        description: 'Spring academy U10',
        quantity: 1,
        priceRuleId: null,
        unitPriceMinor: 12500,
        baseAmountMinor: 12500,
        discountMinor: 0,
        taxMinor: 0,
        feeMinor: 0,
        totalMinor: 12500,
        currency: 'USD',
        policies,
      },
    ],
    obligationIds: [OBLIGATION_ID],
    installmentPlanId: PLAN_ID,
    paidAt: NOW,
    fulfilledAt: NOW,
    canceledAt: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function installmentPlan(): Model<'InstallmentPlan'> {
  const installment = (
    sequence: number,
    status: Model<'Installment'>['status'],
  ): Model<'Installment'> => ({
    id: `0192f1a0-0000-7000-8000-00000000110${sequence}`,
    sequence,
    obligationId: OBLIGATION_ID,
    amountMinor: 3750,
    currency: 'USD',
    dueAt: '2026-11-15T00:00:00.000Z',
    originalDueAt: '2026-11-15T00:00:00.000Z',
    status,
    attemptCount: status === 'failed' ? 3 : 0,
    lastFailureReason: status === 'failed' ? 'card_declined' : null,
    nextRetryAt: null,
    paidAt: null,
    extensionCount: 0,
    noticeSentAt: null,
    revision: 1,
  });
  return {
    id: PLAN_ID,
    orderId: ORDER_ID,
    payerPersonId: ADULT_ID,
    currency: 'USD',
    totalMinor: 7500,
    status: 'active',
    authorization: { authorizedAt: NOW, authorizedByPersonId: ADULT_ID },
    retryPolicy: { maxAttempts: 3, retryIntervalHours: 24 },
    noticePolicy: { daysBefore: 3 },
    outstandingMinor: 7500,
    installments: [installment(1, 'failed'), installment(2, 'scheduled')],
    revision: 1,
  };
}

export function exception(
  overrides: Partial<Model<'OperationalException'>> = {},
): Model<'OperationalException'> {
  return {
    id: EXCEPTION_ID,
    facilityId: null,
    category: 'finance.unknown_payment_outcome',
    severity: 'critical',
    title: 'A payment outcome is unknown; reconcile before charging the customer again',
    affected: { type: 'payment_attempt', id: PAYMENT_ID },
    ownerQueue: 'finance_operator',
    status: 'open',
    openedAt: '2026-10-24T09:00:00.000Z',
    ageMinutes: 180,
    deadlineAt: null,
    acknowledgeBy: null,
    overdue: false,
    acknowledgedAt: null,
    resolvedAt: null,
    closedAt: null,
    resolution: null,
    details: {},
    revision: 1,
    history: [],
    nextActions: [],
    underlyingRecordUnchanged: true,
    ...overrides,
  };
}

export function refund(overrides: Partial<Model<'Refund'>> = {}): Model<'Refund'> {
  return {
    id: REFUND_ID,
    paymentAttemptId: PAYMENT_ID,
    amountMinor: 2500,
    currency: 'USD',
    purpose: 'customer_refund',
    status: 'succeeded',
    reservationStatus: 'settled',
    reason: 'Missed the first week',
    providerReference: 'fake_refund_1',
    failureReason: null,
    checkoutId: null,
    operationId: null,
    refundable: {
      capturedMinor: 12500,
      refundedMinor: 2500,
      reservedMinor: 0,
      availableMinor: 10000,
      currency: 'USD',
    },
    unknownSince: null,
    resolvedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

export function credit(overrides: Partial<Model<'Credit'>> = {}): Model<'Credit'> {
  return {
    id: CREDIT_ID,
    ownerPersonId: ADULT_ID,
    currency: 'USD',
    originalMinor: 1000,
    remainingMinor: 1000,
    permittedUses: ['registration', 'obligation'],
    sourceKind: 'overpayment',
    sourceId: '0192f1a0-0000-7000-8000-000000000707',
    status: 'pending_approval',
    expiresAt: null,
    reason: 'Payment exceeded the remaining balance (SPK-PAY-005)',
    approvedAt: null,
    redemptions: [],
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function reconciliationReport(
  overrides: Partial<Model<'ReconciliationReport'>> = {},
): Model<'ReconciliationReport'> {
  return {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-25T00:00:00.000Z',
    currency: 'USD',
    orders: { count: 3, totalMinor: 37500, paidCount: 2 },
    obligations: { openCount: 1, openRemainingMinor: 7500, settledCount: 2 },
    receipts: { processorMinor: 25000, cashMinor: 12500, count: 3, excessMinor: 1000 },
    refunds: { succeededMinor: 2500, reservedMinor: 0, unknownCount: 1 },
    credits: { issuedMinor: 1000, redeemedMinor: 0, pendingApprovalMinor: 1000 },
    processorFeesMinor: 750,
    disputes: { count: 0, note: 'Disputes are not reported by the fake provider.' },
    settlements: [
      {
        id: '0192f1a0-0000-7000-8000-000000001301',
        kind: 'cash_drawer',
        provider: null,
        facilityId: FACILITY_A,
        periodStart: '2026-10-23T00:00:00.000Z',
        periodEnd: '2026-10-24T00:00:00.000Z',
        currency: 'USD',
        expectedMinor: 12500,
        reportedMinor: 12000,
        differenceMinor: -500,
        status: 'discrepancy',
        breakdown: {},
        externalReference: null,
        performedAt: NOW,
      },
    ],
    cash: { recordedMinor: 12500, unreconciledMinor: 0 },
    exceptions: { unknownPayments: 1, recoveryRequiredCheckouts: 0 },
    ledger: [
      { accountCode: 'cash_processor', debitMinor: 25000, creditMinor: 0, balanceMinor: 25000 },
      { accountCode: 'deferred_revenue', debitMinor: 0, creditMinor: 37500, balanceMinor: -37500 },
    ],
    ...overrides,
  };
}

/** ENR-02: the offering an enrollment names, with its facility zone (SPK-SCHED-008). */
export function enrollmentOffering(kind: Model<'OfferingKind'> = 'term') {
  return {
    id: OFFERING_ID,
    name: 'Spring academy U10',
    kind,
    startsOn: '2026-11-02',
    endsOn: '2026-12-14',
    facilityId: FACILITY_A,
    timezone: 'America/Los_Angeles',
  } as never;
}

export function packageEntitlement(
  overrides: Partial<Model<'PackageEntitlement'>> = {},
): Model<'PackageEntitlement'> {
  return {
    id: PACKAGE_ID,
    participantPersonId: PERSON_ID,
    enrollmentId: ENROLLMENT_ID,
    offeringId: OFFERING_ID,
    offeringName: 'Ten-session pack',
    entitlementDefinitionId: ENTITLEMENT_ID,
    appliesTo: { offeringIds: [OFFERING_B_ID], programIds: [] },
    credits: 10,
    redeemedCount: 1,
    remainingCredits: 9,
    status: 'active',
    expiresAt: '2027-01-31T08:00:00.000Z',
    issuedAt: NOW,
    expiredAt: null,
    revokedAt: null,
    revokedReason: null,
    redemptions: [
      {
        id: REDEMPTION_ID,
        sessionBookingId: '0192f1a0-0000-7000-8000-000000001405',
        kind: 'redeem',
        reversesRedemptionId: null,
        reason: null,
        redeemedAt: '2026-10-22T17:00:00.000Z',
      },
    ],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function membershipSuspension(
  overrides: Partial<Model<'MembershipSuspension'>> = {},
): Model<'MembershipSuspension'> {
  return {
    id: SUSPENSION_ID,
    enrollmentId: ENROLLMENT_ID,
    participantPersonId: PERSON_ID,
    from: '2026-11-02T08:00:00.000Z',
    until: null,
    reason: 'Injury',
    status: 'active',
    endedAt: null,
    endedReason: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function providerEvent(
  overrides: Partial<Model<'ProviderEvent'>> = {},
): Model<'ProviderEvent'> {
  return {
    id: PROVIDER_EVENT_ID,
    provider: 'fake',
    providerEventId: 'evt_1',
    eventType: 'payment.succeeded',
    signatureVerified: true,
    status: 'processed',
    attempts: 1,
    lastError: null,
    receivedAt: '2026-10-24T11:00:00.000Z',
    processedAt: '2026-10-24T11:00:01.000Z',
    ...overrides,
  };
}

export function operation(overrides: Partial<Model<'Operation'>> = {}): Model<'Operation'> {
  return {
    id: OPERATION_ID,
    kind: 'finance.registration_checkout',
    status: 'running',
    correlationId: null,
    result: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

/** `GET /facilities` (K-04): both test facilities with their IANA zones. */
export const facilitiesRoute: FakeHandler = {
  status: 200,
  body: {
    items: [
      {
        id: FACILITY_A,
        slug: 'north',
        name: 'North complex',
        timezone: 'America/Los_Angeles',
        status: 'active',
        address: null,
        inStaffScope: true,
      },
    ],
  },
};

/** A §4.10 error response. */
export function apiError(
  status: number,
  code: string,
  options: { message?: string; nextAction?: string; details?: unknown } = {},
) {
  return () =>
    fakeResponse(status, {
      code,
      message: options.message ?? `Fake ${code}`,
      correlationId: 'test-correlation-id',
      nextAction: options.nextAction ?? 'retry_or_contact_support',
      ...(options.details === undefined ? {} : { details: options.details }),
    });
}
