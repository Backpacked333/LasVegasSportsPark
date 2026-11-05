import { z } from './zod';

/**
 * Domain event envelope carried through the transactional outbox (specification §4.12).
 * Every event has a stable identity, organization scope, correlation and causation references,
 * and the operation that produced it, so workers can replay without duplicating business effects.
 */
export const DomainEventSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  organizationId: z.uuid(),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  payload: z.unknown(),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  operationId: z.uuid().nullable(),
});
export type DomainEvent<TPayload = unknown> = Omit<z.infer<typeof DomainEventSchema>, 'payload'> & {
  payload: TPayload;
};

/** Typed event definition: `const EnrollmentConfirmed = defineEvent('enrollment.confirmed', z.object({...}))`. */
export interface EventDefinition<TType extends string, TSchema extends z.ZodType> {
  readonly type: TType;
  readonly payload: TSchema;
}

export type EventPayload<TDefinition> =
  TDefinition extends EventDefinition<string, infer TSchema> ? z.infer<TSchema> : never;

export function defineEvent<TType extends string, TSchema extends z.ZodType>(
  type: TType,
  payload: TSchema,
): EventDefinition<TType, TSchema> {
  return { type, payload };
}
