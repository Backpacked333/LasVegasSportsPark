// Fixtures for the Today, exception and assistant tests (SCR-S-01, SCR-S-02, SCR-S-50).
import { FACILITY_A, TEST_NOW } from '../../../testing/test-app';

export const EXCEPTION_ID = '0192f1a0-0000-7000-8000-0000000000e1';
export const PAYMENT_ID = '0192f1a0-0000-7000-8000-0000000000a1';
export const CHECKOUT_ID = '0192f1a0-0000-7000-8000-0000000000c1';

export function exceptionItem(overrides: Record<string, unknown> = {}) {
  return {
    id: `exception:${EXCEPTION_ID}`,
    source: 'exception',
    group: 'financial',
    category: 'finance.unknown_payment_outcome',
    title: 'Payment outcome unknown for checkout',
    severity: 'critical',
    facilityId: FACILITY_A,
    affected: { type: 'payment_attempt', id: PAYMENT_ID },
    ownerQueue: 'finance',
    status: 'open',
    openedAt: '2026-10-24T10:30:00.000Z',
    ageMinutes: 90,
    deadlineAt: null,
    overdue: true,
    nextActions: [
      {
        action: 'finance.reconcile_payment',
        label: 'Reconcile the payment with the provider',
        method: 'POST',
        href: `/v1/payments/${PAYMENT_ID}/reconcile`,
      },
      {
        action: 'exceptions.manage',
        label: 'Acknowledge',
        method: 'POST',
        href: `/v1/exceptions/${EXCEPTION_ID}/acknowledge`,
      },
    ],
    history: [
      {
        at: '2026-10-24T10:30:00.000Z',
        action: 'exceptions.opened',
        actorLabel: 'system',
        reason: null,
      },
    ],
    details: { exceptionId: EXCEPTION_ID, revision: 4 },
    ...overrides,
  };
}

export function operationalException(overrides: Record<string, unknown> = {}) {
  return {
    id: EXCEPTION_ID,
    facilityId: FACILITY_A,
    category: 'finance.unknown_payment_outcome',
    severity: 'critical',
    title: 'Payment outcome unknown for checkout',
    affected: { type: 'payment_attempt', id: PAYMENT_ID },
    ownerQueue: 'finance',
    status: 'open',
    openedAt: '2026-10-24T10:30:00.000Z',
    ageMinutes: 90,
    deadlineAt: '2026-10-24T14:30:00.000Z',
    acknowledgeBy: null,
    overdue: false,
    acknowledgedAt: null,
    resolvedAt: null,
    closedAt: null,
    resolution: null,
    details: {},
    revision: 4,
    history: [
      {
        at: '2026-10-24T10:30:00.000Z',
        action: 'exceptions.opened',
        actorLabel: 'system',
        reason: null,
      },
    ],
    nextActions: ['acknowledge', 'resolve', 'close'].map((verb) => ({
      action: 'exceptions.manage',
      label: verb,
      method: 'POST',
      href: `/v1/exceptions/${EXCEPTION_ID}/${verb}`,
    })),
    underlyingRecordUnchanged: true,
    ...overrides,
  };
}

export function paymentAttempt(status: string) {
  return {
    id: PAYMENT_ID,
    purpose: 'checkout',
    status,
    amountMinor: 2500,
    currency: 'USD',
    provider: 'fake',
    providerReference: null,
    actionRequired: null,
    failureReason: null,
    evidenceSource: null,
    payerPersonId: null,
    checkoutId: null,
    orderId: null,
    obligationId: null,
    contributionRequestId: null,
    installmentId: null,
    unknownSince: null,
    resolvedAt: null,
    createdAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
  };
}

export function scheduledEvent(id: string, start: string, end: string, status = 'published') {
  return {
    id,
    facilityId: FACILITY_A,
    kind: 'game',
    title: `Activity ${id}`,
    format: null,
    seriesId: null,
    occurrenceIndex: null,
    scheduledStart: start,
    scheduledEnd: end,
    timezone: 'America/Los_Angeles',
    setupMinutes: 0,
    cleanupMinutes: 0,
    dstResolution: 'exact',
    status,
    publishedRevision: 1,
    revision: 1,
    sourceType: null,
    sourceId: null,
    resourceIds: [],
    commitments: [],
    canceledAt: null,
    cancelReason: null,
    createdAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
  };
}

const ACTOR = {
  kind: 'staff',
  accountId: null,
  personId: null,
  staffRoles: ['general_manager'],
  actorLabel: 'Staff GM',
};

export function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: '0192f1a0-0000-7000-8000-0000000000b1',
    assistantRequestId: '0192f1a0-0000-7000-8000-0000000000b0',
    kind: 'communication_draft',
    consequential: true,
    title: 'Tell U12 families about the pitch change',
    summary: 'Pitch 2 is closed; the 14:00 match moves to pitch 3.',
    facilityId: FACILITY_A,
    payload: {},
    command: {
      actionId: 'communications.send',
      input: { subject: 'Pitch change', audience: 'fixture participants' },
      target: { type: 'notification', id: null, facilityId: FACILITY_A },
    },
    evidence: [
      {
        recordType: 'maintenance_restriction',
        recordId: 'r-1',
        source: 'facilities.restrictions',
        label: 'Pitch 2 closure',
        observedAt: TEST_NOW.toISOString(),
        asOf: '2026-10-23T08:00:00.000Z',
        ageSeconds: 100000,
        freshness: 'stale',
        changedSinceClientObservation: null,
      },
    ],
    missingEvidence: [
      {
        recordType: 'fixture',
        recordId: null,
        source: null,
        reason: 'not_available',
        description: 'A referenced fixture is not available.',
      },
    ],
    status: 'proposed',
    requester: ACTOR,
    proposedAt: TEST_NOW.toISOString(),
    expiresAt: '2026-10-25T12:00:00.000Z',
    review: null,
    apply: {
      state: 'pending',
      operationId: null,
      startedAt: null,
      appliedBy: null,
      appliedAt: null,
      auditRecordId: null,
      commandOperationId: null,
      record: null,
      lastError: null,
    },
    expiredAt: null,
    revision: 2,
    ...overrides,
  };
}

export function assistantRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: '0192f1a0-0000-7000-8000-0000000000b0',
    status: 'answered',
    prompt: 'Summarize today',
    facilityId: null,
    requester: ACTOR,
    attachments: [],
    contextReferences: [],
    provider: 'fake',
    turns: 1,
    response: { text: 'Two issues are open; one payment outcome is unknown.' },
    evidence: [
      {
        recordType: 'operational_exception',
        recordId: EXCEPTION_ID,
        source: 'support.today',
        label: 'Unknown payment outcome',
        observedAt: TEST_NOW.toISOString(),
        asOf: TEST_NOW.toISOString(),
        ageSeconds: 0,
        freshness: 'live',
        changedSinceClientObservation: null,
      },
    ],
    missingEvidence: [],
    recommendations: [],
    toolInvocations: [],
    error: null,
    operationId: '0192f1a0-0000-7000-8000-0000000000b9',
    receivedAt: TEST_NOW.toISOString(),
    completedAt: TEST_NOW.toISOString(),
    revision: 1,
    ...overrides,
  };
}
