import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Facilities API contract, the field crew's daily pitch preparation (migration 0975; SPK-FAC-001,
 * SPK-UX-006, SPK-READY-001 field readiness; staff redesign Phase 8 "Field crew · Fields").
 *
 * Before a pitch's first use of the facility-local day the crew ticks a fixed checklist and marks
 * the pitch ready. Today's "Field ✓" readiness check reads these records; a pitch not ready close
 * to its first use is the manager's issue. Unticking an item of a ready pitch reopens it.
 */

/** The checklist, in the order the crew walks it. */
export const FIELD_PREPARATION_ITEMS = ['lines', 'goals_anchored', 'nets', 'corner_flags'] as const;
export const FieldPreparationItemSchema = z
  .enum(FIELD_PREPARATION_ITEMS)
  .openapi('FieldPreparationItem');
export type FieldPreparationItem = z.infer<typeof FieldPreparationItemSchema>;

export const FieldPreparationStatusSchema = z
  .enum(['in_progress', 'ready'])
  .openapi('FieldPreparationStatus');
export type FieldPreparationStatus = z.infer<typeof FieldPreparationStatusSchema>;

/** A facility-local calendar date, `YYYY-MM-DD`. */
const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');

export const FieldPreparationSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    resourceId: z.uuid(),
    /** The facility-local day the preparation is for (SPK-SCHED-008). */
    date: LocalDay,
    checkedItems: z.array(FieldPreparationItemSchema),
    status: FieldPreparationStatusSchema,
    readyAt: Instant.nullable(),
    readyBy: ActorSnapshotSchema.nullable(),
    updatedBy: ActorSnapshotSchema,
    revision: Revision,
    updatedAt: Instant,
  })
  .openapi('FieldPreparation');
export type FieldPreparation = z.infer<typeof FieldPreparationSchema>;

export const ListFieldPreparationsQuery = z.object({
  facilityId: z.uuid(),
  /** Defaults to today in the facility's time zone. */
  date: LocalDay.optional(),
});
export type ListFieldPreparationsQuery = z.infer<typeof ListFieldPreparationsQuery>;

export const FieldPreparationDaySchema = z
  .object({
    facilityId: z.uuid(),
    date: LocalDay,
    /** IANA time zone of the facility (SPK-SCHED-008). */
    timezone: z.string(),
    /** The checklist items, in walking order. */
    checklist: z.array(FieldPreparationItemSchema),
    /** Only pitches someone has started preparing; a pitch without a record is not prepared. */
    items: z.array(FieldPreparationSchema),
  })
  .openapi('FieldPreparationDay');
export type FieldPreparationDay = z.infer<typeof FieldPreparationDaySchema>;

/**
 * `POST /v1/field-preparations`: tick or untick the checklist of a pitch for a day (creates the
 * day's record on first use). Unticking an item of a ready pitch reopens it. `expectedRevision`
 * is required once the record exists.
 */
export const RecordFieldPreparationBody = withCommandMeta({
  facilityId: z.uuid(),
  resourceId: z.uuid(),
  date: LocalDay,
  checkedItems: z.array(FieldPreparationItemSchema).max(FIELD_PREPARATION_ITEMS.length),
}).openapi('RecordFieldPreparationRequest');
export type RecordFieldPreparationInput = z.infer<typeof RecordFieldPreparationBody>;

/** `POST /v1/field-preparations/{id}/ready`: every item ticked → ready. */
export const MarkFieldReadyBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('MarkFieldReadyRequest');
export type MarkFieldReadyInput = z.infer<typeof MarkFieldReadyBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Facilities';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

openApiRegistry.registerPath({
  method: 'get',
  path: '/field-preparations',
  summary: "The day's pitch preparations of a facility (field crew checklist, SPK-READY-001)",
  tags: [TAG],
  request: { query: ListFieldPreparationsQuery },
  responses: {
    200: ok('Result', FieldPreparationDaySchema),
    403: err('Access denied'),
    404: err('Not found or not visible'),
  },
});
openApiRegistry.registerPath({
  method: 'post',
  path: '/field-preparations',
  summary: "Tick or untick a pitch's preparation checklist for a day (SPK-FAC-001)",
  tags: [TAG],
  request: {
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: RecordFieldPreparationBody } } },
  },
  responses: {
    200: ok('Command outcome', FieldPreparationSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
    404: err('Not found or not visible'),
    409: err('Conflict (STALE_REVISION, IDEMPOTENCY_*)'),
  },
});
openApiRegistry.registerPath({
  method: 'post',
  path: '/field-preparations/{id}/ready',
  summary: 'Mark a pitch ready for the day: every checklist item ticked (SPK-READY-001)',
  tags: [TAG],
  request: {
    params: IdParams,
    headers: idempotencyHeader,
    body: { content: { 'application/json': { schema: MarkFieldReadyBody } } },
  },
  responses: {
    200: ok('Command outcome', FieldPreparationSchema),
    400: err('Validation failed'),
    403: err('Access denied'),
    404: err('Not found or not visible'),
    409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    422: err('Eligibility failed (a checklist item is not ticked)'),
  },
});
