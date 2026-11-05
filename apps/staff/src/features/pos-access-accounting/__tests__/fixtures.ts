/**
 * API payloads for the SCR-S-55, SCR-S-56 and SCR-S-57 tests, shaped like the OpenAPI schemas
 * (packages/contracts/src/api/finance-pos.ts, finance-accounting.ts, entry-hardware.ts). Ids are
 * fixed UUIDs; names are invented and carry no real person.
 */
import type { CapabilityId, Schema, Schemas } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { FACILITY_A, FACILITY_B, TEST_NOW, mePermissions } from '../../../testing/test-app';

type Model<N extends keyof Schemas> = NonNullable<Schema<N>>;

export const NOW = TEST_NOW.toISOString();
/** The signed-in staff member of `createTestApp` (`staffMe`). */
export const ME_PERSON = '0192f1a0-0000-7000-8000-0000000000dd';
export const OTHER_PERSON = '0192f1a0-0000-7000-8000-000000000303';
export const CUSTOMER_ID = '0192f1a0-0000-7000-8000-000000000301';

export const PRODUCT_ID = '0192f1a0-0000-7000-8000-00000000a001';
export const PRODUCT_B_ID = '0192f1a0-0000-7000-8000-00000000a002';
export const REGISTER_ID = '0192f1a0-0000-7000-8000-00000000a101';
export const REGISTER_B_ID = '0192f1a0-0000-7000-8000-00000000a102';
export const SESSION_ID = '0192f1a0-0000-7000-8000-00000000a201';
export const SALE_ID = '0192f1a0-0000-7000-8000-00000000a301';
export const LINE_ID = '0192f1a0-0000-7000-8000-00000000a302';
export const TENDER_ID = '0192f1a0-0000-7000-8000-00000000a303';
export const ATTEMPT_ID = '0192f1a0-0000-7000-8000-00000000a304';
export const RETURN_ID = '0192f1a0-0000-7000-8000-00000000a305';
export const REFUND_ID = '0192f1a0-0000-7000-8000-00000000a308';
export const TAX_VERSION_ID = '0192f1a0-0000-7000-8000-00000000a401';

export const DEVICE_ID = '0192f1a0-0000-7000-8000-00000000b001';
export const DEVICE_B_ID = '0192f1a0-0000-7000-8000-00000000b002';
export const POLICY_ID = '0192f1a0-0000-7000-8000-00000000b101';
export const POLICY_B_ID = '0192f1a0-0000-7000-8000-00000000b102';
export const COMMAND_ID = '0192f1a0-0000-7000-8000-00000000b201';
export const EXCEPTION_ID = '0192f1a0-0000-7000-8000-00000000b301';

export const MAPPING_ID = '0192f1a0-0000-7000-8000-00000000c001';
export const MAPPING_B_ID = '0192f1a0-0000-7000-8000-00000000c002';
export const BATCH_ID = '0192f1a0-0000-7000-8000-00000000c101';
export const JOURNAL_ENTRY_ID = '0192f1a0-0000-7000-8000-00000000c201';

export const ok = (body: unknown, status = 200) => ({ status, body });
export const page = <T>(items: T[], nextCursor: string | null = null) => ok({ items, nextCursor });

export function apiError(
  status: number,
  code: string,
  options: { message?: string; nextAction?: string; details?: unknown } = {},
): FakeHandler {
  return () =>
    fakeResponse(status, {
      code,
      message: options.message ?? `Fake ${code}.`,
      correlationId: 'test-correlation-id',
      nextAction: options.nextAction ?? 'retry_or_contact_support',
      ...(options.details === undefined ? {} : { details: options.details }),
    });
}

export function permissions(
  enabled: readonly CapabilityId[],
  actions: readonly (string | { id: string; facilityIds: string[] | null })[] = [],
) {
  return mePermissions({ enabled, actions });
}

// ---------------------------------------------------------------------------------------------
// Facilities and people
// ---------------------------------------------------------------------------------------------

export function facility(id: string, name: string, inStaffScope = true): Model<'FacilitySummary'> {
  return {
    id,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    timezone: 'America/Los_Angeles',
    status: 'active',
    address: null,
    inStaffScope,
  };
}

export const FACILITIES = ok({
  items: [facility(FACILITY_A, 'North Park'), facility(FACILITY_B, 'South Field')],
});

const PEOPLE: Record<string, [string, string]> = {
  [ME_PERSON]: ['Dana', 'Cole'],
  [OTHER_PERSON]: ['Pat', 'Lee'],
  [CUSTOMER_ID]: ['Alex', 'Rivera'],
};

export const peopleHandler: FakeHandler = (request) => {
  const found = PEOPLE[request.params.id ?? ''];
  return found
    ? fakeResponse(200, {
        id: request.params.id,
        kind: 'adult',
        givenName: found[0],
        familyName: found[1],
        dateOfBirth: null,
        status: 'active',
        mergedIntoPersonId: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        contactPoints: [],
      })
    : fakeResponse(404, {
        code: 'NOT_FOUND',
        message: 'Not found.',
        correlationId: 'c',
        nextAction: 'verify_reference',
      });
};

export function baseRoutes(): Record<string, FakeHandler> {
  return { 'GET /facilities': FACILITIES, 'GET /people/{id}': peopleHandler };
}

// ---------------------------------------------------------------------------------------------
// Point of sale
// ---------------------------------------------------------------------------------------------

export function product(overrides: Partial<Model<'PosProduct'>> = {}): Model<'PosProduct'> {
  return {
    id: PRODUCT_ID,
    facilityId: FACILITY_A,
    sku: 'WATER',
    name: 'Water bottle',
    kind: 'concession',
    priceMinor: 250,
    currency: 'USD',
    chargePolicyKeys: ['sales-tax'],
    status: 'active',
    retiredAt: null,
    retireReason: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function taxVersion(
  overrides: Partial<Model<'PolicyVersion'>> = {},
): Model<'PolicyVersion'> {
  return {
    id: TAX_VERSION_ID,
    kind: 'tax_fee',
    key: 'sales-tax',
    version: 1,
    title: 'County sales tax',
    content: { code: 'TAX', label: 'Sales tax', kind: 'tax', rateBasisPoints: 838 },
    effectiveFrom: NOW,
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: NOW,
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function register(overrides: Partial<Model<'PosRegister'>> = {}): Model<'PosRegister'> {
  return {
    id: REGISTER_ID,
    facilityId: FACILITY_A,
    code: 'FD1',
    name: 'Front desk',
    status: 'active',
    openSessionId: null,
    retiredAt: null,
    retireReason: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function session(
  overrides: Partial<Model<'PosRegisterSession'>> = {},
): Model<'PosRegisterSession'> {
  return {
    id: SESSION_ID,
    registerId: REGISTER_ID,
    facilityId: FACILITY_A,
    currency: 'USD',
    businessDate: '20261024',
    openingFloatMinor: 10000,
    openedByPersonId: ME_PERSON,
    openedAt: NOW,
    status: 'open',
    expectedCashMinor: 12710,
    countedCashMinor: null,
    varianceMinor: null,
    closedByPersonId: null,
    closedAt: null,
    revision: 4,
    ...overrides,
  };
}

export function line(overrides: Partial<Model<'PosSaleLine'>> = {}): Model<'PosSaleLine'> {
  return {
    id: LINE_ID,
    lineNumber: 1,
    productId: PRODUCT_ID,
    sku: 'WATER',
    name: 'Water bottle',
    kind: 'concession',
    unitPriceMinor: 250,
    quantity: 2,
    baseMinor: 500,
    charges: [
      {
        policyVersionId: TAX_VERSION_ID,
        code: 'TAX',
        label: 'Sales tax',
        kind: 'tax',
        amountMinor: 42,
      },
    ],
    chargesMinor: 42,
    lineTotalMinor: 542,
    returnedQuantity: 0,
    ...overrides,
  };
}

export function tender(overrides: Partial<Model<'PosTender'>> = {}): Model<'PosTender'> {
  return {
    id: TENDER_ID,
    kind: 'cash',
    amountMinor: 542,
    currency: 'USD',
    status: 'settled',
    paymentAttemptId: null,
    paymentStatus: null,
    evidenceReference: null,
    failureReason: null,
    recordedByPersonId: ME_PERSON,
    recordedAt: NOW,
    settledAt: NOW,
    ...overrides,
  };
}

export function sale(overrides: Partial<Model<'PosSale'>> = {}): Model<'PosSale'> {
  return {
    id: SALE_ID,
    saleNumber: 'FD1-20261024-0001',
    registerSessionId: SESSION_ID,
    facilityId: FACILITY_A,
    customerPersonId: null,
    status: 'open',
    currency: 'USD',
    subtotalMinor: 0,
    chargesMinor: 0,
    totalMinor: 0,
    settledMinor: 0,
    pendingMinor: 0,
    remainingMinor: 0,
    returnedMinor: 0,
    lines: [],
    tenders: [],
    returns: [],
    paidAt: null,
    voidReason: null,
    voidedAt: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

/** An open sale with one line of two water bottles and nothing paid. */
export function saleWithLine(overrides: Partial<Model<'PosSale'>> = {}): Model<'PosSale'> {
  return sale({
    subtotalMinor: 500,
    chargesMinor: 42,
    totalMinor: 542,
    remainingMinor: 542,
    lines: [line()],
    ...overrides,
  });
}

/** The same sale paid in cash. */
export function paidSale(overrides: Partial<Model<'PosSale'>> = {}): Model<'PosSale'> {
  return saleWithLine({
    status: 'paid',
    settledMinor: 542,
    remainingMinor: 0,
    tenders: [tender()],
    paidAt: NOW,
    revision: 3,
    ...overrides,
  });
}

export function receipt(overrides: Partial<Model<'PosReceipt'>> = {}): Model<'PosReceipt'> {
  return {
    saleId: SALE_ID,
    saleNumber: 'FD1-20261024-0001',
    facilityId: FACILITY_A,
    status: 'paid',
    currency: 'USD',
    lines: [
      {
        name: 'Water bottle',
        kind: 'concession',
        quantity: 2,
        unitPriceMinor: 250,
        baseMinor: 500,
        charges: line().charges,
        lineTotalMinor: 542,
      },
    ],
    subtotalMinor: 500,
    charges: [{ code: 'TAX', label: 'Sales tax', kind: 'tax', amountMinor: 42 }],
    totalMinor: 542,
    tenders: [{ kind: 'cash', amountMinor: 542 }],
    returns: [],
    paidAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Access hardware
// ---------------------------------------------------------------------------------------------

export function device(overrides: Partial<Model<'AccessDevice'>> = {}): Model<'AccessDevice'> {
  return {
    id: DEVICE_ID,
    facilityId: FACILITY_A,
    kind: 'turnstile',
    name: 'Main gate turnstile',
    providerDeviceRef: 'TS-0001',
    status: 'active',
    health: 'online',
    heartbeatTimeoutSeconds: 300,
    lastHeartbeatAt: '2026-10-24T11:58:00.000Z',
    registeredAt: NOW,
    retiredAt: null,
    retiredReason: null,
    activePolicyId: POLICY_ID,
    registeredBy: {
      kind: 'staff',
      accountId: null,
      personId: ME_PERSON,
      actorLabel: 'Dana Cole',
    },
    revision: 2,
    ...overrides,
  };
}

export function policy(overrides: Partial<Model<'AccessPolicy'>> = {}): Model<'AccessPolicy'> {
  return {
    id: POLICY_ID,
    deviceId: DEVICE_ID,
    facilityId: FACILITY_A,
    allowedHolderKinds: ['person'],
    allowedPassStatuses: ['active'],
    schedule: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '06:00', to: '22:00' }],
    status: 'active',
    authoredByPersonId: OTHER_PERSON,
    approvedByPersonId: ME_PERSON,
    approvedAt: NOW,
    retiredAt: null,
    retiredReason: null,
    createdAt: NOW,
    revision: 2,
    ...overrides,
  };
}

export function deviceCommand(
  overrides: Partial<Model<'DeviceCommand'>> = {},
): Model<'DeviceCommand'> {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    kind: 'sync_policy',
    passId: null,
    policyId: POLICY_ID,
    status: 'delivered',
    attempts: 1,
    lastError: null,
    lastAttemptAt: NOW,
    deliveredAt: NOW,
    createdAt: NOW,
    revision: 2,
    ...overrides,
  };
}

/** An unresolved exception at facility A, by default a hardware one of the facilities operator. */
export function hardwareException(
  overrides: Partial<Model<'OperationalException'>> = {},
): Model<'OperationalException'> {
  return {
    id: EXCEPTION_ID,
    facilityId: FACILITY_A,
    category: 'entry.device_command_undelivered',
    severity: 'high',
    title: 'A device command was not delivered after repeated attempts',
    affected: { type: 'device_command', id: COMMAND_ID },
    ownerQueue: 'facilities_operator',
    status: 'open',
    openedAt: '2026-10-24T11:00:00.000Z',
    ageMinutes: 60,
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

/** A provider event as the inbox lists it (never its payload). */
export function providerEvent(
  overrides: Partial<Model<'ProviderEvent'>> = {},
): Model<'ProviderEvent'> {
  return {
    id: '0192f1a0-0000-7000-8000-00000000b501',
    provider: 'fake-access-control',
    providerEventId: 'evt-1',
    eventType: 'access.granted',
    signatureVerified: true,
    status: 'processed',
    attempts: 1,
    lastError: null,
    receivedAt: '2026-10-24T11:30:00.000Z',
    processedAt: '2026-10-24T11:30:01.000Z',
    ...overrides,
  };
}

export function auditRecord(overrides: Partial<Model<'AuditRecord'>> = {}): Model<'AuditRecord'> {
  return {
    id: '0192f1a0-0000-7000-8000-00000000b601',
    occurredAt: '2026-10-24T10:00:00.000Z',
    actor: {
      kind: 'staff',
      accountId: null,
      personId: ME_PERSON,
      staffRoles: ['system_administrator'],
      sessionId: null,
      actorLabel: 'Dana Cole',
    },
    action: 'entry.update_access_device',
    targetType: 'access_device',
    targetId: DEVICE_ID,
    beforeRevision: 1,
    afterRevision: 2,
    reason: null,
    correlationId: 'corr-audit-1',
    operationId: null,
    details: { name: 'Main gate turnstile' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Accounting export
// ---------------------------------------------------------------------------------------------

export function mapping(
  overrides: Partial<Model<'AccountingMapping'>> = {},
): Model<'AccountingMapping'> {
  return {
    id: MAPPING_ID,
    ledgerAccount: 'pos_revenue',
    externalAccountRef: '4000-POS',
    status: 'approved',
    proposedByPersonId: OTHER_PERSON,
    approvedByPersonId: ME_PERSON,
    approvedAt: NOW,
    retiredAt: null,
    retireReason: null,
    revision: 2,
    createdAt: NOW,
    ...overrides,
  };
}

export function batch(
  overrides: Partial<Model<'AccountingExportBatch'>> = {},
): Model<'AccountingExportBatch'> {
  return {
    id: BATCH_ID,
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-10-08T00:00:00.000Z',
    status: 'prepared',
    checksum: 'sha256:abc123',
    lineCount: 2,
    totals: [{ currency: 'USD', debitMinor: 542, creditMinor: 542 }],
    providerReference: null,
    lastError: null,
    preparedByPersonId: ME_PERSON,
    preparedAt: NOW,
    submittedAt: null,
    decidedAt: null,
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    lines: null,
    ...overrides,
  };
}

export function batchLine(
  overrides: Partial<Model<'AccountingExportLine'>> = {},
): Model<'AccountingExportLine'> {
  return {
    id: '0192f1a0-0000-7000-8000-00000000c301',
    lineNumber: 1,
    journalEntryId: JOURNAL_ENTRY_ID,
    ledgerAccount: 'cash_on_hand',
    externalAccountRef: '1000-CASH',
    debitMinor: 542,
    creditMinor: 0,
    currency: 'USD',
    postedAt: '2026-10-02T17:00:00.000Z',
    memo: 'POS sale FD1-20261002-0001',
    live: true,
    ...overrides,
  };
}
