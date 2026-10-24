import { defineEvent, z, GrantPermissionSchema, PersonKindSchema } from '@sportspark/contracts';

/**
 * Identity domain events (§4.12). Payloads never carry names or dates of birth: consumers look
 * the person up through the identity public API when they are authorized to (§4.14).
 */
export const IdentityEvents = {
  personCreated: defineEvent(
    'identity.person_created',
    z.object({ personId: z.uuid(), kind: PersonKindSchema, source: z.string() }),
  ),
  personUpdated: defineEvent(
    'identity.person_updated',
    z.object({ personId: z.uuid(), revision: z.number().int() }),
  ),
  accountLinked: defineEvent(
    'identity.account_linked',
    z.object({ accountId: z.uuid(), personId: z.uuid(), via: z.enum(['staff', 'claim', 'merge']) }),
  ),
  accountRelinked: defineEvent(
    'identity.account_relinked',
    z.object({ accountId: z.uuid(), personId: z.uuid().nullable() }),
  ),
  relationshipCreated: defineEvent(
    'identity.relationship_created',
    z.object({
      relationshipId: z.uuid(),
      actorPersonId: z.uuid(),
      subjectPersonId: z.uuid(),
      kind: z.string(),
      source: z.string(),
    }),
  ),
  accessGranted: defineEvent(
    'identity.access_granted',
    z.object({
      grantId: z.uuid(),
      relationshipId: z.uuid(),
      actorPersonId: z.uuid(),
      subjectPersonId: z.uuid(),
      permission: GrantPermissionSchema,
      source: z.string(),
    }),
  ),
  /** SPK-IAM-006: communications re-evaluates unsent protected messages for (actor, subject). */
  accessGrantRevoked: defineEvent(
    'identity.access_grant_revoked',
    z.object({
      grantId: z.uuid(),
      actorPersonId: z.uuid(),
      subjectPersonId: z.uuid(),
      permission: GrantPermissionSchema,
      reason: z.string(),
    }),
  ),
  accessRestricted: defineEvent(
    'identity.access_restricted',
    z.object({
      reviewId: z.uuid(),
      subjectPersonId: z.uuid(),
      grantIds: z.array(z.uuid()),
      actorPersonIds: z.array(z.uuid()),
    }),
  ),
  accessRestrictionLifted: defineEvent(
    'identity.access_restriction_lifted',
    z.object({ reviewId: z.uuid(), subjectPersonId: z.uuid(), grantIds: z.array(z.uuid()) }),
  ),
  invitationCreated: defineEvent(
    'identity.invitation_created',
    z.object({
      invitationId: z.uuid(),
      recipientPersonId: z.uuid().nullable(),
      recipientContactKind: z.string().nullable(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  invitationAccepted: defineEvent(
    'identity.invitation_accepted',
    z.object({
      invitationId: z.uuid(),
      acceptedByPersonId: z.uuid(),
      grantIds: z.array(z.uuid()),
      droppedPermissions: z.array(GrantPermissionSchema),
    }),
  ),
  invitationRevoked: defineEvent(
    'identity.invitation_revoked',
    z.object({ invitationId: z.uuid(), reason: z.string() }),
  ),
  claimIssued: defineEvent(
    'identity.claim_issued',
    z.object({ claimId: z.uuid(), subjectPersonId: z.uuid(), kind: z.string() }),
  ),
  claimRevoked: defineEvent(
    'identity.claim_revoked',
    z.object({ claimId: z.uuid(), subjectPersonId: z.uuid(), reason: z.string() }),
  ),
  claimAccepted: defineEvent(
    'identity.claim_accepted',
    z.object({
      claimId: z.uuid(),
      subjectPersonId: z.uuid(),
      accountId: z.uuid(),
      personId: z.uuid(),
      kind: z.string(),
    }),
  ),
  staffMembershipChanged: defineEvent(
    'identity.staff_membership_changed',
    z.object({
      membershipId: z.uuid(),
      personId: z.uuid(),
      status: z.enum(['active', 'ended']),
      roles: z.array(z.string()),
    }),
  ),
  accessReviewOpened: defineEvent(
    'identity.access_review_opened',
    z.object({ reviewId: z.uuid(), subjectPersonId: z.uuid(), ownerRole: z.string() }),
  ),
  accessReviewDecided: defineEvent(
    'identity.access_review_decided',
    z.object({
      reviewId: z.uuid(),
      subjectPersonId: z.uuid(),
      kind: z.string(),
      status: z.string(),
    }),
  ),
  duplicateCandidateFlagged: defineEvent(
    'identity.duplicate_candidate_flagged',
    z.object({
      candidateId: z.uuid(),
      personAId: z.uuid(),
      personBId: z.uuid(),
      score: z.number(),
    }),
  ),
  /** Other modules re-point their person references from mergedPersonId to survivorPersonId. */
  personsMerged: defineEvent(
    'identity.persons_merged',
    z.object({
      mergeId: z.uuid(),
      survivorPersonId: z.uuid(),
      mergedPersonId: z.uuid(),
      operationId: z.uuid(),
    }),
  ),
} as const;
