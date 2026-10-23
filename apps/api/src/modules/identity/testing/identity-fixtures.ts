import { newId, type StaffRole } from '@sportspark/contracts';
import { json, type Db, type GrantPermissionValue, type RelationshipKind } from '@sportspark/db';
import type { AppConfig, Clock, LocalJwtIdentityProvider } from '../../../kernel';

/**
 * Identity fixtures for downstream module tests. They write realistic rows directly through
 * Kysely (fast, no HTTP) and mint tokens that resolve through the REAL principal resolver, so use
 * them with `createTestApp({ imports: [IdentityModule, ...], principalResolver: 'module' })`.
 * The context is structural: a `TestApp` from apps/api/src/testing satisfies it.
 */
export interface IdentityFixtureContext {
  db: Db;
  clock: Clock;
  config: AppConfig;
  identityProvider: LocalJwtIdentityProvider;
  organizationId: string;
}

const SYSTEM_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

export const ALL_PERMISSIONS: readonly GrantPermissionValue[] = [
  'view',
  'register',
  'pay',
  'receive_messages',
  'complete_forms',
  'collect',
];

export interface CreatePersonFixture {
  kind: 'adult' | 'child';
  givenName?: string;
  familyName?: string;
  dateOfBirth?: string | null;
  source?: 'staff' | 'self_service' | 'import';
  createdByPersonId?: string | null;
  organizationId?: string;
  status?: 'active' | 'inactive';
}

let counter = 0;
const next = (): number => (counter += 1);

export async function createPersonFixture(
  ctx: IdentityFixtureContext,
  input: CreatePersonFixture,
): Promise<string> {
  const id = newId();
  const n = next();
  await ctx.db
    .insertInto('persons')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      kind: input.kind,
      given_name: input.givenName ?? (input.kind === 'adult' ? `Adult${n}` : `Child${n}`),
      family_name: input.familyName ?? `Family${n}`,
      date_of_birth:
        input.dateOfBirth === undefined
          ? input.kind === 'adult'
            ? '1985-04-12'
            : '2016-09-03'
          : input.dateOfBirth,
      status: input.status ?? 'active',
      merged_into_person_id: null,
      source: input.source ?? 'staff',
      created_by: json(SYSTEM_ACTOR),
      created_by_person_id: input.createdByPersonId ?? null,
    })
    .execute();
  return id;
}

export interface CreateAccountFixture {
  personId: string | null;
  organizationId?: string;
  issuer?: string;
  subject?: string;
  status?: 'active' | 'disabled';
}

/** Creates an account whose (issuer, subject) the local identity provider will mint tokens for. */
export async function createAccountFixture(
  ctx: IdentityFixtureContext,
  input: CreateAccountFixture,
): Promise<{ id: string; issuer: string; subject: string }> {
  const id = newId();
  const issuer = input.issuer ?? ctx.config.AUTH_ISSUER;
  const subject = input.subject ?? id;
  const disabled = input.status === 'disabled';
  await ctx.db
    .insertInto('accounts')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      issuer,
      subject,
      person_id: input.personId,
      status: disabled ? 'disabled' : 'active',
      last_login_at: null,
      disabled_at: disabled ? ctx.clock.now() : null,
      disabled_reason: disabled ? 'fixture' : null,
    })
    .execute();
  return { id, issuer, subject };
}

export async function createContactPointFixture(
  ctx: IdentityFixtureContext,
  input: {
    personId: string;
    kind: 'email' | 'phone';
    value: string;
    verified?: boolean;
    isPrimary?: boolean;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('contact_points')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      person_id: input.personId,
      kind: input.kind,
      value: input.kind === 'email' ? input.value.trim().toLowerCase() : input.value,
      is_primary: input.isPrimary ?? true,
      verified_at: input.verified ? ctx.clock.now() : null,
    })
    .execute();
  return id;
}

export interface CreateRelationshipFixture {
  actorPersonId: string;
  subjectPersonId: string;
  kind?: RelationshipKind;
  permissions?: readonly GrantPermissionValue[];
  source?: 'staff' | 'self_service' | 'invitation' | 'claim' | 'review' | 'import';
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  organizationId?: string;
}

/** A relationship plus one explicit grant per permission (none implied). */
export async function createRelationshipFixture(
  ctx: IdentityFixtureContext,
  input: CreateRelationshipFixture,
): Promise<{ relationshipId: string; grantIds: Partial<Record<GrantPermissionValue, string>> }> {
  const relationshipId = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const effectiveFrom = input.effectiveFrom ?? ctx.clock.now();
  const effectiveTo = input.effectiveTo ?? null;
  await ctx.db
    .insertInto('relationships')
    .values({
      id: relationshipId,
      organization_id: organizationId,
      actor_person_id: input.actorPersonId,
      subject_person_id: input.subjectPersonId,
      kind: input.kind ?? 'guardian',
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      source: input.source ?? 'staff',
      created_by: json(SYSTEM_ACTOR),
      ended_at: null,
      ended_reason: null,
    })
    .execute();
  const grantIds: Partial<Record<GrantPermissionValue, string>> = {};
  for (const permission of input.permissions ?? ALL_PERMISSIONS) {
    const id = newId();
    await ctx.db
      .insertInto('access_grants')
      .values({
        id,
        organization_id: organizationId,
        relationship_id: relationshipId,
        actor_person_id: input.actorPersonId,
        subject_person_id: input.subjectPersonId,
        permission,
        source: input.source ?? 'staff',
        granted_by: json(SYSTEM_ACTOR),
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        revoked_at: null,
        revoked_by: null,
        revocation_reason: null,
        suspended_at: null,
        suspended_by_review_id: null,
        suspension_reason: null,
      })
      .execute();
    grantIds[permission] = id;
  }
  return { relationshipId, grantIds };
}

export interface CreateStaffMemberFixture {
  roles: StaffRole[];
  facilityIds?: string[];
  /** Reuse an existing person (e.g. a parent who is also a coach); otherwise one is created. */
  personId?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  organizationId?: string;
}

/** A staff member: adult person (unless given), active account, and a time-bounded membership. */
export async function createStaffMemberFixture(
  ctx: IdentityFixtureContext,
  input: CreateStaffMemberFixture,
): Promise<{ personId: string; accountId: string; membershipId: string }> {
  const organizationId = input.organizationId ?? ctx.organizationId;
  const personId =
    input.personId ?? (await createPersonFixture(ctx, { kind: 'adult', organizationId }));
  const existing = await ctx.db
    .selectFrom('accounts')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('person_id', '=', personId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  const accountId =
    existing?.id ?? (await createAccountFixture(ctx, { personId, organizationId })).id;
  const membershipId = newId();
  await ctx.db
    .insertInto('staff_memberships')
    .values({
      id: membershipId,
      organization_id: organizationId,
      person_id: personId,
      roles: input.roles,
      facility_ids: input.facilityIds ?? [],
      effective_from: input.effectiveFrom ?? ctx.clock.now(),
      effective_to: input.effectiveTo ?? null,
      ended_at: null,
      ended_reason: null,
      created_by: json(SYSTEM_ACTOR),
    })
    .execute();
  return { personId, accountId, membershipId };
}

export interface OrganizationPeople {
  /** Adult customer with an active account and full guardian grants over `child`. */
  adult: { personId: string; accountId: string };
  child: { personId: string };
  relationshipId: string;
  guardianGrants: Partial<Record<GrantPermissionValue, string>>;
  /** Staff member (adult person + account + membership) with the requested roles. */
  staff: { personId: string; accountId: string; membershipId: string; roles: StaffRole[] };
}

/** The standard cast: a parent with an account, their child, the guardian grants, and a staff member. */
export async function createOrganizationPeople(
  ctx: IdentityFixtureContext,
  options: {
    guardianPermissions?: readonly GrantPermissionValue[];
    staffRoles?: StaffRole[];
    staffFacilityIds?: string[];
    organizationId?: string;
  } = {},
): Promise<OrganizationPeople> {
  const organizationId = options.organizationId ?? ctx.organizationId;
  const adultPersonId = await createPersonFixture(ctx, { kind: 'adult', organizationId });
  const adultAccount = await createAccountFixture(ctx, { personId: adultPersonId, organizationId });
  const childPersonId = await createPersonFixture(ctx, {
    kind: 'child',
    familyName: 'Shared',
    organizationId,
  });
  const relationship = await createRelationshipFixture(ctx, {
    actorPersonId: adultPersonId,
    subjectPersonId: childPersonId,
    permissions: options.guardianPermissions ?? ALL_PERMISSIONS,
    organizationId,
  });
  const staffRoles = options.staffRoles ?? ['front_desk'];
  const staff = await createStaffMemberFixture(ctx, {
    roles: staffRoles,
    facilityIds: options.staffFacilityIds,
    organizationId,
  });
  return {
    adult: { personId: adultPersonId, accountId: adultAccount.id },
    child: { personId: childPersonId },
    relationshipId: relationship.relationshipId,
    guardianGrants: relationship.grantIds,
    staff: { ...staff, roles: staffRoles },
  };
}

/** Mints a bearer token that the real resolver maps to this account. */
export async function tokenForAccount(
  ctx: IdentityFixtureContext,
  accountId: string,
  sessionId: string = newId(),
): Promise<string> {
  const account = await ctx.db
    .selectFrom('accounts')
    .select(['issuer', 'subject'])
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  if (account.issuer !== ctx.config.AUTH_ISSUER) {
    throw new Error(`account ${accountId} is not issued by the local identity provider`);
  }
  return ctx.identityProvider.mint({ subject: account.subject, sessionId });
}

/** Mints a token for the person's active account (throws when they have none). */
export async function tokenForPerson(
  ctx: IdentityFixtureContext,
  personId: string,
): Promise<string> {
  const account = await ctx.db
    .selectFrom('accounts')
    .select('id')
    .where('person_id', '=', personId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!account) throw new Error(`person ${personId} has no active account`);
  return tokenForAccount(ctx, account.id);
}

export async function authHeaderForPerson(
  ctx: IdentityFixtureContext,
  personId: string,
): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await tokenForPerson(ctx, personId)}` };
}

export async function authHeaderForAccount(
  ctx: IdentityFixtureContext,
  accountId: string,
): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await tokenForAccount(ctx, accountId)}` };
}
