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
