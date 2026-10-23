import { createHash, randomBytes } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  errors,
  type AccessGrant,
  type AccessReview,
  type Account,
  type Claim,
  type ContactPoint,
  type DuplicateCandidate,
  type Household,
  type Invitation,
  type Person,
  type PersonMerge,
  type Relationship,
  type StaffMembership,
  type StaffRole,
} from '@sportspark/contracts';
import type {
  AccessGrantsTable,
  AccessReviewDecisionsTable,
  AccessReviewsTable,
  AccountsTable,
  ClaimsTable,
  ContactPointsTable,
  DuplicateCandidatesTable,
  HouseholdMembershipsTable,
  HouseholdsTable,
  InvitationsTable,
  PersonMergesTable,
  RelationshipsTable,
  StaffMembershipsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import type { RequestWithContext } from '../../kernel';

/** Correlation id assigned by the kernel middleware, for audit and outbox records. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

/**
 * Age at which a person is an adult for identity purposes. Policy default pending the operator's
 * "Guardian verification and child-account policy" decision (§6.6); configuration, not law.
 */
export const ADULT_AGE_YEARS = 18;

export function ageInYears(dateOfBirth: string, now: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  const monthDiff = now.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** Validates that a declared kind agrees with the date of birth when one is known (§4.5). */
export function assertKindMatchesDateOfBirth(
  kind: 'adult' | 'child',
  dateOfBirth: string | null | undefined,
  now: Date,
): void {
  if (!dateOfBirth) return;
  const age = ageInYears(dateOfBirth, now);
  if (age < 0) throw errors.validation('dateOfBirth cannot be in the future.');
  const derived = age < ADULT_AGE_YEARS ? 'child' : 'adult';
  if (derived !== kind) {
    throw errors.validation(`kind must be '${derived}' for this date of birth.`, {
      dateOfBirth,
      derivedKind: derived,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Tokens: only hashes are stored; the raw token is returned once to the issuer.
// ---------------------------------------------------------------------------------------------
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Effectiveness (pure, unit-tested): one rule shared by the port, the API and the fixtures.
// ---------------------------------------------------------------------------------------------
export interface Effectivity {
  effective_from: Date | string;
  effective_to: Date | string | null;
}

export function isWithinEffectiveDates(row: Effectivity, now: Date): boolean {
  const from = new Date(row.effective_from).getTime();
  const to =
    row.effective_to === null ? Number.POSITIVE_INFINITY : new Date(row.effective_to).getTime();
  const t = now.getTime();
  return from <= t && t < to;
}

export interface GrantEffectivityRow extends Effectivity {
  revoked_at: Date | string | null;
  suspended_at: Date | string | null;
}

/** SPK-IAM-003/006: a grant confers authority only while unrevoked, unsuspended and within dates. */
export function isGrantEffective(
  grant: GrantEffectivityRow,
  relationshipStatus: 'active' | 'suspended' | 'ended',
  now: Date,
): boolean {
  if (grant.revoked_at !== null || grant.suspended_at !== null) return false;
  if (relationshipStatus !== 'active') return false;
  return isWithinEffectiveDates(grant, now);
}

export function normalizeContactValue(kind: 'email' | 'phone', value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, '');
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------
export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : iso(value);

/** Columns for persons with the date cast both drivers return as `YYYY-MM-DD`. */
export const personColumns = [
  'persons.id',
  'persons.organization_id',
  'persons.kind',
  'persons.given_name',
  'persons.family_name',
  sql<string | null>`persons.date_of_birth::text`.as('date_of_birth'),
  'persons.status',
  'persons.merged_into_person_id',
  'persons.source',
  'persons.created_by_person_id',
  'persons.revision',
  'persons.created_at',
  'persons.updated_at',
] as const;

export interface PersonRow {
  id: string;
  organization_id: string;
  kind: 'adult' | 'child';
  given_name: string;
  family_name: string;
  date_of_birth: string | null;
  status: 'active' | 'inactive' | 'merged';
  merged_into_person_id: string | null;
  source: string;
  created_by_person_id: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    kind: row.kind,
    givenName: row.given_name,
    familyName: row.family_name,
    dateOfBirth: row.date_of_birth,
    status: row.status,
    mergedIntoPersonId: row.merged_into_person_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toContactPoint(row: Selectable<ContactPointsTable>): ContactPoint {
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    value: row.value,
    isPrimary: row.is_primary,
    verifiedAt: isoOrNull(row.verified_at),
    createdAt: iso(row.created_at),
  };
}

export function toAccount(row: Selectable<AccountsTable>): Account {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    personId: row.person_id,
    status: row.status,
    lastLoginAt: isoOrNull(row.last_login_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toHousehold(
  row: Selectable<HouseholdsTable>,
  members: Selectable<HouseholdMembershipsTable>[],
): Household {
  return {
    id: row.id,
    name: row.name,
    members: members.map((m) => ({ personId: m.person_id, label: m.label })),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toRelationship(row: Selectable<RelationshipsTable>): Relationship {
  return {
    id: row.id,
    actorPersonId: row.actor_person_id,
    subjectPersonId: row.subject_person_id,
    kind: row.kind,
    status: row.status,
    source: row.source,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toAccessGrant(
  row: Selectable<AccessGrantsTable>,
  relationshipStatus: 'active' | 'suspended' | 'ended',
  now: Date,
): AccessGrant {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    actorPersonId: row.actor_person_id,
    subjectPersonId: row.subject_person_id,
    permission: row.permission,
    source: row.source,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    revokedAt: isoOrNull(row.revoked_at),
    revocationReason: row.revocation_reason,
    suspendedAt: isoOrNull(row.suspended_at),
    suspendedByReviewId: row.suspended_by_review_id,
    effective: isGrantEffective(row, relationshipStatus, now),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toInvitation(row: Selectable<InvitationsTable>): Invitation {
  return {
    id: row.id,
    invitedByPersonId: row.invited_by_person_id,
    recipientPersonId: row.recipient_person_id,
    recipientContact:
      row.recipient_contact_kind && row.recipient_contact_value
        ? { kind: row.recipient_contact_kind, value: row.recipient_contact_value }
        : null,
    scope:
      row.scope_type === 'person'
        ? { type: 'person', personId: row.scope_person_id as string }
        : { type: 'household', householdId: row.scope_household_id as string },
    relationshipKind: row.relationship_kind,
    requestedPermissions: row.requested_permissions,
    grantedPermissions: row.granted_permissions,
    status: row.status,
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
    acceptedByPersonId: row.accepted_by_person_id,
    revokedAt: isoOrNull(row.revoked_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toClaim(row: Selectable<ClaimsTable>): Claim {
  return {
    id: row.id,
    subjectPersonId: row.subject_person_id,
    kind: row.kind,
    requestedPermissions: row.requested_permissions,
    status: row.status,
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
    acceptedByPersonId: row.accepted_by_person_id,
    revokedAt: isoOrNull(row.revoked_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toStaffMembership(row: Selectable<StaffMembershipsTable>): StaffMembership {
  return {
    id: row.id,
    personId: row.person_id,
    roles: row.roles as StaffRole[],
    facilityIds: row.facility_ids,
    status: row.status,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toAccessReview(
  row: Selectable<AccessReviewsTable>,
  decisions: Selectable<AccessReviewDecisionsTable>[],
): AccessReview {
  return {
    id: row.id,
    subjectPersonId: row.subject_person_id,
    reason: row.reason,
    parties: row.parties as AccessReview['parties'],
    evidence: row.evidence as AccessReview['evidence'],
    ownerRole: row.owner_role,
    ownerPersonId: row.owner_person_id,
    status: row.status,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    escalatedAt: isoOrNull(row.escalated_at),
    decidedAt: isoOrNull(row.decided_at),
    closedAt: isoOrNull(row.closed_at),
    outcome: row.outcome,
    decisions: decisions.map((d) => ({
      id: d.id,
      sequence: d.sequence,
      kind: d.kind,
      note: d.note,
      affectedGrantIds: d.affected_grant_ids,
      effectiveFrom: isoOrNull(d.effective_from),
      effectiveTo: isoOrNull(d.effective_to),
      occurredAt: iso(d.occurred_at),
    })),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toDuplicateCandidate(
  row: Selectable<DuplicateCandidatesTable>,
): DuplicateCandidate {
  return {
    id: row.id,
    personAId: row.person_a_id,
    personBId: row.person_b_id,
    reasons: row.reasons,
    score: row.score,
    status: row.status,
    decision: row.decision,
    decidedAt: isoOrNull(row.decided_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toPersonMerge(row: Selectable<PersonMergesTable>): PersonMerge {
  return {
    id: row.id,
    survivorPersonId: row.survivor_person_id,
    mergedPersonId: row.merged_person_id,
    candidateId: row.candidate_id,
    moved: row.moved,
    operationId: row.operation_id,
    occurredAt: iso(row.occurred_at),
  };
}

export function hoursFromNow(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 3600_000);
}
