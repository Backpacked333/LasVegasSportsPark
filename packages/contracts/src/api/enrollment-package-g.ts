import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';
import { BasketSchema, EnrollmentStatusSchema } from './enrollment';

/**
 * Enrollment Package G API contract (§3.16, §6.5 Package G; SPK-COND-001 to SPK-COND-003,
 * SPK-YOUTH-005, SPK-YOUTH-006). Each capability is behind its organization switch (DEC-016 and
 * the capability's decision); a disabled capability refuses new commitments with ACCESS_DENIED
 * (details.code CAPABILITY_DISABLED) while reads, cancellations, reversals and expiry keep working.
 */

const Reason = z.string().trim().min(1).max(2000);
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Enrollment';

// ---------------------------------------------------------------------------------------------
// Session packages (ENR-11; capability session_packages, DEC-074)
// ---------------------------------------------------------------------------------------------

export const PackageEntitlementStatusSchema = z
  .enum(['active', 'exhausted', 'expired', 'revoked'])
  .openapi('PackageEntitlementStatus');
export type PackageEntitlementStatus = z.infer<typeof PackageEntitlementStatusSchema>;

export const PackageRedemptionSchema = z
  .object({
    id: z.uuid(),
    sessionBookingId: z.uuid(),
    kind: z.enum(['redeem', 'reversal']),
    reversesRedemptionId: z.uuid().nullable(),
    reason: z.string().nullable(),
    redeemedAt: Instant,
  })
  .openapi('PackageRedemption');
export type PackageRedemption = z.infer<typeof PackageRedemptionSchema>;

export const PackageEntitlementSchema = z
  .object({
    id: z.uuid(),
    participantPersonId: z.uuid(),
    /** The confirmed package purchase that issued the credits. */
    enrollmentId: z.uuid(),
    offeringId: z.uuid(),
    offeringName: z.string().nullable(),
    entitlementDefinitionId: z.uuid(),
    appliesTo: z.object({ offeringIds: z.array(z.uuid()), programIds: z.array(z.uuid()) }),
    credits: z.number().int(),
    redeemedCount: z.number().int(),
    remainingCredits: z.number().int(),
    status: PackageEntitlementStatusSchema,
    /** Null when the package definition chose no expiry (POL-039). */
    expiresAt: Instant.nullable(),
    issuedAt: Instant,
    expiredAt: Instant.nullable(),
    revokedAt: Instant.nullable(),
    revokedReason: z.string().nullable(),
    redemptions: z.array(PackageRedemptionSchema),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PackageEntitlement');
export type PackageEntitlement = z.infer<typeof PackageEntitlementSchema>;

export const ListMyPackageEntitlementsQuery = PageRequestSchema.extend({
  status: PackageEntitlementStatusSchema.optional(),
});
export type ListMyPackageEntitlementsQuery = z.infer<typeof ListMyPackageEntitlementsQuery>;

export const ListPackageEntitlementsQuery = PageRequestSchema.extend({
  participantPersonId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  status: PackageEntitlementStatusSchema.optional(),
});
export type ListPackageEntitlementsQuery = z.infer<typeof ListPackageEntitlementsQuery>;

export const ReversePackageRedemptionBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('ReversePackageRedemptionRequest');
export type ReversePackageRedemptionInput = z.infer<typeof ReversePackageRedemptionBody>;

// ---------------------------------------------------------------------------------------------
// Memberships (ENR-12; capability memberships, DEC-072)
// ---------------------------------------------------------------------------------------------

export const MembershipSuspensionSchema = z
  .object({
    id: z.uuid(),
    enrollmentId: z.uuid(),
    participantPersonId: z.uuid(),
    from: Instant,
    /** Null: suspended until ended. */
    until: Instant.nullable(),
    reason: z.string(),
    status: z.enum(['active', 'ended']),
    endedAt: Instant.nullable(),
    endedReason: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('MembershipSuspension');
export type MembershipSuspension = z.infer<typeof MembershipSuspensionSchema>;

/** SPK-COND-001: what attendance the membership includes, exactly as its definition states. */
export const MembershipAttendanceSummarySchema = z
  .object({
    mode: z.enum(['none', 'included_sessions', 'unlimited']),
    limit: z
      .object({
        count: z.number().int(),
        period: z.enum(['week', 'month', 'membership_term']),
        weekStartsOn: z.number().int().nullable(),
      })
      .nullable(),
    appliesTo: z
      .object({ offeringIds: z.array(z.uuid()), programIds: z.array(z.uuid()) })
      .nullable(),
  })
  .openapi('MembershipAttendanceSummary');

export const MembershipUsageSchema = z
  .object({
    periodKey: z.string(),
    usedCount: z.number().int(),
    limitCount: z.number().int(),
  })
  .openapi('MembershipUsage');

export const MembershipSchema = z
  .object({
    enrollmentId: z.uuid(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    offeringName: z.string().nullable(),
    status: EnrollmentStatusSchema,
    /** Set when the membership is confirmed (null until then, or when its term is unknown). */
    termStartsAt: Instant.nullable(),
    termEndsAt: Instant.nullable(),
    /** Null when the offering's definition cannot be read (nothing is assumed). */
    attendance: MembershipAttendanceSummarySchema.nullable(),
    renewedFromEnrollmentId: z.uuid().nullable(),
    suspensions: z.array(MembershipSuspensionSchema),
    usage: z.array(MembershipUsageSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Membership');
export type Membership = z.infer<typeof MembershipSchema>;

export const ListMyMembershipsQuery = PageRequestSchema.extend({
  status: EnrollmentStatusSchema.optional(),
});
export type ListMyMembershipsQuery = z.infer<typeof ListMyMembershipsQuery>;

export const CreateMembershipSuspensionBody = withCommandMeta({
  from: Instant,
  until: Instant.optional(),
})
  .extend({ reason: Reason })
  .openapi('CreateMembershipSuspensionRequest');
export type CreateMembershipSuspensionInput = z.infer<typeof CreateMembershipSuspensionBody>;

export const EndMembershipSuspensionBody = withCommandMeta({})
  .extend({ reason: Reason, expectedRevision: Revision })
  .openapi('EndMembershipSuspensionRequest');
export type EndMembershipSuspensionInput = z.infer<typeof EndMembershipSuspensionBody>;

export const RenewMembershipBody = withCommandMeta({
  /** The membership offering the renewal buys (often the next term's). */
  targetOfferingId: z.uuid(),
  /** An open basket of the caller's household to add the line to; a new one is opened otherwise. */
  basketId: z.uuid().optional(),
}).openapi('RenewMembershipRequest');
export type RenewMembershipInput = z.infer<typeof RenewMembershipBody>;

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

function paramsOf(path: string): z.ZodObject<z.ZodRawShape> | undefined {
  if (path.includes('{personId}')) return z.object({ personId: z.uuid() });
  return path.includes('{id}') ? IdParams : undefined;
}

function command(
  method: 'post' | 'patch',
  path: string,
  summary: string,
  body: z.ZodType | null,
  response: z.ZodType,
  status = 201,
) {
  openApiRegistry.registerPath({
    method,
    path,
    summary,
    tags: [TAG],
    request: {
      params: paramsOf(path),
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied, participant authority required or capability disabled'),
      404: err('Not found or not visible (protected records never reveal existence)'),
      409: err('Conflict (RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
      422: err('Eligibility failed'),
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
    request: { params: paramsOf(path), query: request ?? undefined },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/me/package-entitlements',
  "The caller's and their dependants' session packages (ENR-11)",
  ListMyPackageEntitlementsQuery,
  pageSchema(PackageEntitlementSchema),
);
query(
  '/package-entitlements',
  'Session packages (staff, facility-scoped; ENR-11)',
  ListPackageEntitlementsQuery,
  pageSchema(PackageEntitlementSchema),
);
command(
  'post',
  '/package-redemptions/{id}/reverse',
  'Reverse a package redemption: the credit is returned (staff correction, ungated; ENR-11)',
  ReversePackageRedemptionBody,
  PackageEntitlementSchema,
  200,
);
query(
  '/me/memberships',
  "The caller's and their dependants' memberships with term, suspensions and usage (ENR-12)",
  ListMyMembershipsQuery,
  pageSchema(MembershipSchema),
);
command(
  'post',
  '/enrollments/{id}/membership-suspensions',
  'Suspend a membership for a period (ENR-12)',
  CreateMembershipSuspensionBody,
  MembershipSuspensionSchema,
);
command(
  'post',
  '/membership-suspensions/{id}/end',
  'End a membership suspension (ENR-12)',
  EndMembershipSuspensionBody,
  MembershipSuspensionSchema,
  200,
);
command(
  'post',
  '/enrollments/{id}/renew',
  'Add a renewal of the membership to a basket; nothing is charged until checkout (ENR-12)',
  RenewMembershipBody,
  BasketSchema,
);
