/**
 * Synthetic API payloads for the SCR-S-43 to SCR-S-48 tests, shaped like the OpenAPI schemas
 * (packages/contracts/src/api/reporting.ts, migration.ts, identity.ts, catalog). No facility fact,
 * price, policy value or real person is used; ids are fixed UUID-shaped strings.
 */
import type { Schema } from '@sportspark/api-client';
import { FACILITY_A, TEST_NOW } from '../../../testing/test-app';

export const NOW_ISO = TEST_NOW.toISOString();
export const ORG = '0192f1a0-0000-7000-8000-0000000000aa';

export function uuid(n: number): string {
  return `0192f1a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export const RUN_1 = uuid(101);
export const RUN_2 = uuid(102);
export const EXPORT_1 = uuid(201);
export const BATCH_1 = uuid(301);
export const BATCH_2 = uuid(302);
export const PERSON_1 = uuid(401);
export const MEMBERSHIP_1 = uuid(501);
export const REPORT_1 = uuid(601);

const actor = {
  kind: 'staff',
  accountId: uuid(901),
  personId: uuid(902),
  staffRoles: ['general_manager'],
  sessionId: null,
  actorLabel: 'staff:general_manager',
};

export function metricDefinition(
  metricKey: string,
  name: string,
  overrides: Partial<Schema<'MetricDefinition'>> = {},
): Schema<'MetricDefinition'> {
  return {
    id: uuid(Number(metricKey.slice(4)) + 7000),
    metricKey,
    version: 1,
    name,
    reportKeys: ['daily_schedule'],
    businessQuestion: `Question answered by ${name}`,
    grain: 'activity',
    numerator: `Numerator of ${name}`,
    denominator: 'none',
    timeBasis: 'Scheduled start in facility local time',
    exclusions: ['Canceled activities'],
    dimensions: ['facility', 'space'],
    currency: 'none',
    freshness: 'F1',
    accessScope: 'Operations viewers, facility scope',
    unit: 'count',
    requirementIds: ['SPK-REPORT-002'],
    pendingDecisions: ['DEC-001'],
    definitionHash: 'hash',
    status: 'active',
    recordedAt: NOW_ISO,
    supersededAt: null,
    ...overrides,
  };
}

export function reportResponse(
  key: Schema<'ReportKey'>,
  overrides: Partial<Schema<'ReportResponse'>> = {},
): Schema<'ReportResponse'> {
  return {
    report: {
      key,
      title: 'Daily schedule',
      requirementIds: ['SPK-REPORT-002'],
      accessAction: 'reporting.view_operations_reports',
      exportAction: 'reporting.export_operational',
    },
    runId: null,
    asOf: NOW_ISO,
    producedAt: NOW_ISO,
    scope: {
      facilityId: FACILITY_A,
      timezone: 'America/Los_Angeles',
      from: '2026-10-24',
      to: '2026-10-24',
    },
    parameters: { facilityId: FACILITY_A, date: '2026-10-24', asOf: NOW_ISO },
    freshness: { class: 'F1', pointInTime: 'partial', note: 'Read live from the schedule.' },
    metrics: [
      metricDefinition('MET-001', 'Published activities'),
      metricDefinition('MET-002', 'Changed activities'),
    ],
    disclosures: ['Times are facility local (America/Los_Angeles).'],
    values: [
      {
        metric: 'MET-001',
        label: 'Published activities',
        value: 12,
        unit: 'count',
        currency: null,
        dimensions: {},
        unavailableReason: null,
      },
      {
        metric: 'MET-002',
        label: 'Changed activities',
        value: null,
        unit: 'count',
        currency: null,
        dimensions: {},
        unavailableReason: 'change history is not captured yet',
      },
    ],
    columns: [
      { key: 'space', label: 'Space', type: 'text' },
      { key: 'activities', label: 'Activities', type: 'count' },
      { key: 'firstStart', label: 'First start', type: 'instant' },
    ],
    rows: [{ space: 'Space A', activities: 12, firstStart: '2026-10-24T16:00:00.000Z' }],
    ...overrides,
  };
}

export function runSummary(
  id: string,
  overrides: Partial<Schema<'ReportRunSummary'>> = {},
): Schema<'ReportRunSummary'> {
  return {
    id,
    reportKey: 'daily_schedule',
    facilityId: FACILITY_A,
    parameters: { facilityId: FACILITY_A, date: '2026-10-24', asOf: NOW_ISO },
    asOf: NOW_ISO,
    producedAt: NOW_ISO,
    pointInTime: 'partial',
    accessAction: 'reporting.view_operations_reports',
    requestedBy: actor,
    rowCount: 1,
    resultDigest: 'a'.repeat(64),
    reproducesRunId: null,
    reproductionMatched: null,
    metricDefinitionIds: [uuid(7001)],
    ...overrides,
  };
}

export function reportRun(
  id: string,
  overrides: Partial<Schema<'ReportRun'>> = {},
): Schema<'ReportRun'> {
  return {
    ...runSummary(id),
    result: { ...reportResponse('daily_schedule'), runId: id },
    ...overrides,
  };
}

export function reportExport(
  status: Schema<'ReportExportStatus'>,
  overrides: Partial<Schema<'ReportExport'>> = {},
): Schema<'ReportExport'> {
  return {
    id: EXPORT_1,
    reportRunId: RUN_1,
    reportKey: 'daily_schedule',
    format: 'csv',
    authorizedAction: 'reporting.export_operational',
    status,
    requestedBy: actor,
    requestedAt: NOW_ISO,
    expiresAt: '2026-10-25T12:00:00.000Z',
    rowCount: 1,
    contentDigest: 'b'.repeat(64),
    downloadedAt: status === 'downloaded' ? NOW_ISO : null,
    expiredAt: null,
    revokedAt: status === 'revoked' ? NOW_ISO : null,
    revokeReason: status === 'revoked' ? 'Sent to the wrong person' : null,
    revision: 1,
    ...overrides,
  };
}

export function exportCreated(): Schema<'ReportExportCreated'> {
  return {
    ...reportExport('ready'),
    downloadToken: 'spx_one-time-token-value',
    downloadPath: `/v1/reports/exports/${EXPORT_1}/download`,
  };
}

export const OUTCOMES_ZERO = { created: 0, matched: 0, updated: 0, skipped: 0, exception: 0 };

export function importBatch(
  id: string,
  status: Schema<'ImportBatchStatus'>,
  overrides: Partial<Schema<'ImportBatch'>> = {},
): Schema<'ImportBatch'> {
  return {
    id,
    sourceSystem: 'legacy-registration',
    snapshotTakenAt: '2026-10-20T08:00:00.000Z',
    receivedAt: '2026-10-21T08:00:00.000Z',
    transformationVersion: 'staging-v1.0',
    declaredChecksum: 'c'.repeat(64),
    declaredRowCount: 3,
    checksum: status === 'received' ? null : 'c'.repeat(64),
    rowCount: 3,
    status,
    extraction: { tool: 'extract-script', extractedBy: 'migration operator' },
    controlTotals: {
      counts: { person: 2, open_obligation: 1 },
      amounts: [{ entityType: 'open_obligation', currency: 'USD', totalMinor: 2500 }],
    },
    plannedCounts: status === 'received' ? null : { ...OUTCOMES_ZERO, created: 2, exception: 1 },
    outcomeCounts:
      status === 'applied' ? { ...OUTCOMES_ZERO, created: 2, skipped: 1 } : { ...OUTCOMES_ZERO },
    validationSummary: {},
    exceptions: { open: status === 'validated' ? 1 : 0, decided: 0, withdrawn: 0 },
    sameChecksumBatchIds: [],
    validatedAt: status === 'received' ? null : '2026-10-21T09:00:00.000Z',
    reviewedAt: null,
    applyStartedAt: null,
    appliedAt: status === 'applied' ? '2026-10-22T09:00:00.000Z' : null,
    appliedOperationId: null,
    abortedAt: null,
    abortReason: null,
    submittedBy: actor,
    revision: 2,
    createdAt: '2026-10-21T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
    ...overrides,
  };
}

/** A staged person row whose payload carries child data that the screen must never render. */
export function importRow(
  sequence: number,
  overrides: Partial<Schema<'ImportRow'>> = {},
): Schema<'ImportRow'> {
  return {
    id: uuid(3000 + sequence),
    batchId: BATCH_1,
    sequence,
    entityType: 'person',
    externalId: `P-${sequence}`,
    payload: { givenName: 'Childname', familyName: 'Surname', dateOfBirth: '2016-05-01' },
    payloadHash: 'd'.repeat(64),
    plannedOutcome: 'created',
    outcome: null,
    mappingId: null,
    internalId: null,
    reasons: [],
    appliedAt: null,
    ...overrides,
  };
}

export function importException(
  kind: Schema<'ImportExceptionKind'>,
  overrides: Partial<Schema<'ImportException'>> = {},
): Schema<'ImportException'> {
  return {
    id: uuid(3500),
    batchId: BATCH_1,
    rowId: uuid(3003),
    entityType: kind === 'ambiguous_balance' ? 'open_obligation' : 'relationship_evidence',
    externalId: 'X-3',
    kind,
    phase: 'validation',
    reasons: [{ code: 'NEGATIVE_BALANCE', message: 'The remaining balance is negative.' }],
    reviewOwnerRole: kind === 'ambiguous_balance' ? 'finance_operator' : 'support_operator',
    status: 'open',
    decision: null,
    resolution: null,
    decisionReason: null,
    // Published as `ActorSnapshot & (Record<string, never> | null)`: the null is real at runtime.
    decidedBy: null as unknown as Schema<'ImportException'>['decidedBy'],
    decidedAt: null,
    revision: 4,
    createdAt: '2026-10-21T09:00:00.000Z',
    ...overrides,
  };
}

export function reconciliationReport(
  overrides: Partial<Schema<'MigrationReconciliationReport'>> = {},
): Schema<'MigrationReconciliationReport'> {
  return {
    id: REPORT_1,
    batchId: BATCH_1,
    generatedAt: '2026-10-22T10:00:00.000Z',
    generatedBy: actor,
    status: 'discrepancy',
    levels: [
      { level: 'control_totals', status: 'discrepancy', checked: 3, discrepancyCount: 1 },
      { level: 'record_identity', status: 'balanced', checked: 3, discrepancyCount: 0 },
      { level: 'relationships', status: 'balanced', checked: 0, discrepancyCount: 0 },
      { level: 'operational_outcomes', status: 'balanced', checked: 1, discrepancyCount: 0 },
    ],
    discrepancyCount: 1,
    requiredAreas: ['finance', 'identity'],
    approvalStatus: 'pending',
    approvals: [],
    discrepancies: [
      {
        id: uuid(3600),
        level: 'control_totals',
        area: 'finance',
        entityType: 'open_obligation',
        code: 'AMOUNT_MISMATCH',
        externalId: null,
        internalId: null,
        expected: 2500,
        actual: 2400,
        currency: 'USD',
        differenceMinor: -100,
        countDifference: null,
        details: {},
      },
    ],
    supersededByReportId: null,
    revision: 1,
    ...overrides,
  };
}

export function staffMembership(
  overrides: Partial<Schema<'StaffMembership'>> = {},
): Schema<'StaffMembership'> {
  return {
    id: MEMBERSHIP_1,
    personId: PERSON_1,
    roles: ['scheduler'],
    facilityIds: [FACILITY_A],
    status: 'active',
    effectiveFrom: NOW_ISO,
    effectiveTo: null,
    revision: 1,
    createdAt: NOW_ISO,
    ...overrides,
  };
}

export function policyVersion(
  n: number,
  overrides: Partial<Schema<'PolicyVersion'>> = {},
): Schema<'PolicyVersion'> {
  return {
    id: uuid(8000 + n),
    kind: 'refund',
    key: `refund-terms-${n}`,
    version: n,
    title: `Refund terms ${n}`,
    content: {},
    effectiveFrom: '2026-09-01T07:00:00.000Z',
    effectiveTo: null,
    approvalStatus: 'approved',
    approvedAt: '2026-08-30T07:00:00.000Z',
    retiredAt: null,
    retiredReason: null,
    revision: 2,
    createdAt: '2026-08-20T07:00:00.000Z',
    updatedAt: '2026-08-30T07:00:00.000Z',
    ...overrides,
  };
}

export const ok = (body: unknown) => ({ status: 200, body });
export const created = (body: unknown) => ({ status: 201, body });
export const page = (items: unknown[], nextCursor: string | null = null) =>
  ok({ items, nextCursor });
