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
  type Principal,
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
  Db,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import type { ActionDefinition, AuthorizationService, RequestWithContext, Trx } from '../../kernel';
import { IdentityActions } from './identity.actions';
import { allowedReviewDecisions } from './identity.machines';

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
  /**
   * End of a temporary restriction (SPK-IAM-005, migration 0102). Null or absent: the suspension
   * lasts until a `lift` decision.
   */
  suspended_until?: Date | string | null;
}

/** SPK-IAM-005: a suspension holds from `suspended_at` until `suspended_until` (or a lift). */
export function isSuspendedAt(
  grant: Pick<GrantEffectivityRow, 'suspended_at' | 'suspended_until'>,
  now: Date,
): boolean {
  if (grant.suspended_at === null) return false;
  const until = grant.suspended_until ?? null;
  return until === null || new Date(until).getTime() > now.getTime();
}

/** SPK-IAM-003/005/006: a grant confers authority only while unrevoked, unsuspended and within dates. */
export function isGrantEffective(
  grant: GrantEffectivityRow,
  relationshipStatus: 'active' | 'suspended' | 'ended',
  now: Date,
): boolean {
  if (grant.revoked_at !== null || isSuspendedAt(grant, now)) return false;
  if (relationshipStatus !== 'active') return false;
  return isWithinEffectiveDates(grant, now);
}

/**
 * SPK-IAM-001/003 and acceptance example 3 (a coach who is also a parent receives each permission
 * only in its proper scope): true only when a staff role of the principal covers the action in
 * this organization, or the principal is the system. A staff principal whose roles do not cover
 * the action is treated like any other person, so their own self and guardian authority applies
 * and nothing more. Services branch on this, never on `principal.kind`.
 */
export async function staffAuthorityApplies(
  authorization: Pick<AuthorizationService, 'decide'>,
  principal: Principal,
  action: ActionDefinition,
  organizationId: string,
): Promise<boolean> {
  if (principal.kind === 'system') return principal.organizationId === organizationId;
  if (principal.kind !== 'staff') return false;
  // No subjects and no team entry: decide() can only allow on the staff-role basis.
  const decision = await authorization.decide(principal, action, {
    type: action.id,
    organizationId,
  });
  return decision.allowed;
}

/**
 * §4.14, SPK-AT-025: whether a person holds a staff membership that is in force or scheduled to
 * start (`effective_from` is deliberately not compared with now, so a future-dated assignment
 * counts too).
 */
export async function holdsStaffMembership(
  db: Db,
  organizationId: string,
  personId: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom('staff_memberships')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('person_id', '=', personId)
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * §4.14 (least privilege, privileged staff), SPK-AT-025, SPK-IAM-002: taking control of the login
 * of a person who holds a staff membership (provisioning an account linked to them, recovering
 * theirs onto another provider identity, or issuing a self claim on them) needs the authority that
 * assigns staff roles (`identity.manage_staff_membership`). Otherwise a role that cannot grant
 * staff roles (support, front desk) could take over an account that can, and then grant itself
 * more. Verification evidence, rate limits and a second approver for recovery stay pending
 * (DEC-018 recovery, DEC-091 privileged multifactor authentication).
 */
export async function requireStaffLoginAuthority(
  authorization: Pick<AuthorizationService, 'require'>,
  db: Db,
  principal: Principal,
  organizationId: string,
  personId: string | null | undefined,
  now: Date,
): Promise<void> {
  if (!personId || !(await holdsStaffMembership(db, organizationId, personId, now))) return;
  await authorization.require(principal, IdentityActions.manageStaffMembership, {
    type: 'staff_membership',
    organizationId,
  });
}

/**
 * SPK-AT-025, §4.14: a self claim on a person who holds a staff membership is honoured only when
 * whoever issued it held a role that assigns staff roles (a membership may be added after a support
 * or front-desk claim was issued).
 */
export function claimIssuerAssignsStaffRoles(issuedBy: unknown): boolean {
  const roles = (issuedBy as { kind?: unknown; staffRoles?: unknown } | null)?.staffRoles;
  if ((issuedBy as { kind?: unknown } | null)?.kind === 'system') return true;
  return (
    Array.isArray(roles) &&
    roles.some((role) =>
      (IdentityActions.manageStaffMembership.staffRoles as readonly unknown[]).includes(role),
    )
  );
}

export function normalizeContactValue(kind: 'email' | 'phone', value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, '');
}

/**
 * The name shown for a person (ID-01, IF-09): given then family name. Presentation order by
 * locale is a client concern; this is the one server-side rendering.
 */
export function displayNameOf(givenName: string, familyName: string): string {
  return `${givenName} ${familyName}`.trim();
}

/** Display names of people in the organization, by id (unknown ids are absent). */
export async function displayNamesOf(
  db: Db | Trx,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('persons')
    .select(['id', 'given_name', 'family_name'])
    .where('organization_id', '=', organizationId)
    .where('id', 'in', unique)
    .execute();
  return new Map(rows.map((r) => [r.id, displayNameOf(r.given_name, r.family_name)]));
}

/**
 * A contact value with most characters hidden (ID-04, ID-06, §4.14): enough for staff to tell two
 * contact points apart or for an audit record to name the change, never the full address.
 * `ann.smith@example.com` → `a***@example.com`; `+15551234567` → `***4567`.
 */
export function maskContactValue(kind: 'email' | 'phone', value: string): string {
  if (kind === 'email') {
    const at = value.lastIndexOf('@');
    if (at <= 0) return '***';
    return `${value.slice(0, 1)}***${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`;
}

/** Escapes LIKE wildcards so a search term matches literally (`\` is PostgreSQL's default escape). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Port inputs from other modules are not validated by a pipe: unknown shapes are simply absent. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
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
    declinedAt: isoOrNull(row.declined_at),
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
    recipientContact:
      row.recipient_contact_kind && row.recipient_contact_value
        ? { kind: row.recipient_contact_kind, value: row.recipient_contact_value }
        : null,
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
      bySystem: (d.decided_by as { kind?: unknown } | null)?.kind === 'system',
      occurredAt: iso(d.occurred_at),
    })),
    allowedDecisions: allowedReviewDecisions(row.status),
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
