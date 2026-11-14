import { z } from '../zod';
import { withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import {
  AcknowledgmentBasisSchema,
  AcknowledgmentMethodSchema,
  AcknowledgmentSchema,
  AcknowledgmentStatusSchema,
  WaiverEnforcementSchema,
} from './catalog';

/**
 * Liability waivers (SPK-REG-011, proposed amendment PA-01; capability `liability_waivers`,
 * DEC-095). Proposed: every open value of DEC-095 is content of the approved waiver version
 * (`WaiverContentSchema`), never a constant of this contract. A waiver is a policy family of kind
 * `waiver`; an acceptance is an acknowledgment of one of its versions; a requirement names the
 * family by its policy key.
 */

const Reason = z.string().trim().min(1).max(2000);
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Catalog';

export const WaiverPolicyKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, 'lowercase letters, digits, "-" and "_" only');

/** `current`: an acceptance counts under the rule. `lapsed`: one exists but no longer counts. */
export const WaiverStatusValueSchema = z
  .enum(['current', 'lapsed', 'missing'])
  .openapi('WaiverStatusValue');
export type WaiverStatusValue = z.infer<typeof WaiverStatusValueSchema>;

/** Why a waiver is not current; null when it is. */
export const WaiverStatusReasonSchema = z
  .enum(['never_accepted', 'no_version_in_force', 'new_version', 'renewal_due'])
  .openapi('WaiverStatusReason');
export type WaiverStatusReason = z.infer<typeof WaiverStatusReasonSchema>;

export const WaiverVersionRefSchema = z
  .object({
    policyVersionId: z.uuid(),
    version: z.number().int(),
    title: z.string(),
    effectiveFrom: Instant,
  })
  .openapi('WaiverVersionRef');
export type WaiverVersionRef = z.infer<typeof WaiverVersionRefSchema>;

/**
 * One acceptance of a waiver version. A paper acceptance names the staff member who entered it
 * (`recordedByPersonId`) and the date on the paper; `signedAt` is then the instant of the staff
 * entry, never a signature time (SPK-REG-009).
 */
export const WaiverAcceptanceSchema = z
  .object({
    acknowledgmentId: z.uuid(),
    policyVersionId: z.uuid(),
    version: z.number().int(),
    /** The person covered. */
    subjectPersonId: z.uuid(),
    /** The person who accepted: the adult themselves or a guardian. */
    signedByPersonId: z.uuid(),
    basis: AcknowledgmentBasisSchema,
    method: AcknowledgmentMethodSchema,
    signedAt: Instant,
    paperDatedOn: z.iso.date().nullable(),
    recordedByKind: z.enum(['customer', 'staff', 'system']),
    /** The staff member who entered or assisted it; null when the customer acted alone. */
    recordedByPersonId: z.uuid().nullable(),
    /** The instant the renewal rule counts from: the paper date, or the signing time. */
    acceptedAt: Instant,
    status: AcknowledgmentStatusSchema,
    withdrawnAt: Instant.nullable(),
    withdrawnReason: z.string().nullable(),
  })
  .openapi('WaiverAcceptance');
export type WaiverAcceptance = z.infer<typeof WaiverAcceptanceSchema>;

/** The rule of the version in force that the status was judged by. */
export const WaiverRuleSchema = z
  .object({
    reacceptOnNewVersion: z.boolean(),
    renewEveryMonths: z.number().int().nullable(),
    enforcement: WaiverEnforcementSchema,
  })
  .openapi('WaiverRule');
export type WaiverRule = z.infer<typeof WaiverRuleSchema>;

/** The evaluation of one person against one waiver family at one instant, with its facts. */
export const WaiverStatusSchema = z
  .object({
    policyKey: z.string(),
    status: WaiverStatusValueSchema,
    reason: WaiverStatusReasonSchema.nullable(),
    /** The approved version in force at the instant; null when the family has none. */
    currentVersion: WaiverVersionRefSchema.nullable(),
    /** The acceptance the status was judged by (the latest that could count); null when missing. */
    acceptance: WaiverAcceptanceSchema.nullable(),
    /** When a current acceptance stops counting by time; null when it never does. */
    validUntil: Instant.nullable(),
    /** When a lapsed acceptance stopped counting; null otherwise. */
    lapsedAt: Instant.nullable(),
    /** Null when no version is in force (nothing states a rule). */
    rule: WaiverRuleSchema.nullable(),
    evaluatedAt: Instant,
  })
  .openapi('WaiverStatus');
export type WaiverStatus = z.infer<typeof WaiverStatusSchema>;

export const WaiverActivityTypeSchema = z
  .enum(['offering', 'offering_session', 'scheduling_event', 'booking'])
  .openapi('WaiverActivityType');
export type WaiverActivityType = z.infer<typeof WaiverActivityTypeSchema>;

export const WaiverActivityRefSchema = z
  .object({ type: WaiverActivityTypeSchema, id: z.uuid() })
  .openapi('WaiverActivityRef');
export type WaiverActivityRef = z.infer<typeof WaiverActivityRefSchema>;

/** A recorded staff decision to let a person take part although the waiver rule blocks. */
export const WaiverOverrideSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    policyKey: z.string(),
    policyVersionId: z.uuid().nullable(),
    waiverStatus: z.enum(['missing', 'lapsed']),
    activity: WaiverActivityRefSchema,
    reason: z.string(),
    actorPersonId: z.uuid(),
    occurredAt: Instant,
  })
  .openapi('WaiverOverride');
export type WaiverOverride = z.infer<typeof WaiverOverrideSchema>;

export const PersonWaiverSchema = WaiverStatusSchema.extend({
  title: z.string(),
  /** Every acceptance of the family for this person, newest first, withdrawn ones included. */
  history: z.array(WaiverAcceptanceSchema),
  /** Staff only; empty for the person and their guardians. */
  overrides: z.array(WaiverOverrideSchema),
}).openapi('PersonWaiver');
export type PersonWaiver = z.infer<typeof PersonWaiverSchema>;

/**
 * `evaluated` is false when the organization has not turned liability waivers on: nothing is
 * judged and `waivers` is empty (acknowledgment history stays readable through /acknowledgments).
 */
export const PersonWaiversSchema = z
  .object({
    personId: z.uuid(),
    evaluated: z.boolean(),
    waivers: z.array(PersonWaiverSchema),
  })
  .openapi('PersonWaivers');
export type PersonWaivers = z.infer<typeof PersonWaiversSchema>;

export const RecordWaiverAcceptanceBody = withCommandMeta({
  /** The person covered. */
  subjectPersonId: z.uuid(),
  policyKey: WaiverPolicyKey,
  /** Defaults to the version in force. */
  policyVersionId: z.uuid().optional(),
  method: AcknowledgmentMethodSchema.default('digital'),
  /** Required when staff record it (they name the signer and are never the signer). */
  signedByPersonId: z.uuid().optional(),
  /** Paper only, and required for it: the date written on the paper. */
  paperDatedOn: z.iso.date().optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
})
  .refine((v) => (v.method === 'paper') === (v.paperDatedOn !== undefined), {
    message: 'a paper acceptance states the date on the paper; a digital one never does',
    path: ['paperDatedOn'],
  })
  .openapi('RecordWaiverAcceptanceRequest');
export type RecordWaiverAcceptanceInput = z.infer<typeof RecordWaiverAcceptanceBody>;

export const RecordWaiverOverrideBody = withCommandMeta({
  personId: z.uuid(),
  policyKey: WaiverPolicyKey,
  activity: WaiverActivityRefSchema,
})
  .extend({ reason: Reason })
  .openapi('RecordWaiverOverrideRequest');
export type RecordWaiverOverrideInput = z.infer<typeof RecordWaiverOverrideBody>;

export const OfferingRequiredWaiverSchema = z
  .object({
    policyKey: z.string(),
    /** The version in force now; null when the family has no approved version in force. */
    currentVersion: WaiverVersionRefSchema.nullable(),
    enforcement: WaiverEnforcementSchema.nullable(),
  })
  .openapi('OfferingRequiredWaiver');
export type OfferingRequiredWaiver = z.infer<typeof OfferingRequiredWaiverSchema>;

export const OfferingRequiredWaiversSchema = z
  .object({ offeringId: z.uuid(), waivers: z.array(OfferingRequiredWaiverSchema) })
  .openapi('OfferingRequiredWaivers');
export type OfferingRequiredWaivers = z.infer<typeof OfferingRequiredWaiversSchema>;

export const SetOfferingRequiredWaiversBody = withCommandMeta({
  /** The complete set of waiver families the offering requires; empty requires none. */
  policyKeys: z.array(WaiverPolicyKey).max(10),
}).openapi('SetOfferingRequiredWaiversRequest');
export type SetOfferingRequiredWaiversInput = z.infer<typeof SetOfferingRequiredWaiversBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------

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
      400: err('Validation failed'),
      403: err('Access denied, participant authority required, or the capability is turned off'),
      404: err('Not found or not visible'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, IDEMPOTENCY_*)'),
    },
  });
}

function query(path: string, summary: string, response: z.ZodType) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: { params: IdParams },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/people/{id}/waivers',
  "A person's waivers: current, lapsed or missing with the facts, and the acceptance history (staff; the person; a guardian holding complete_forms) (SPK-REG-011, proposed)",
  PersonWaiversSchema,
);
command(
  '/waiver-acceptances',
  'Accept a waiver digitally (the adult or a guardian), or record a signed paper as a staff entry with the date on the paper (SPK-REG-011, SPK-REG-009, proposed)',
  RecordWaiverAcceptanceBody,
  AcknowledgmentSchema,
);
command(
  '/waiver-overrides',
  'Record an override of a blocking waiver rule for one person and one activity (SPK-REG-011, proposed)',
  RecordWaiverOverrideBody,
  WaiverOverrideSchema,
);
query(
  '/offerings/{id}/required-waivers',
  'The waiver families an offering requires, with the version in force (SPK-REG-011, proposed)',
  OfferingRequiredWaiversSchema,
);
command(
  '/offerings/{id}/required-waivers',
  'Set the waiver families an offering requires (SPK-REG-011, proposed)',
  SetOfferingRequiredWaiversBody,
  OfferingRequiredWaiversSchema,
  200,
);
