import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';
import { LocalDate } from './scheduling';

/**
 * Reporting module API contract (specification §3.20 SPK-REPORT-001..007, §4.4 Reporting, §1.2
 * success measures, §4.14 "Expiring exports"; docs/package-a/metric-dictionary.md).
 *
 * Every report answers with the same envelope (`ReportResponse`): the metric definitions it
 * reports with every SPK-REPORT-001 field, the as-of instant, freshness, the disclosures a reader
 * needs (time basis, weighting, allocation method, exclusions), the metric values and an aggregate
 * table (columns and rows). Rows never carry a person's name or contact detail; person-level
 * drill-down is not offered by this module (metric dictionary rule G9). A metric whose inputs are
 * not agreed or not captured is reported with a null value and the reason, never as zero (G13).
 * Organization scope always comes from the authenticated principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const REPORT_KEYS = [
  'daily_schedule',
  'expected_arrivals',
  'attendance',
  'match_readiness',
  'uncovered_assignments',
  'waitlist_demand',
  'registration_funnel',
  'enrollment_completeness',
  'outstanding_obligations',
  'payment_reconciliation',
  'maintenance_restrictions',
  'communication_failures',
  'utilization',
  'economics',
  'retention',
  'demand',
] as const;
export const ReportKeySchema = z.enum(REPORT_KEYS).openapi('ReportKey');
export type ReportKey = z.infer<typeof ReportKeySchema>;

export const MetricUnitSchema = z
  .enum(['count', 'hours', 'ratio', 'minor_units', 'minutes'])
  .openapi('ReportingMetricUnit');
export type MetricUnitValue = z.infer<typeof MetricUnitSchema>;

/** F1 live read, F2 event-derived, F3 snapshot (metric dictionary section 3.2). */
export const FreshnessClassSchema = z.enum(['F1', 'F2', 'F3']).openapi('ReportingFreshnessClass');
export type FreshnessClass = z.infer<typeof FreshnessClassSchema>;

/**
 * How far a rerun with the same as-of instant can recompute the same figures from source records:
 * `full` (every input is an append-only, clock-stamped fact), `partial` (some inputs are current
 * state; the stored run is the reproducible record), `none` (evaluated live only).
 */
export const PointInTimeSchema = z
  .enum(['full', 'partial', 'none'])
  .openapi('ReportingPointInTime');
export type PointInTime = z.infer<typeof PointInTimeSchema>;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Query-string or JSON boolean. */
const QueryBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

// ---------------------------------------------------------------------------------------------
// Metric definitions (SPK-REPORT-001)
// ---------------------------------------------------------------------------------------------

export const MetricDefinitionSchema = z
  .object({
    id: z.uuid(),
    metricKey: z.string().regex(/^MET-\d{3}$/),
    version: z.number().int().min(1),
    name: z.string(),
    reportKeys: z.array(ReportKeySchema),
    businessQuestion: z.string(),
    grain: z.string(),
    numerator: z.string(),
    denominator: z.string(),
    timeBasis: z.string(),
    exclusions: z.array(z.string()),
    dimensions: z.array(z.string()),
    currency: z.enum(['none', 'minor_units']),
    freshness: FreshnessClassSchema,
    accessScope: z.string(),
    unit: MetricUnitSchema,
    requirementIds: z.array(z.string()),
    pendingDecisions: z.array(z.string()),
    definitionHash: z.string(),
    status: z.enum(['active', 'superseded']),
    recordedAt: Instant,
    supersededAt: Instant.nullable(),
  })
  .openapi('MetricDefinition');
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export const ListMetricDefinitionsQuery = z.object({ report: ReportKeySchema.optional() });
export type ListMetricDefinitionsQuery = z.infer<typeof ListMetricDefinitionsQuery>;

export const MetricDefinitionListSchema = z
  .object({ items: z.array(MetricDefinitionSchema) })
  .openapi('MetricDefinitionList');

export const MetricDefinitionHistorySchema = z
  .object({ active: MetricDefinitionSchema, versions: z.array(MetricDefinitionSchema) })
  .openapi('MetricDefinitionHistory');
export type MetricDefinitionHistory = z.infer<typeof MetricDefinitionHistorySchema>;

// ---------------------------------------------------------------------------------------------
// Report envelope
// ---------------------------------------------------------------------------------------------

export const MetricValueSchema = z
  .object({
    metric: z.string(),
    label: z.string(),
    /** Null means unavailable (never zero, rule G13); the reason says why. */
    value: z.number().nullable(),
    unit: MetricUnitSchema,
    /** Money values carry their currency; totals are never mixed across currencies (G5). */
    currency: CurrencyCode.nullable(),
    dimensions: z.record(z.string(), z.string()),
    unavailableReason: z.string().nullable(),
  })
  .openapi('ReportMetricValue');
export type MetricValue = z.infer<typeof MetricValueSchema>;

export const ReportColumnSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum([
      'text',
      'id',
      'date',
      'instant',
      'count',
      'hours',
      'ratio',
      'minor_units',
      'minutes',
      'boolean',
    ]),
  })
  .openapi('ReportColumn');
export type ReportColumn = z.infer<typeof ReportColumnSchema>;

export const ReportRowSchema = z.record(z.string(), Scalar).openapi('ReportRow');
export type ReportRow = z.infer<typeof ReportRowSchema>;

export const ReportResponseSchema = z
  .object({
    report: z.object({
      key: ReportKeySchema,
      title: z.string(),
      requirementIds: z.array(z.string()),
      accessAction: z.string(),
      exportAction: z.string(),
    }),
    /** Set when the evaluation is a stored report run (POST /reports/runs). */
    runId: z.uuid().nullable(),
    asOf: Instant,
    producedAt: Instant,
    scope: z.object({
      facilityId: z.uuid().nullable(),
      timezone: z.string().nullable(),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
    parameters: z.record(z.string(), z.unknown()),
    freshness: z.object({
      class: FreshnessClassSchema,
      pointInTime: PointInTimeSchema,
      note: z.string(),
    }),
    metrics: z.array(MetricDefinitionSchema),
    disclosures: z.array(z.string()),
    values: z.array(MetricValueSchema),
    columns: z.array(ReportColumnSchema),
    rows: z.array(ReportRowSchema),
  })
  .openapi('ReportResponse');
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Report parameters (query string for GET /reports/*, `parameters` of POST /reports/runs)
// ---------------------------------------------------------------------------------------------

const AsOf = Instant.optional().openapi({
  description:
    'Evaluate as of this instant (default now; never in the future). Corrections recorded later do not change the figures (SPK-REPORT-007).',
});
const FacilityParam = z.uuid();
const DateRange = { from: LocalDate, to: LocalDate };
const InstantRange = { periodStart: Instant, periodEnd: Instant };

export const DailyScheduleReportQuery = z.object({
  facilityId: FacilityParam,
  date: LocalDate,
  asOf: AsOf,
});
export const ExpectedArrivalsReportQuery = z.object({
  facilityId: FacilityParam,
  date: LocalDate,
  asOf: AsOf,
});
export const AttendanceReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
});
export const MatchReadinessReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
});
export const UncoveredAssignmentsReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
});
export const WaitlistDemandReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
});
export const RegistrationFunnelReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
});
export const EnrollmentCompletenessReportQuery = z.object({
  facilityId: FacilityParam,
  asOf: AsOf,
});
export const OutstandingObligationsReportQuery = z.object({ asOf: AsOf });
export const PaymentReconciliationReportQuery = z.object({ ...InstantRange, asOf: AsOf });
export const MaintenanceRestrictionsReportQuery = z.object({
  facilityId: FacilityParam,
  asOf: AsOf,
});
export const CommunicationFailuresReportQuery = z.object({ ...InstantRange, asOf: AsOf });

export const UtilizationWeightingSchema = z
  .enum(['conflict_units', 'custom'])
  .openapi('UtilizationWeighting');
export const UtilizationReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
  /** U5: reserved time includes setup and cleanup buffers unless set to false. */
  includeBuffers: QueryBoolean.optional(),
  /** U3: resource-equivalent weighting; the default weighs a space by its conflict units. */
  weighting: UtilizationWeightingSchema.optional(),
  /** For `custom`: `resourceId:weight` pairs separated by commas (whole spaces only). */
  weights: z.string().max(4000).optional(),
});

export const EconomicsAllocationMethodSchema = z
  .enum(['direct', 'pro_rata'])
  .openapi('EconomicsAllocationMethod');
export type EconomicsAllocationMethod = z.infer<typeof EconomicsAllocationMethodSchema>;
export const EconomicsReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
  /** SPK-REPORT-004: required — no per-field-hour figure is shown without a named method. */
  allocationMethod: EconomicsAllocationMethodSchema,
  /** SPK-REPORT-004: contribution margin is refused unless agreed cost inputs cover the scope. */
  includeMargin: QueryBoolean.optional(),
});

export const RetentionCohortSchema = z
  .enum([
    'adult_teams',
    'individual_players',
    'youth_participants',
    'households',
    'rental_customers',
  ])
  .openapi('RetentionCohort');
export type RetentionCohort = z.infer<typeof RetentionCohortSchema>;
export const RetentionReportQuery = z.object({
  cohort: RetentionCohortSchema,
  asOf: AsOf,
  /** Adult teams and individual players: the anchor season and the comparable next season (K2). */
  anchorSeasonId: z.uuid().optional(),
  comparisonSeasonId: z.uuid().optional(),
  /** Youth, households, rental customers: offering start dates of the anchor and comparison periods. */
  anchorFrom: LocalDate.optional(),
  anchorTo: LocalDate.optional(),
  comparisonFrom: LocalDate.optional(),
  comparisonTo: LocalDate.optional(),
  programId: z.uuid().optional(),
  /** K4: members who could not return are excluded from the denominator only when asked. */
  excludeNotOffered: QueryBoolean.optional(),
});

export const DemandForecastMethodSchema = z
  .enum(['none', 'trailing_mean'])
  .openapi('DemandForecastMethod');
export const DemandReportQuery = z.object({
  facilityId: FacilityParam,
  ...DateRange,
  asOf: AsOf,
  /** SPK-REPORT-006: a forecast is a separate series that names its method and inputs. */
  forecastMethod: DemandForecastMethodSchema.optional(),
  forecastPeriods: z.coerce.number().int().min(1).max(12).optional(),
});

/** Parameter schema of each report (the same object as its GET query string). */
export const REPORT_QUERY_SCHEMAS = {
  daily_schedule: DailyScheduleReportQuery,
  expected_arrivals: ExpectedArrivalsReportQuery,
  attendance: AttendanceReportQuery,
  match_readiness: MatchReadinessReportQuery,
  uncovered_assignments: UncoveredAssignmentsReportQuery,
  waitlist_demand: WaitlistDemandReportQuery,
  registration_funnel: RegistrationFunnelReportQuery,
  enrollment_completeness: EnrollmentCompletenessReportQuery,
  outstanding_obligations: OutstandingObligationsReportQuery,
  payment_reconciliation: PaymentReconciliationReportQuery,
  maintenance_restrictions: MaintenanceRestrictionsReportQuery,
  communication_failures: CommunicationFailuresReportQuery,
  utilization: UtilizationReportQuery,
  economics: EconomicsReportQuery,
  retention: RetentionReportQuery,
  demand: DemandReportQuery,
} as const satisfies Record<ReportKey, z.ZodType>;
export type ReportParameters<K extends ReportKey> = z.infer<(typeof REPORT_QUERY_SCHEMAS)[K]>;

/** URL segment of each report under /reports. */
export const REPORT_PATHS: Readonly<Record<ReportKey, string>> = {
  daily_schedule: 'daily-schedule',
  expected_arrivals: 'expected-arrivals',
  attendance: 'attendance',
  match_readiness: 'match-readiness',
  uncovered_assignments: 'uncovered-assignments',
  waitlist_demand: 'waitlist-demand',
  registration_funnel: 'registration-funnel',
  enrollment_completeness: 'enrollment-completeness',
  outstanding_obligations: 'outstanding-obligations',
  payment_reconciliation: 'payment-reconciliation',
  maintenance_restrictions: 'maintenance-restrictions',
  communication_failures: 'communication-failures',
  utilization: 'utilization',
  economics: 'economics',
  retention: 'retention',
  demand: 'demand',
};

// ---------------------------------------------------------------------------------------------
// Report runs (SPK-REPORT-007)
// ---------------------------------------------------------------------------------------------

export const CreateReportRunBody = withCommandMeta({
  report: ReportKeySchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
}).openapi('CreateReportRunRequest');
export type CreateReportRunInput = z.infer<typeof CreateReportRunBody>;

export const ReproduceReportRunBody = withCommandMeta({}).openapi('ReproduceReportRunRequest');
export type ReproduceReportRunInput = z.infer<typeof ReproduceReportRunBody>;

export const ReportRunSummarySchema = z
  .object({
    id: z.uuid(),
    reportKey: ReportKeySchema,
    facilityId: z.uuid().nullable(),
    parameters: z.record(z.string(), z.unknown()),
    asOf: Instant,
    producedAt: Instant,
    pointInTime: PointInTimeSchema,
    accessAction: z.string(),
    requestedBy: ActorSnapshotSchema,
    rowCount: z.number().int(),
    resultDigest: z.string(),
    reproducesRunId: z.uuid().nullable(),
    reproductionMatched: z.boolean().nullable(),
    metricDefinitionIds: z.array(z.uuid()),
  })
  .openapi('ReportRunSummary');
export type ReportRunSummary = z.infer<typeof ReportRunSummarySchema>;

export const ReportRunSchema = ReportRunSummarySchema.extend({
  result: ReportResponseSchema,
}).openapi('ReportRun');
export type ReportRun = z.infer<typeof ReportRunSchema>;

export const ListReportRunsQuery = PageRequestSchema.extend({
  report: ReportKeySchema.optional(),
});
export type ListReportRunsQuery = z.infer<typeof ListReportRunsQuery>;

export const ReportReproductionSchema = z
  .object({
    originalRunId: z.uuid(),
    originalDigest: z.string(),
    reproducedDigest: z.string(),
    matched: z.boolean(),
    explanation: z.string(),
    reproducedRun: ReportRunSchema,
  })
  .openapi('ReportReproduction');
export type ReportReproduction = z.infer<typeof ReportReproductionSchema>;

// ---------------------------------------------------------------------------------------------
// Exports (SPK-REPORT-007, §4.14)
// ---------------------------------------------------------------------------------------------

export const EXPORT_TOKEN_HEADER = 'x-export-token';

export const ExportFormatSchema = z.enum(['csv', 'json']).openapi('ReportExportFormat');
export type ReportExportFormat = z.infer<typeof ExportFormatSchema>;
export const ExportStatusSchema = z
  .enum(['ready', 'downloaded', 'expired', 'revoked'])
  .openapi('ReportExportStatus');
export type ReportExportStatus = z.infer<typeof ExportStatusSchema>;

export const CreateExportBody = withCommandMeta({
  reportRunId: z.uuid(),
  format: ExportFormatSchema,
}).openapi('CreateReportExportRequest');
export type CreateExportInput = z.infer<typeof CreateExportBody>;

export const RevokeExportBody = withCommandMeta({})
  .extend({ reason: z.string().min(1).max(2000) })
  .openapi('RevokeReportExportRequest');
export type RevokeExportInput = z.infer<typeof RevokeExportBody>;

export const ReportExportSchema = z
  .object({
    id: z.uuid(),
    reportRunId: z.uuid(),
    reportKey: ReportKeySchema,
    format: ExportFormatSchema,
    authorizedAction: z.enum(['reporting.export_operational', 'reporting.export_financial']),
    status: ExportStatusSchema,
    requestedBy: ActorSnapshotSchema,
    requestedAt: Instant,
    expiresAt: Instant,
    rowCount: z.number().int(),
    contentDigest: z.string(),
    downloadedAt: Instant.nullable(),
    expiredAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
    revokeReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('ReportExport');
export type ReportExport = z.infer<typeof ReportExportSchema>;

export const ReportExportCreatedSchema = ReportExportSchema.extend({
  /** Returned once; only its SHA-256 is stored. Send it as `X-Export-Token` on the download. */
  downloadToken: z.string(),
  downloadPath: z.string(),
}).openapi('ReportExportCreated');
export type ReportExportCreated = z.infer<typeof ReportExportCreatedSchema>;

// ---------------------------------------------------------------------------------------------
// Agreed cost inputs (SPK-REPORT-004, metric dictionary rule E4, DEC-085)
// ---------------------------------------------------------------------------------------------

export const RecordCostInputBody = withCommandMeta({
  facilityId: z.uuid(),
  resourceId: z.uuid().nullable().optional(),
  basis: z.literal('per_activity_hour'),
  amountMinor: z.number().int().safe().min(0),
  currency: CurrencyCode,
  effectiveFrom: LocalDate,
  effectiveTo: LocalDate.nullable().optional(),
  description: z.string().min(1).max(500),
  /** The agreement this input comes from (for example the Finance decision record). */
  approvalReference: z.string().min(1).max(200),
}).openapi('RecordCostInputRequest');
export type RecordCostInputInput = z.infer<typeof RecordCostInputBody>;

export const WithdrawCostInputBody = withCommandMeta({})
  .extend({ reason: z.string().min(1).max(2000), expectedRevision: Revision })
  .openapi('WithdrawCostInputRequest');
export type WithdrawCostInputInput = z.infer<typeof WithdrawCostInputBody>;

export const CostInputSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid().nullable(),
    basis: z.literal('per_activity_hour'),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    effectiveFrom: LocalDate,
    effectiveTo: LocalDate.nullable(),
    description: z.string(),
    approvalReference: z.string(),
    approvedBy: ActorSnapshotSchema,
    recordedAt: Instant,
    status: z.enum(['active', 'withdrawn']),
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
    revision: Revision,
  })
  .openapi('CostInput');
export type CostInput = z.infer<typeof CostInputSchema>;

export const ListCostInputsQuery = z.object({
  facilityId: z.uuid().optional(),
  includeWithdrawn: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type ListCostInputsQuery = z.infer<typeof ListCostInputsQuery>;

export const CostInputListSchema = z
  .object({ items: z.array(CostInputSchema) })
  .openapi('CostInputList');

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

const TAG = 'Reporting';
const IdParams = z.object({ id: z.uuid() });
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed (including a missing allocation method or cost inputs)'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

const REPORT_SUMMARIES: Readonly<Record<ReportKey, string>> = {
  daily_schedule: 'Daily schedule: published, changed and unpublished activities (SPK-REPORT-002)',
  expected_arrivals:
    'Expected arrivals by activity, including supervised releases expected (SPK-REPORT-002)',
  attendance:
    'Attendance after corrections, attendance rate, facility arrivals and check-ins side by side (SPK-REPORT-002)',
  match_readiness: 'Match readiness of upcoming fixtures by issue class (SPK-REPORT-002)',
  uncovered_assignments:
    'Required official and coach slots without an accepted assignment (SPK-REPORT-002)',
  waitlist_demand: 'Waitlist depth, outstanding offers and offer acceptance (SPK-REPORT-002)',
  registration_funnel: 'Registration funnel stages and conversion (SPK-REPORT-002)',
  enrollment_completeness:
    'Enrollment fill, roster completeness and outstanding required forms (SPK-REPORT-002)',
  outstanding_obligations:
    'Outstanding balances by aging band, overdue installments, credits (SPK-REPORT-002)',
  payment_reconciliation:
    'Payment and refund attempts by state, unknown outcomes, settlement variance, receipts beside sales (SPK-REPORT-002)',
  maintenance_restrictions:
    'Active restrictions, overdue maintenance and spaces awaiting release (SPK-REPORT-002)',
  communication_failures:
    'Delivery attempts by state, failed essential notices, withheld notices (SPK-REPORT-002)',
  utilization:
    'Field utilization: reserved, available, observed and closed hours by conflict unit without double counting; disclosed weighting (SPK-REPORT-003)',
  economics:
    'Allocated sales per activity hour under an explicit allocation method; margin only with agreed cost inputs (SPK-REPORT-004)',
  retention:
    'Renewal by cohort: adult teams, individual players, youth participants, households, rental customers (SPK-REPORT-005)',
  demand:
    'Observed demand by day, time, age band, format and program, with any forecast in its own series (SPK-REPORT-006)',
};

for (const key of REPORT_KEYS) {
  query(
    `/reports/${REPORT_PATHS[key]}`,
    REPORT_SUMMARIES[key],
    REPORT_QUERY_SCHEMAS[key] as unknown as z.ZodObject<z.ZodRawShape>,
    ReportResponseSchema,
  );
}

query(
  '/reports/metric-definitions',
  'List the active metric definitions with every SPK-REPORT-001 field',
  ListMetricDefinitionsQuery,
  MetricDefinitionListSchema,
);
openApiRegistry.registerPath({
  method: 'get',
  path: '/reports/metric-definitions/{key}',
  summary: 'Read a metric definition and its earlier versions',
  tags: [TAG],
  request: { params: z.object({ key: z.string().regex(/^MET-\d{3}$/) }) },
  responses: {
    200: ok('Definition history', MetricDefinitionHistorySchema),
    404: err('Not found'),
  },
});

command(
  '/reports/runs',
  'Evaluate a report and store the run (definitions, parameters, actor, as-of, result digest) for reproduction and export',
  CreateReportRunBody,
  ReportRunSchema,
);
query(
  '/reports/runs',
  'List stored report runs the caller may view',
  ListReportRunsQuery,
  pageSchema(ReportRunSummarySchema),
);
query('/reports/runs/{id}', 'Read a stored report run exactly as produced', null, ReportRunSchema);
command(
  '/reports/runs/{id}/reproduce',
  'Re-evaluate a stored run at its as-of instant and compare digests (SPK-REPORT-007)',
  ReproduceReportRunBody,
  ReportReproductionSchema,
);

command(
  '/reports/exports',
  'Create an expiring, single-use export of a stored run (independent export permission, audited)',
  CreateExportBody,
  ReportExportCreatedSchema,
);
query('/reports/exports/{id}', 'Read an export you requested', null, ReportExportSchema);
openApiRegistry.registerPath({
  method: 'get',
  path: '/reports/exports/{id}/download',
  summary:
    'Download an export once, before it expires (requester only; export permission re-checked; audited)',
  tags: [TAG],
  request: {
    params: IdParams,
    headers: z.object({ 'X-Export-Token': z.string().min(16).max(200) }),
  },
  responses: {
    200: {
      description: 'The export content (CSV or JSON)',
      content: {
        'text/csv': { schema: z.string() },
        'application/json': { schema: z.record(z.string(), z.unknown()) },
      },
    },
    403: err('Export permission no longer held'),
    404: err('Not found or not visible'),
    409: err('Already downloaded, expired or revoked (INVALID_TRANSITION)'),
  },
});
command(
  '/reports/exports/{id}/revoke',
  'Revoke an export before it is downloaded',
  RevokeExportBody,
  ReportExportSchema,
  200,
);

command(
  '/reports/cost-inputs',
  'Record an agreed direct cost input (per activity hour) for contribution margin',
  RecordCostInputBody,
  CostInputSchema,
);
query('/reports/cost-inputs', 'List agreed cost inputs', ListCostInputsQuery, CostInputListSchema);
command(
  '/reports/cost-inputs/{id}/withdraw',
  'Withdraw an agreed cost input (expected revision required)',
  WithdrawCostInputBody,
  CostInputSchema,
  200,
);
