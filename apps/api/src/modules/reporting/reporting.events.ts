import { defineEvent, Instant, z } from '@sportspark/contracts';

/**
 * Reporting domain events (§4.12 transactional outbox). Payloads carry identifiers and instants
 * only — never report rows, parameters that could identify a person, or download tokens.
 */

/** A report evaluation was stored as a run (SPK-REPORT-007). */
export const ReportRunRecorded = defineEvent(
  'reporting.report_run_recorded',
  z.object({
    reportRunId: z.uuid(),
    reportKey: z.string(),
    asOf: Instant,
    rowCount: z.number().int().min(0),
    resultDigest: z.string(),
    reproducesRunId: z.uuid().nullable(),
    reproductionMatched: z.boolean().nullable(),
  }),
);

/** An export of a stored run was authorized and created (SPK-REPORT-007, §4.14). */
export const ExportCreated = defineEvent(
  'reporting.export_created',
  z.object({
    exportId: z.uuid(),
    reportRunId: z.uuid(),
    format: z.enum(['csv', 'json']),
    authorizedAction: z.string(),
    expiresAt: Instant,
  }),
);

/** Timer: delivered at the export's expiry instant; the handler expires a still-ready export. */
export const ExportExpiryDue = defineEvent(
  'reporting.export_expiry_due',
  z.object({ exportId: z.uuid(), expiresAt: Instant }),
);

export const ExportDownloaded = defineEvent(
  'reporting.export_downloaded',
  z.object({ exportId: z.uuid(), reportRunId: z.uuid() }),
);

export const ExportExpired = defineEvent(
  'reporting.export_expired',
  z.object({ exportId: z.uuid(), expiredAt: Instant }),
);

export const ExportRevoked = defineEvent(
  'reporting.export_revoked',
  z.object({ exportId: z.uuid(), revokedAt: Instant }),
);

/** The registry changed a metric definition: a new version superseded the active one. */
export const MetricDefinitionVersioned = defineEvent(
  'reporting.metric_definition_versioned',
  z.object({
    metricKey: z.string(),
    version: z.number().int().min(1),
    metricDefinitionId: z.uuid(),
    supersededDefinitionId: z.uuid().nullable(),
  }),
);

export const CostInputRecorded = defineEvent(
  'reporting.cost_input_recorded',
  z.object({ costInputId: z.uuid(), facilityId: z.uuid(), resourceId: z.uuid().nullable() }),
);

export const CostInputWithdrawn = defineEvent(
  'reporting.cost_input_withdrawn',
  z.object({ costInputId: z.uuid() }),
);
