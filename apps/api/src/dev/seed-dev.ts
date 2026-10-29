import type { INestApplicationContext } from '@nestjs/common';
import {
  DomainError,
  newId,
  systemPrincipal,
  type CapabilityId,
  type Principal,
  type StaffRole,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { APP_CONFIG, CLOCK, DATABASE } from '../kernel/tokens';
import type { AppConfig } from '../kernel/config';
import type { Clock } from '../kernel/clock';
import { UnitOfWork } from '../kernel/database/unit-of-work';
import { CapabilityService } from '../kernel/capabilities/capability.service';
import {
  AccountsService,
  ALL_PERMISSIONS,
  PeopleService,
  PrincipalResolver,
  RelationshipAuthority,
  RelationshipsService,
  StaffMembershipsService,
} from '../modules/identity';

/**
 * Development seed for local sign-in (K-14; §5.2 "domain work against tested adapters and
 * synthetic fixtures"). Everything it creates is synthetic: the organization `dev`, the facility
 * `dev-facility` (time zone from `--timezone`, default UTC; the real facilities are DEC-001) and
 * six local accounts. It writes only kernel tables itself (organization, facility, capability
 * switches through the kernel service); people, accounts, staff memberships and the guardian
 * relationship go through identity's exported services with a system principal. Idempotent by
 * natural keys: the organization and facility slugs and the accounts' (issuer, subject).
 */
export interface SeedOptions {
  timezone?: string;
  /** Capabilities to enable (recorded with DEC-016, reason 'local development'). Default none. */
  enable?: readonly CapabilityId[];
}

export interface SeededAccount {
  subject: string;
  accountId: string;
  personId: string;
  roles: StaffRole[];
}

export interface SeedSummary {
  organization: { id: string; slug: string };
  facility: { id: string; slug: string; timezone: string };
  accounts: SeededAccount[];
  child: { personId: string };
  enabledCapabilities: CapabilityId[];
  devTokens: { method: 'POST'; path: '/v1/dev/tokens'; body: { accountId: string } };
}

const ACCOUNTS: ReadonlyArray<{
  subject: string;
  givenName: string;
  familyName: string;
  role: StaffRole | null;
}> = [
  { subject: 'dev-admin', givenName: 'Dev', familyName: 'Admin', role: 'system_administrator' },
  { subject: 'dev-desk', givenName: 'Dev', familyName: 'Desk', role: 'front_desk' },
  { subject: 'dev-league', givenName: 'Dev', familyName: 'League', role: 'league_manager' },
  { subject: 'dev-coach', givenName: 'Dev', familyName: 'Coach', role: 'coach' },
  { subject: 'dev-official', givenName: 'Dev', familyName: 'Official', role: 'official' },
  { subject: 'dev-parent', givenName: 'Dev', familyName: 'Parent', role: null },
];

/** The seed runs only for local development and tests with the local identity provider. */
export function assertSeedAllowed(config: Pick<AppConfig, 'NODE_ENV' | 'AUTH_MODE'>): void {
  if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
    throw new Error(
      `seed:dev refuses NODE_ENV=${config.NODE_ENV}: it is for local development only`,
    );
  }
  if (config.AUTH_MODE !== 'local') {
    throw new Error(
      'seed:dev needs AUTH_MODE=local (its accounts sign in through POST /v1/dev/tokens)',
    );
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`--timezone ${timezone} is not an IANA time zone`);
  }
}

export async function seedDevelopment(
  app: INestApplicationContext,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const config = app.get<AppConfig>(APP_CONFIG);
  assertSeedAllowed(config);
  const timezone = options.timezone ?? 'UTC';
  assertTimezone(timezone);
  const db = app.get<Db>(DATABASE);
  const clock = app.get<Clock>(CLOCK);

  // Kernel tables: the synthetic organization and facility (DEC-001: the real ones are pending).
  let organization = await db
    .selectFrom('organizations')
    .select(['id', 'slug'])
    .where('slug', '=', 'dev')
    .executeTakeFirst();
  if (!organization) {
    organization = { id: newId(), slug: 'dev' };
    await db
      .insertInto('organizations')
      .values({ ...organization, name: 'Development organization (synthetic)' })
      .execute();
  }
  const organizationId = organization.id;
  let facility = await db
    .selectFrom('facilities')
    .select(['id', 'slug', 'timezone'])
    .where('organization_id', '=', organizationId)
    .where('slug', '=', 'dev-facility')
    .executeTakeFirst();
  if (!facility) {
    facility = { id: newId(), slug: 'dev-facility', timezone };
    await db
      .insertInto('facilities')
      .values({
        ...facility,
        organization_id: organizationId,
        name: 'Development facility (synthetic)',
        address: null,
      })
      .execute();
  }

  const system: Principal = systemPrincipal(organizationId, 'kernel.seed_dev');
  const people = app.get(PeopleService);
  const accounts = app.get(AccountsService);
  const memberships = app.get(StaffMembershipsService);
  const resolver = app.get(PrincipalResolver);
  const seeded: SeededAccount[] = [];
  for (const spec of ACCOUNTS) {
    const now = clock.now();
    const existing = await resolver.resolve({
      issuer: config.AUTH_ISSUER,
      subject: spec.subject,
      sessionId: null,
      issuedAt: now,
      expiresAt: now,
      claims: {},
    });
    if (existing && existing.organizationId !== organizationId) {
      throw new Error(`account ${spec.subject} belongs to another organization`);
    }
    let accountId = existing?.accountId ?? null;
    let personId = existing?.personId ?? null;
    if (!accountId || !personId) {
      const person = await people.createPerson(
        system,
        {
          kind: 'adult',
          givenName: spec.givenName,
          familyName: spec.familyName,
          contactPoints: [],
        },
        null,
      );
      personId = person.id;
      const account = await accounts.createAccount(
        system,
        { issuer: config.AUTH_ISSUER, subject: spec.subject, personId },
        null,
      );
      accountId = account.id;
    }
    const roles = [...(existing?.staffRoles ?? [])];
    if (spec.role && !roles.includes(spec.role)) {
      await memberships.create(system, { personId, roles: [spec.role], facilityIds: [] }, null);
      roles.push(spec.role);
    }
    seeded.push({ subject: spec.subject, accountId, personId, roles });
  }

  // A child under the parent's guardianship with the six grants (SPK-IAM-003).
  const parent = seeded.find((a) => a.subject === 'dev-parent');
  if (!parent) throw new Error('dev-parent was not seeded');
  const authorities = await app
    .get(RelationshipAuthority)
    .authoritiesOf(organizationId, parent.personId);
  let childId =
    authorities.find((a) => ALL_PERMISSIONS.every((p) => a.permissions.includes(p)))
      ?.subjectPersonId ?? null;
  if (!childId) {
    const child = await people.createPerson(
      system,
      { kind: 'child', givenName: 'Dev', familyName: 'Child', contactPoints: [] },
      null,
    );
    childId = child.id;
    const relationships = app.get(RelationshipsService);
    const subject = childId;
    await app.get(UnitOfWork).run(({ trx }) =>
      relationships.ensureAuthority(trx, system, organizationId, {
        actorPersonId: parent.personId,
        subjectPersonId: subject,
        kind: 'guardian',
        permissions: ALL_PERMISSIONS,
        source: 'staff',
        correlationId: null,
      }),
    );
  }

  const enabled: CapabilityId[] = [];
  const capabilities = app.get(CapabilityService);
  for (const capability of options.enable ?? []) {
    try {
      await capabilities.change(
        system,
        capability,
        'enable',
        { decisionReference: 'DEC-016', reason: 'local development' },
        null,
      );
    } catch (error) {
      // Already enabled by an earlier run: nothing to change.
      if (!(DomainError.is(error) && error.code === 'INVALID_TRANSITION')) throw error;
    }
    enabled.push(capability);
  }

  const admin = seeded[0] as SeededAccount;
  return {
    organization: { id: organizationId, slug: organization.slug },
    facility: { id: facility.id, slug: facility.slug, timezone: facility.timezone },
    accounts: seeded,
    child: { personId: childId },
    enabledCapabilities: enabled,
    devTokens: { method: 'POST', path: '/v1/dev/tokens', body: { accountId: admin.accountId } },
  };
}
