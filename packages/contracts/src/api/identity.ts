import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PrincipalKind, StaffRole } from '../principal';
import { Instant } from '../time';

/**
 * Identity module API contract (specification §3.1 SPK-IAM-001..007, §4.8).
 * Organization context always comes from the authenticated principal; no request carries it.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------
export const GrantPermissionSchema = z
  .enum(['view', 'register', 'pay', 'receive_messages', 'complete_forms', 'collect'])
  .openapi('GrantPermission');
export type GrantPermissionValue = z.infer<typeof GrantPermissionSchema>;

export const PersonKindSchema = z.enum(['adult', 'child']).openapi('PersonKind');
export const PersonStatusSchema = z.enum(['active', 'inactive', 'merged']).openapi('PersonStatus');
export const RelationshipKindSchema = z
  .enum(['guardian', 'delegate', 'caregiver', 'self_managed'])
  .openapi('RelationshipKind');
export const InvitationRelationshipKindSchema = z.enum(['guardian', 'delegate', 'caregiver']);
export const RelationshipStatusSchema = z.enum(['active', 'suspended', 'ended']);
export const AuthoritySourceSchema = z.enum([
  'staff',
  'self_service',
  'invitation',
  'claim',
  'review',
  'import',
]);
export const ContactPointKindSchema = z.enum(['email', 'phone']).openapi('ContactPointKind');
export const InvitationStatusSchema = z
  .enum(['pending', 'accepted', 'revoked', 'expired'])
  .openapi('InvitationStatus');
export const ClaimKindSchema = z.enum(['self', 'guardian']).openapi('ClaimKind');
export const AccessReviewStatusSchema = z
  .enum(['open', 'escalated', 'decided', 'closed'])
  .openapi('AccessReviewStatus');
export const AccessReviewOwnerRoleSchema = z.enum([
  'general_manager',
  'system_administrator',
  'support_operator',
]);
export const AccessReviewDecisionKindSchema = z.enum([
  'restrict',
  'lift',
  'escalate',
  'decide',
  'close',
  'note',
  'reassign',
]);
export const DuplicateCandidateStatusSchema = z.enum(['open', 'merged', 'dismissed']);
export const StaffMembershipStatusSchema = z.enum(['active', 'ended']);
export const AccountStatusSchema = z.enum(['active', 'disabled']);

export const DateOnly = z.iso.date();
const PersonName = z.string().trim().min(1).max(200);
const Reason = z.string().trim().min(1).max(2000);
const ContactValue = z.string().trim().min(3).max(320);
const Token = z.string().min(16).max(512);

const ContactPointInput = z.object({
  kind: ContactPointKindSchema,
  value: ContactValue,
  isPrimary: z.boolean().default(false),
  /** Staff may record a contact point as verified (identity checked in person); customers may not. */
  verified: z.boolean().default(false),
});

// ---------------------------------------------------------------------------------------------
// Persons and contact points
// ---------------------------------------------------------------------------------------------
export const PersonSchema = z
  .object({
    id: z.uuid(),
    kind: PersonKindSchema,
    givenName: z.string(),
    familyName: z.string(),
    dateOfBirth: DateOnly.nullable(),
    status: PersonStatusSchema,
    mergedIntoPersonId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('Person');
export type Person = z.infer<typeof PersonSchema>;

export const ContactPointSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    kind: ContactPointKindSchema,
    value: z.string(),
    isPrimary: z.boolean(),
    verifiedAt: Instant.nullable(),
    createdAt: Instant,
  })
  .openapi('ContactPoint');
export type ContactPoint = z.infer<typeof ContactPointSchema>;

export const CreatePersonBody = z
  .object({
    kind: PersonKindSchema,
    givenName: PersonName,
    familyName: PersonName,
    dateOfBirth: DateOnly.optional(),
    contactPoints: z.array(ContactPointInput).max(10).default([]),
  })
  .openapi('CreatePersonRequest');
export type CreatePersonInput = z.infer<typeof CreatePersonBody>;

export const UpdatePersonBody = withCommandMeta({
  givenName: PersonName.optional(),
  familyName: PersonName.optional(),
  dateOfBirth: DateOnly.nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdatePersonRequest');
export type UpdatePersonInput = z.infer<typeof UpdatePersonBody>;

export const AddContactPointBody = ContactPointInput.openapi('AddContactPointRequest');
export type AddContactPointInput = z.infer<typeof AddContactPointBody>;

export const PersonDetailSchema = PersonSchema.extend({
  contactPoints: z.array(ContactPointSchema),
}).openapi('PersonDetail');
export type PersonDetail = z.infer<typeof PersonDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------
export const AccountSchema = z
  .object({
    id: z.uuid(),
    issuer: z.string(),
    subject: z.string(),
    personId: z.uuid().nullable(),
    status: AccountStatusSchema,
    lastLoginAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Account');
export type Account = z.infer<typeof AccountSchema>;

export const CreateAccountBody = withCommandMeta({
  issuer: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
  personId: z.uuid().optional(),
}).openapi('CreateAccountRequest');
export type CreateAccountInput = z.infer<typeof CreateAccountBody>;

export const RelinkAccountBody = withCommandMeta({
  issuer: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
})
  .extend({ reason: Reason })
  .openapi('RelinkAccountRequest');
export type RelinkAccountInput = z.infer<typeof RelinkAccountBody>;

// ---------------------------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------------------------
export const StaffMembershipSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    roles: z.array(StaffRole),
    facilityIds: z.array(z.uuid()),
    status: StaffMembershipStatusSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('StaffMembership');
export type StaffMembership = z.infer<typeof StaffMembershipSchema>;

export const MeResponse = z
  .object({
    principal: z.object({
      kind: PrincipalKind,
      organizationId: z.uuid().nullable(),
      accountId: z.uuid().nullable(),
      personId: z.uuid().nullable(),
      staffRoles: z.array(StaffRole),
      facilityIds: z.array(z.uuid()),
    }),
    person: PersonSchema.nullable(),
    staffMemberships: z.array(StaffMembershipSchema),
    /** Current effective permissions this person holds over other people (never inferred). */
    authorities: z.array(
      z.object({ subjectPersonId: z.uuid(), permissions: z.array(GrantPermissionSchema) }),
    ),
  })
  .openapi('Me');
export type Me = z.infer<typeof MeResponse>;

// ---------------------------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------------------------
export const HouseholdMemberSchema = z.object({
  personId: z.uuid(),
  label: z.string().nullable(),
});
export const HouseholdSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    members: z.array(HouseholdMemberSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Household');
export type Household = z.infer<typeof HouseholdSchema>;

export const CreateHouseholdBody = z
  .object({ name: z.string().trim().min(1).max(200) })
  .openapi('CreateHouseholdRequest');
export const AddHouseholdMemberBody = z
  .object({ personId: z.uuid(), label: z.string().trim().min(1).max(100).optional() })
  .openapi('AddHouseholdMemberRequest');

// ---------------------------------------------------------------------------------------------
// Relationships and access grants
// ---------------------------------------------------------------------------------------------
export const RelationshipSchema = z
  .object({
    id: z.uuid(),
    actorPersonId: z.uuid(),
    subjectPersonId: z.uuid(),
    kind: RelationshipKindSchema,
    status: RelationshipStatusSchema,
    source: AuthoritySourceSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Relationship');
export type Relationship = z.infer<typeof RelationshipSchema>;

export const AccessGrantSchema = z
  .object({
    id: z.uuid(),
    relationshipId: z.uuid(),
    actorPersonId: z.uuid(),
    subjectPersonId: z.uuid(),
    permission: GrantPermissionSchema,
    source: AuthoritySourceSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    revokedAt: Instant.nullable(),
    revocationReason: z.string().nullable(),
    suspendedAt: Instant.nullable(),
    suspendedByReviewId: z.uuid().nullable(),
    /** Whether the grant confers authority right now (unrevoked, unsuspended, within dates). */
    effective: z.boolean(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('AccessGrant');
export type AccessGrant = z.infer<typeof AccessGrantSchema>;

export const CreateRelationshipBody = withCommandMeta({
  actorPersonId: z.uuid(),
  subjectPersonId: z.uuid(),
  kind: RelationshipKindSchema,
  /** Permissions to grant together with the relationship; none are implied. */
  permissions: z.array(GrantPermissionSchema).max(6).default([]),
  effectiveFrom: Instant.optional(),
  effectiveTo: Instant.optional(),
}).openapi('CreateRelationshipRequest');
export type CreateRelationshipInput = z.infer<typeof CreateRelationshipBody>;

export const RelationshipCreatedResponse = z
  .object({ relationship: RelationshipSchema, grants: z.array(AccessGrantSchema) })
  .openapi('RelationshipCreated');

export const CreateAccessGrantBody = withCommandMeta({
  relationshipId: z.uuid(),
  permission: GrantPermissionSchema,
  effectiveFrom: Instant.optional(),
  effectiveTo: Instant.optional(),
}).openapi('CreateAccessGrantRequest');
export type CreateAccessGrantInput = z.infer<typeof CreateAccessGrantBody>;

export const RevokeAccessGrantBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeAccessGrantRequest');
export type RevokeAccessGrantInput = z.infer<typeof RevokeAccessGrantBody>;

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------
export const InvitationScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('person'), personId: z.uuid() }),
  z.object({ type: z.literal('household'), householdId: z.uuid() }),
]);

export const InvitationSchema = z
  .object({
    id: z.uuid(),
    invitedByPersonId: z.uuid().nullable(),
    recipientPersonId: z.uuid().nullable(),
    recipientContact: z.object({ kind: ContactPointKindSchema, value: z.string() }).nullable(),
    scope: InvitationScopeSchema,
    relationshipKind: InvitationRelationshipKindSchema,
    requestedPermissions: z.array(GrantPermissionSchema),
    grantedPermissions: z.array(GrantPermissionSchema),
    status: InvitationStatusSchema,
    expiresAt: Instant,
    acceptedAt: Instant.nullable(),
    acceptedByPersonId: z.uuid().nullable(),
    revokedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Invitation');
export type Invitation = z.infer<typeof InvitationSchema>;

export const CreateInvitationBody = withCommandMeta({
  recipientPersonId: z.uuid().optional(),
  recipientContact: z.object({ kind: ContactPointKindSchema, value: ContactValue }).optional(),
  scope: InvitationScopeSchema,
  relationshipKind: InvitationRelationshipKindSchema,
  requestedPermissions: z.array(GrantPermissionSchema).min(1).max(6),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
})
  .refine((v) => v.recipientPersonId !== undefined || v.recipientContact !== undefined, {
    message: 'recipientPersonId or recipientContact is required',
    path: ['recipientPersonId'],
  })
  .openapi('CreateInvitationRequest');
export type CreateInvitationInput = z.infer<typeof CreateInvitationBody>;

/** The one-time token is returned only on creation so the inviter (or messaging) can deliver it. */
export const InvitationIssuedResponse = InvitationSchema.extend({ token: z.string() }).openapi(
  'InvitationIssued',
);

export const AcceptInvitationBody = z.object({ token: Token }).openapi('AcceptInvitationRequest');
export const InvitationAcceptedResponse = z
  .object({
    invitation: InvitationSchema,
    relationships: z.array(RelationshipSchema),
    grants: z.array(AccessGrantSchema),
    /** Requested permissions the inviter no longer held at acceptance; never granted. */
    droppedPermissions: z.array(GrantPermissionSchema),
  })
  .openapi('InvitationAccepted');

export const RevokeInvitationBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeInvitationRequest');

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------
export const ClaimSchema = z
  .object({
    id: z.uuid(),
    subjectPersonId: z.uuid(),
    kind: ClaimKindSchema,
    requestedPermissions: z.array(GrantPermissionSchema),
    status: InvitationStatusSchema,
    expiresAt: Instant,
    acceptedAt: Instant.nullable(),
    acceptedByPersonId: z.uuid().nullable(),
    revokedAt: Instant.nullable(),
    /** The verified contact point a guardian claim is bound to (SPK-IAM-002); null for self claims. */
    recipientContact: z.object({ kind: ContactPointKindSchema, value: z.string() }).nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Claim');
export type Claim = z.infer<typeof ClaimSchema>;

export const IssueClaimBody = withCommandMeta({
  kind: ClaimKindSchema,
  requestedPermissions: z.array(GrantPermissionSchema).max(6).default([]),
  recipientContact: z.object({ kind: ContactPointKindSchema, value: ContactValue }).optional(),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
})
  .refine((v) => (v.kind === 'self') === (v.requestedPermissions.length === 0), {
    message: 'self claims carry no permissions; guardian claims require at least one',
    path: ['requestedPermissions'],
  })
  // SPK-IAM-002 "claimable by the correct verified customer": a guardian claim is bound to the
  // contact point its recipient must have verified, like an invitation (SPK-IAM-004).
  .refine((v) => v.kind !== 'guardian' || v.recipientContact !== undefined, {
    message: 'a guardian claim names the contact point its recipient has verified',
    path: ['recipientContact'],
  })
  // A self claim is accepted by an account with no person yet, which holds no verified contact
  // point; until provider-verified contact claims reach the service (identity provider, DEC-018),
  // a recipient on a self claim could not be enforced, so it is refused rather than ignored.
  .refine((v) => v.kind !== 'self' || v.recipientContact === undefined, {
    message:
      'a self claim cannot be bound to a contact point until verified provider contact claims are available; hand the token over in person',
    path: ['recipientContact'],
  })
  .openapi('IssueClaimRequest');
export type IssueClaimInput = z.infer<typeof IssueClaimBody>;

export const ClaimIssuedResponse = ClaimSchema.extend({ token: z.string() }).openapi('ClaimIssued');
/** The claim token travels in the body, never in the URL path (§4.14). */
export const AcceptClaimBody = z.object({ token: Token }).openapi('AcceptClaimRequest');
export const RevokeClaimBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('RevokeClaimRequest');
export const ClaimAcceptedResponse = z
  .object({
    claim: ClaimSchema,
    accountId: z.uuid(),
    /** The person the account now acts as (self claim) or the claimant (guardian claim). */
    personId: z.uuid(),
    relationship: RelationshipSchema.nullable(),
    grants: z.array(AccessGrantSchema),
  })
  .openapi('ClaimAccepted');

// ---------------------------------------------------------------------------------------------
// Staff memberships
// ---------------------------------------------------------------------------------------------
export const CreateStaffMembershipBody = withCommandMeta({
  personId: z.uuid(),
  roles: z.array(StaffRole).min(1).max(11),
  facilityIds: z.array(z.uuid()).max(50).default([]),
  effectiveFrom: Instant.optional(),
  effectiveTo: Instant.optional(),
}).openapi('CreateStaffMembershipRequest');
export type CreateStaffMembershipInput = z.infer<typeof CreateStaffMembershipBody>;

export const UpdateStaffMembershipBody = withCommandMeta({
  roles: z.array(StaffRole).min(1).max(11).optional(),
  facilityIds: z.array(z.uuid()).max(50).optional(),
  effectiveTo: Instant.nullable().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('UpdateStaffMembershipRequest');
export type UpdateStaffMembershipInput = z.infer<typeof UpdateStaffMembershipBody>;

export const EndStaffMembershipBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('EndStaffMembershipRequest');

// ---------------------------------------------------------------------------------------------
// Access reviews
// ---------------------------------------------------------------------------------------------
export const AccessReviewPartySchema = z.object({
  personId: z.uuid().optional(),
  description: z.string().trim().min(1).max(500),
});
export const AccessReviewEvidenceSchema = z.object({
  type: z.string().trim().min(1).max(100),
  reference: z.string().trim().min(1).max(1000),
  note: z.string().trim().max(2000).optional(),
});
export const AccessReviewDecisionSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    kind: AccessReviewDecisionKindSchema,
    note: z.string().nullable(),
    affectedGrantIds: z.array(z.uuid()),
    effectiveFrom: Instant.nullable(),
    effectiveTo: Instant.nullable(),
    occurredAt: Instant,
  })
  .openapi('AccessReviewDecision');

export const AccessReviewSchema = z
  .object({
    id: z.uuid(),
    subjectPersonId: z.uuid(),
    reason: z.string(),
    parties: z.array(AccessReviewPartySchema),
    evidence: z.array(AccessReviewEvidenceSchema),
    ownerRole: AccessReviewOwnerRoleSchema,
    ownerPersonId: z.uuid().nullable(),
    status: AccessReviewStatusSchema,
    effectiveFrom: Instant,
    effectiveTo: Instant.nullable(),
    escalatedAt: Instant.nullable(),
    decidedAt: Instant.nullable(),
    closedAt: Instant.nullable(),
    outcome: z.record(z.string(), z.unknown()).nullable(),
    decisions: z.array(AccessReviewDecisionSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('AccessReview');
export type AccessReview = z.infer<typeof AccessReviewSchema>;

export const OpenAccessReviewBody = withCommandMeta({
  subjectPersonId: z.uuid(),
  parties: z.array(AccessReviewPartySchema).max(20).default([]),
  evidence: z.array(AccessReviewEvidenceSchema).max(50).default([]),
  ownerRole: AccessReviewOwnerRoleSchema.default('support_operator'),
  effectiveTo: Instant.optional(),
})
  .extend({ reason: Reason })
  .openapi('OpenAccessReviewRequest');
export type OpenAccessReviewInput = z.infer<typeof OpenAccessReviewBody>;

export const AccessReviewDecisionBody = withCommandMeta({
  kind: AccessReviewDecisionKindSchema,
  note: z.string().trim().max(4000).optional(),
  /** restrict/lift: explicit grant ids, or every grant held by actorPersonId over the subject. */
  grantIds: z.array(z.uuid()).max(100).optional(),
  actorPersonId: z.uuid().optional(),
  effectiveTo: Instant.optional(),
  outcome: z.record(z.string(), z.unknown()).optional(),
  ownerRole: AccessReviewOwnerRoleSchema.optional(),
  ownerPersonId: z.uuid().optional(),
}).openapi('AccessReviewDecisionRequest');
export type AccessReviewDecisionInput = z.infer<typeof AccessReviewDecisionBody>;

// ---------------------------------------------------------------------------------------------
// Duplicates and merges
// ---------------------------------------------------------------------------------------------
export const DuplicateCandidateSchema = z
  .object({
    id: z.uuid(),
    personAId: z.uuid(),
    personBId: z.uuid(),
    reasons: z.array(z.string()),
    score: z.number().int(),
    status: DuplicateCandidateStatusSchema,
    decision: z.record(z.string(), z.unknown()).nullable(),
    decidedAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('DuplicateCandidate');
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

export const FlagDuplicateBody = withCommandMeta({
  personAId: z.uuid(),
  personBId: z.uuid(),
  reasons: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  score: z.number().int().min(0).max(100).default(50),
})
  .refine((v) => v.personAId !== v.personBId, {
    message: 'a person cannot duplicate itself',
    path: ['personBId'],
  })
  .openapi('FlagDuplicateRequest');
export type FlagDuplicateInput = z.infer<typeof FlagDuplicateBody>;

export const MergeDuplicateBody = withCommandMeta({ survivorPersonId: z.uuid() })
  .extend({ reason: Reason })
  .openapi('MergeDuplicateRequest');
export type MergeDuplicateInput = z.infer<typeof MergeDuplicateBody>;

export const DismissDuplicateBody = withCommandMeta({})
  .extend({ reason: Reason })
  .openapi('DismissDuplicateRequest');

export const PersonMergeSchema = z
  .object({
    id: z.uuid(),
    survivorPersonId: z.uuid(),
    mergedPersonId: z.uuid(),
    candidateId: z.uuid().nullable(),
    moved: z.record(z.string(), z.unknown()),
    operationId: z.uuid().nullable(),
    occurredAt: Instant,
  })
  .openapi('PersonMerge');
export type PersonMerge = z.infer<typeof PersonMergeSchema>;

// ---------------------------------------------------------------------------------------------
// Development tokens (local identity provider only)
// ---------------------------------------------------------------------------------------------
export const DevTokenBody = z
  .object({
    accountId: z.uuid(),
    sessionId: z.string().min(1).max(200).optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600)
      .optional(),
  })
  .openapi('DevTokenRequest');
export const DevTokenResponse = z
  .object({ token: z.string(), accountId: z.uuid(), expiresAt: Instant })
  .openapi('DevToken');

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

function register(input: {
  method: 'get' | 'post' | 'patch';
  path: string;
  summary: string;
  requirements: string;
  params?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201;
  idempotent?: boolean;
  security?: [];
  deprecated?: boolean;
}): void {
  const status = input.status ?? (input.method === 'post' ? 201 : 200);
  openApiRegistry.registerPath({
    method: input.method,
    path: input.path,
    summary: input.summary,
    description: `Implements ${input.requirements}.${
      input.idempotent ? ' Requires an Idempotency-Key header (§4.9).' : ''
    }`,
    tags: ['Identity'],
    ...(input.security ? { security: input.security } : {}),
    ...(input.deprecated ? { deprecated: true } : {}),
    request: {
      ...(input.params ? { params: input.params as never } : {}),
      ...(input.body ? { body: { content: { 'application/json': { schema: input.body } } } } : {}),
    },
    responses: {
      [status]: {
        description: 'Success',
        content: { 'application/json': { schema: input.response } },
      },
      400: errorResponse('Validation failed'),
      401: errorResponse('Authentication required'),
      403: errorResponse('Access denied or participant authority required'),
      404: errorResponse('Not found or not visible'),
      409: errorResponse('Conflict (stale revision, invalid transition, idempotency)'),
    },
  });
}

register({
  method: 'get',
  path: '/me',
  summary: 'Describe the authenticated principal and its current authorities',
  requirements: 'SPK-IAM-001, SPK-IAM-003',
  response: MeResponse,
});
register({
  method: 'post',
  path: '/people',
  summary: 'Create a person (staff) or a child record (self-service adult)',
  requirements: 'SPK-IAM-001, SPK-IAM-007',
  body: CreatePersonBody,
  response: PersonDetailSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/people/{id}',
  summary: 'Read a person (self, guardians holding view, staff)',
  requirements: 'SPK-IAM-002, SPK-IAM-003',
  params: IdParams,
  response: PersonDetailSchema,
});
register({
  method: 'patch',
  path: '/people/{id}',
  summary: 'Update a person with an expected revision',
  requirements: 'SPK-IAM-001, §4.9',
  params: IdParams,
  body: UpdatePersonBody,
  response: PersonDetailSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/people/{id}/contact-points',
  summary: 'Add a contact point to a person',
  requirements: 'SPK-IAM-001',
  params: IdParams,
  body: AddContactPointBody,
  response: ContactPointSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/people/{id}/claims',
  summary:
    'Issue a claim token so a verified customer can claim a staff-created participant; the secret is returned once and a replay answers IDEMPOTENCY_SECRET_WITHHELD',
  requirements: 'SPK-IAM-002',
  params: IdParams,
  body: IssueClaimBody,
  response: ClaimIssuedResponse,
  idempotent: true,
});
register({
  method: 'post',
  path: '/claims/accept',
  summary:
    'Claim a staff-created participant with a verified account (no duplicate person); the token is sent in the body',
  requirements: 'SPK-IAM-002, §4.14',
  body: AcceptClaimBody,
  response: ClaimAcceptedResponse,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/claims/{token}/accept',
  summary:
    'Deprecated: use POST /claims/accept, which keeps the token out of the URL path (§4.14). Kept until clients move.',
  requirements: 'SPK-IAM-002',
  params: z.object({ token: Token }),
  response: ClaimAcceptedResponse,
  status: 200,
  idempotent: true,
  deprecated: true,
});
register({
  method: 'post',
  path: '/claims/{id}/revoke',
  summary: 'Revoke a pending claim (a leaked or misdelivered token can no longer be accepted)',
  requirements: 'SPK-IAM-002, SPK-IAM-006',
  params: IdParams,
  body: RevokeClaimBody,
  response: ClaimSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/accounts',
  summary: 'Provision a login account for a provider identity',
  requirements: 'SPK-IAM-001, SPK-IAM-002',
  body: CreateAccountBody,
  response: AccountSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/accounts/{id}/relink',
  summary: 'Recover an account by linking it to a new provider identity (no new access)',
  requirements: 'SPK-AT-025',
  params: IdParams,
  body: RelinkAccountBody,
  response: AccountSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/households',
  summary: 'Create a household (grouping only; never authority)',
  requirements: 'SPK-IAM-001, §4.5',
  body: CreateHouseholdBody,
  response: HouseholdSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/households/{id}/members',
  summary: 'Add a person to a household',
  requirements: 'SPK-IAM-001, §4.5',
  params: IdParams,
  body: AddHouseholdMemberBody,
  response: HouseholdSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/relationships',
  summary: 'Create a relationship and its explicit grants',
  requirements: 'SPK-IAM-001, SPK-IAM-003',
  body: CreateRelationshipBody,
  response: RelationshipCreatedResponse,
  idempotent: true,
});
register({
  method: 'post',
  path: '/access-grants',
  summary: 'Grant one permission on an existing relationship',
  requirements: 'SPK-IAM-003',
  body: CreateAccessGrantBody,
  response: AccessGrantSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/access-grants/{id}/revoke',
  summary: 'Revoke a grant; takes effect on every subsequent authority check',
  requirements: 'SPK-IAM-006',
  params: IdParams,
  body: RevokeAccessGrantBody,
  response: AccessGrantSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/invitations',
  summary:
    'Invite a person to hold permissions over a scope; the secret is returned once and a replay answers IDEMPOTENCY_SECRET_WITHHELD',
  requirements: 'SPK-IAM-004',
  body: CreateInvitationBody,
  response: InvitationIssuedResponse,
  idempotent: true,
});
register({
  method: 'post',
  path: '/invitations/{id}/accept',
  summary: 'Accept an invitation as its recipient; grants only the authorized scope',
  requirements: 'SPK-IAM-004',
  params: IdParams,
  body: AcceptInvitationBody,
  response: InvitationAcceptedResponse,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/invitations/{id}/revoke',
  summary: 'Revoke a pending invitation',
  requirements: 'SPK-IAM-004',
  params: IdParams,
  body: RevokeInvitationBody,
  response: InvitationSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/staff-memberships',
  summary: 'Assign time-bounded staff roles to a person',
  requirements: '§2.1, §4.14',
  body: CreateStaffMembershipBody,
  response: StaffMembershipSchema,
  idempotent: true,
});
register({
  method: 'patch',
  path: '/staff-memberships/{id}',
  summary: 'Change roles, facility scope or end date of a staff membership',
  requirements: '§2.1, §4.9',
  params: IdParams,
  body: UpdateStaffMembershipBody,
  response: StaffMembershipSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/staff-memberships/{id}/end',
  summary: 'End a staff membership immediately',
  requirements: '§2.1, SPK-IAM-006',
  params: IdParams,
  body: EndStaffMembershipBody,
  response: StaffMembershipSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/access-reviews',
  summary: 'Open a disputed-access review',
  requirements: 'SPK-IAM-005',
  body: OpenAccessReviewBody,
  response: AccessReviewSchema,
  idempotent: true,
});
register({
  method: 'get',
  path: '/access-reviews/{id}',
  summary: 'Read an access review and its decision history',
  requirements: 'SPK-IAM-005',
  params: IdParams,
  response: AccessReviewSchema,
});
register({
  method: 'post',
  path: '/access-reviews/{id}/decisions',
  summary: 'Record a review decision (restrict, lift, escalate, decide, close, note, reassign)',
  requirements: 'SPK-IAM-005',
  params: IdParams,
  body: AccessReviewDecisionBody,
  response: AccessReviewSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/duplicate-candidates',
  summary: 'Flag two people as a duplicate candidate for review',
  requirements: 'SPK-IAM-007',
  body: FlagDuplicateBody,
  response: DuplicateCandidateSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/duplicate-candidates/{id}/merge',
  summary: 'Merge the candidate pair into the survivor without importing unverified permissions',
  requirements: 'SPK-IAM-007',
  params: IdParams,
  body: MergeDuplicateBody,
  response: PersonMergeSchema,
  idempotent: true,
});
register({
  method: 'post',
  path: '/duplicate-candidates/{id}/dismiss',
  summary: 'Dismiss a duplicate candidate',
  requirements: 'SPK-IAM-007',
  params: IdParams,
  body: DismissDuplicateBody,
  response: DuplicateCandidateSchema,
  status: 200,
  idempotent: true,
});
register({
  method: 'post',
  path: '/dev/tokens',
  summary:
    'Mint a bearer token for an existing account (local identity provider only; 404 otherwise)',
  requirements: '§5.2 (development only)',
  body: DevTokenBody,
  response: DevTokenResponse,
  security: [],
});
