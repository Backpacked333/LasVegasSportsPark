import { z } from './zod';

/**
 * Command behavior contract (specification §4.9).
 * Consequential commands carry an idempotency key (HTTP header `Idempotency-Key`),
 * an expected revision for sensitive edits, policy references, and a reason for overrides/corrections.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export const IdempotencyKey = z.string().min(8).max(128);
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export const Revision = z.number().int().min(1);

export const CommandMetaSchema = z.object({
  expectedRevision: Revision.optional(),
  reason: z.string().min(1).max(2000).optional(),
  policyReferences: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type CommandMeta = z.infer<typeof CommandMetaSchema>;

/** Mix-in for command bodies: `const Body = withCommandMeta(z.object({...}))`. */
export function withCommandMeta<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, ...CommandMetaSchema.shape });
}

export const OperationStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'recovery_required',
  'compensated',
]);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const OperationSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  status: OperationStatus,
  correlationId: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type Operation = z.infer<typeof OperationSchema>;

/** Standard accepted-response envelope for asynchronous commands. */
export const OperationAcceptedSchema = z.object({
  operationId: z.uuid(),
  status: OperationStatus,
  href: z.string(),
});
export type OperationAccepted = z.infer<typeof OperationAcceptedSchema>;
