import { z } from '../zod';
import { OperationSchema, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';

export const OperationResponse = OperationSchema.openapi('Operation');

openApiRegistry.registerPath({
  method: 'get',
  path: '/operations/{id}',
  summary: 'Read an authorized asynchronous outcome',
  tags: ['Operations'],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Operation state',
      content: { 'application/json': { schema: OperationResponse } },
    },
    404: {
      description: 'Not found or not visible',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const HealthResponse = z
  .object({ status: z.literal('ok'), version: z.string(), database: z.enum(['ok', 'unavailable']) })
  .openapi('Health');

openApiRegistry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Liveness and dependency status',
  tags: ['Operations'],
  security: [],
  responses: {
    200: {
      description: 'Service health',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
});

/** Backlog of a durable queue (§4.12, §5.11 "worker age and retries"). */
const QueueReadinessSchema = z.object({
  /** Events due now and not yet processed. */
  due: z.number().int().min(0),
  dead: z.number().int().min(0),
  /** Age of the oldest due event, in seconds; null when nothing is due. */
  oldestDueSeconds: z.number().int().min(0).nullable(),
});

export const ReadyResponse = z
  .object({
    /**
     * `ready`: serve traffic. `degraded`: serve traffic, but background work is behind (an
     * operator signal, not a reason to stop routing). `not_ready`: do not route traffic here.
     */
    status: z.enum(['ready', 'degraded', 'not_ready']),
    version: z.string(),
    database: z.enum(['ok', 'unavailable']),
    /** The database schema against this build's migrations (§4.1, §5.8); null when unreadable. */
    migrations: z
      .object({
        current: z.boolean(),
        applied: z.number().int().min(0),
        pending: z.number().int().min(0),
        mismatched: z.number().int().min(0),
        missingOnDisk: z.number().int().min(0),
      })
      .nullable(),
    outbox: QueueReadinessSchema.nullable(),
    inbox: QueueReadinessSchema.nullable(),
    /** The last periodic job any worker finished successfully (§4.12); null when none ran yet. */
    worker: z
      .object({
        lastSucceededAt: z.iso.datetime().nullable(),
        secondsSinceSuccess: z.number().int().min(0).nullable(),
      })
      .nullable(),
    /** True once the process received its stop signal and is finishing requests in flight. */
    draining: z.boolean(),
    /** Why the status is not `ready`. */
    reasons: z.array(z.string()),
  })
  .openapi('Readiness');
export type ReadyResponseValue = z.infer<typeof ReadyResponse>;

openApiRegistry.registerPath({
  method: 'get',
  path: '/ready',
  summary:
    'Deployment readiness: database, schema against this build, queue backlog, worker activity (§5.11)',
  tags: ['Operations'],
  security: [],
  responses: {
    200: {
      description: 'Ready (or degraded: serving, background work behind)',
      content: { 'application/json': { schema: ReadyResponse } },
    },
    503: {
      description:
        'Not ready: database unavailable, schema not current for this build, or draining',
      content: { 'application/json': { schema: ReadyResponse } },
    },
  },
});

// ---------------------------------------------------------------------------------------------
// Operational signals (§5.11)
// ---------------------------------------------------------------------------------------------

const MetricsQueueSchema = z.object({
  due: z.number().int().min(0),
  dead: z.number().int().min(0),
  waitingForHandler: z.number().int().min(0),
  oldestDueSeconds: z.number().int().min(0).nullable(),
});

export const MetricsSnapshotSchema = z
  .object({
    takenAt: z.iso.datetime(),
    /** `organization` for the managers' read; `global` (all organizations, counts only) for a scraper. */
    scope: z.enum(['organization', 'global']),
    outbox: MetricsQueueSchema,
    inbox: MetricsQueueSchema,
    periodicJobs: z.array(
      z.object({
        name: z.string(),
        lastSucceededAt: z.iso.datetime().nullable(),
        secondsSinceSuccess: z.number().int().min(0).nullable(),
        consecutiveFailures: z.number().int().min(0),
      }),
    ),
    failedHandlerAttemptsLastHour: z.number().int().min(0),
    openExceptions: z.array(
      z.object({
        category: z.string(),
        severity: z.string(),
        ownerQueue: z.string(),
        count: z.number().int().min(1),
      }),
    ),
  })
  .openapi('MetricsSnapshot');
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

openApiRegistry.registerPath({
  method: 'get',
  path: '/admin/metrics',
  summary:
    "The organization's operational signals: queue backlog, dead letters, job health, open exceptions (core.view_metrics, §5.11)",
  tags: ['Operations'],
  responses: {
    200: {
      description: 'Signal snapshot',
      content: { 'application/json': { schema: MetricsSnapshotSchema } },
    },
    403: {
      description: 'Access denied',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/metrics',
  summary:
    'Global operational signals in Prometheus text for an infrastructure scraper (X-Metrics-Token; absent unless METRICS_TOKEN is configured)',
  tags: ['Operations'],
  security: [],
  request: { headers: z.object({ 'x-metrics-token': z.string() }) },
  responses: {
    200: {
      description: 'Prometheus text exposition',
      content: { 'text/plain': { schema: z.string() } },
    },
    401: {
      description: 'Missing or wrong metrics token',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Metrics scraping is not configured',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// ---------------------------------------------------------------------------------------------
// Recovery after a restore (§5.8, SPK-AT-028)
// ---------------------------------------------------------------------------------------------

/** Something that must be reconciled before normal operation resumes after a restore. */
export const RecoveryBlockerSchema = z
  .object({
    check: z.string(),
    code: z.string(),
    message: z.string(),
    count: z.number().int().min(0).optional(),
  })
  .openapi('RecoveryBlocker');
export type RecoveryBlocker = z.infer<typeof RecoveryBlockerSchema>;

export const RecoveryStatusSchema = z
  .object({
    /** True while consequential financial commands are refused and no new charge is started. */
    active: z.boolean(),
    restoreReference: z.string().nullable(),
    enteredAt: z.iso.datetime().nullable(),
    /** The `reliability.recovery_mode` operational exception that records the recovery. */
    exceptionId: z.uuid().nullable(),
    /** What still blocks resuming normal operation (empty when it may resume). */
    blockers: z.array(RecoveryBlockerSchema),
  })
  .openapi('RecoveryStatus');
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;

export const ResumeAfterRecoveryBody = withCommandMeta({})
  .extend({ reason: z.string().trim().min(1).max(2000) })
  .openapi('ResumeAfterRecoveryRequest');
export type ResumeAfterRecoveryInput = z.infer<typeof ResumeAfterRecoveryBody>;

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

openApiRegistry.registerPath({
  method: 'get',
  path: '/recovery',
  summary:
    'Recovery mode after a restore: whether it is active and what still blocks resuming (§5.8, SPK-AT-028)',
  tags: ['Operations'],
  responses: {
    200: {
      description: 'Recovery status for the organization',
      content: { 'application/json': { schema: RecoveryStatusSchema } },
    },
    403: errorResponse('Access denied'),
  },
});

openApiRegistry.registerPath({
  method: 'post',
  path: '/recovery/resume',
  summary:
    'Resume normal operation after a restore once provider facts are reconciled (general manager; §5.8, SPK-AT-028)',
  tags: ['Operations'],
  request: {
    headers: z.object({ 'Idempotency-Key': z.string().min(8).max(128) }),
    body: { content: { 'application/json': { schema: ResumeAfterRecoveryBody } } },
  },
  responses: {
    200: {
      description: 'Normal operation resumed',
      content: { 'application/json': { schema: RecoveryStatusSchema } },
    },
    400: errorResponse('Validation failed'),
    403: errorResponse('Access denied'),
    409: errorResponse(
      'Not in recovery mode (INVALID_TRANSITION), or provider facts not reconciled yet (RESOURCE_CONFLICT, details.code recovery_reconciliation_incomplete, details.blockers)',
    ),
  },
});
