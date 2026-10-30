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
        verb: 'open',
        label: 'Reconcile the payment with the provider',
        method: 'POST',
        href: `/v1/payments/${PAYMENT_ID}/reconcile`,
      },
      {
        action: 'exceptions.manage',
        verb: 'acknowledge',
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

/**
 * The exception lifecycle steps as the API lists them (SUP-01 `verb`). `action` is the kernel's
 * `exceptions.manage`, or `exceptions.manage_own_queue` for a viewer who holds the role the queue
 * is named after (K-10); the client must offer the step either way.
 */
export function lifecycleActions(
  action: 'exceptions.manage' | 'exceptions.manage_own_queue' = 'exceptions.manage',
  verbs: readonly ('acknowledge' | 'resolve' | 'close')[] = ['acknowledge', 'resolve', 'close'],
) {
  const labels = { acknowledge: 'Acknowledge', resolve: 'Mark resolved', close: 'Close' };
  return verbs.map((verb) => ({
    action,
    verb,
    label: labels[verb],
    method: 'POST',
    href: `/v1/exceptions/${EXCEPTION_ID}/${verb}`,
  }));
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
    nextActions: lifecycleActions(),
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
      settlements: [],
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

/** `GET /v1/reports/expected-arrivals` (REP-01): counts only, never names. */
export function expectedArrivalsReport(overrides: Record<string, unknown> = {}) {
  return {
    report: {
      key: 'expected_arrivals',
      title: 'Expected arrivals',
      requirementIds: ['SPK-REPORT-002'],
      accessAction: 'reporting.view_operations_reports',
      exportAction: 'reporting.export_operational',
    },
    runId: null,
    asOf: TEST_NOW.toISOString(),
    producedAt: TEST_NOW.toISOString(),
    scope: { facilityId: FACILITY_A, timezone: 'America/Los_Angeles', from: null, to: null },
    parameters: {},
    freshness: { class: 'F1', pointInTime: 'partial', note: '' },
    settings: [],
    metrics: [],
    disclosures: [
      'Counts only: no participant is named (child data minimization, §4.14, rule G9).',
    ],
    values: [
      {
        metric: 'MET-004',
        label: 'Expected arrivals',
        value: 14,
        unit: 'count',
        currency: null,
        dimensions: {},
        unavailableReason: null,
      },
      {
        metric: 'MET-006',
        label: 'Supervised releases expected',
        value: null,
        unit: 'count',
        currency: null,
        dimensions: {},
        unavailableReason: 'pending DEC-075',
      },
    ],
    columns: [],
    rows: [
      {
        activityType: 'session',
        activityId: 'act-2',
        offeringId: null,
        sessionId: 's-2',
        title: 'U8 skills session',
        start: '2026-10-24T18:00:00.000Z',
        localStart: '11:00',
        expected: 9,
        adults: 1,
        children: 8,
        byEnrollment: 9,
        byBooking: 0,
        byRoster: 0,
        supervisedReleasesExpected: 8,
      },
      {
        activityType: 'fixture',
        activityId: 'act-1',
        offeringId: null,
        sessionId: null,
        title: 'Rovers v United',
        start: '2026-10-24T11:00:00.000Z',
        localStart: '04:00',
        expected: 5,
        adults: 5,
        children: 0,
        byEnrollment: 0,
        byBooking: 0,
        byRoster: 5,
        supervisedReleasesExpected: 0,
      },
    ],
    ...overrides,
  };
}

/** One page of `GET /v1/audit-records` (K-08). */
export function auditPage(targetType: string, targetId: string, nextCursor: string | null = null) {
  return {
    items: [
      {
        id: '0192f1a0-0000-7000-8000-00000000ad01',
        occurredAt: TEST_NOW.toISOString(),
        actor: {
          kind: 'staff',
          accountId: null,
          personId: null,
          staffRoles: ['general_manager'],
          sessionId: null,
          actorLabel: 'Staff GM',
        },
        action: 'exceptions.manage',
        targetType,
        targetId,
        beforeRevision: 3,
        afterRevision: 4,
        reason: 'Called the provider',
        correlationId: null,
        operationId: null,
        details: { masked: 'a***@example.test' },
      },
    ],
    nextCursor,
  };
}
