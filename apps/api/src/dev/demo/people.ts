import type { Principal, StaffRole } from '@sportspark/contracts';
import { UnitOfWork } from '../../kernel/database/unit-of-work';
import {
  AccountsService,
  ALL_PERMISSIONS,
  AuthorityReadsService,
  HouseholdsService,
  PeopleService,
  RelationshipAuthority,
  RelationshipsService,
  StaffMembershipsService,
} from '../../modules/identity';
import { principalOf, requirePrincipal, service, type DemoContext } from './context';

/**
 * The sample people of the demo (ADR-007). Every name is invented, every address ends in
 * `example.test` and every phone number is in the 555-01xx range reserved for fiction. A child
 * record carries a name and a date of birth, nothing else. Adults are found again by the subject
 * of their local account; children by their name under their guardian.
 */
export interface DemoAdult {
  subject: string;
  personId: string;
  accountId: string;
  principal: Principal;
}

export interface DemoFamily {
  key: string;
  adult: DemoAdult;
  children: Array<{ personId: string; givenName: string }>;
}

interface AdultSpec {
  subject: string;
  givenName: string;
  familyName: string;
  phone?: string;
}

/**
 * An adult's date of birth, steady for a subject and between 24 and 41 years before the year the
 * dataset is built. The league's divisions state an adult age band (a competition is public only
 * when every division does, SPK-SCHED-010), and a division with an age band needs a date of birth
 * for each rostered player.
 */
function adultBirthDate(ctx: DemoContext, subject: string): string {
  const spread = [...subject].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 18;
  return `${ctx.clock.now().getUTCFullYear() - 25 - spread}-06-15`;
}

/** Gives a seeded adult a date of birth when they have none (idempotent). */
export async function ensureAdultBirthDate(
  ctx: DemoContext,
  personId: string,
  subject: string,
): Promise<void> {
  const people = service(ctx, PeopleService);
  const person = await people.getPerson(ctx.system, personId);
  if (person.dateOfBirth) return;
  await people.updatePerson(
    ctx.system,
    personId,
    {
      dateOfBirth: adultBirthDate(ctx, subject),
      expectedRevision: person.revision,
      policyReferences: [],
    },
    null,
  );
}

async function ensureAdult(ctx: DemoContext, spec: AdultSpec): Promise<DemoAdult> {
  const existing = await principalOf(ctx, spec.subject);
  if (existing?.personId && existing.accountId) {
    await ensureAdultBirthDate(ctx, existing.personId, spec.subject);
    return {
      subject: spec.subject,
      personId: existing.personId,
      accountId: existing.accountId,
      principal: existing,
    };
  }
  const person = await service(ctx, PeopleService).createPerson(
    ctx.system,
    {
      kind: 'adult',
      givenName: spec.givenName,
      familyName: spec.familyName,
      dateOfBirth: adultBirthDate(ctx, spec.subject),
      contactPoints: [
        {
          kind: 'email',
          value: `${spec.subject}@example.test`,
          isPrimary: true,
          verified: true,
        },
        ...(spec.phone
          ? [{ kind: 'phone' as const, value: spec.phone, isPrimary: true, verified: true }]
          : []),
      ],
    },
    null,
  );
  await service(ctx, AccountsService).createAccount(
    ctx.system,
    { issuer: ctx.config.AUTH_ISSUER, subject: spec.subject, personId: person.id },
    null,
  );
  const principal = await requirePrincipal(ctx, spec.subject);
  return {
    subject: spec.subject,
    personId: person.id,
    accountId: principal.accountId as string,
    principal,
  };
}

/** The staff who set the facility up and run it in the demo, beyond the six sign-in accounts. */
export interface DemoStaff {
  admin: DemoAdult;
  desk: DemoAdult;
  league: DemoAdult;
  coach: DemoAdult;
  official: DemoAdult;
  /** General manager, also program manager, finance operator, scheduler and facilities operator. */
  manager: DemoAdult;
  /** A second coach and a second official, so assignments have more than one name. */
  secondCoach: DemoAdult;
  secondOfficial: DemoAdult;
}

async function ensureStaff(
  ctx: DemoContext,
  spec: AdultSpec,
  roles: readonly StaffRole[],
): Promise<DemoAdult> {
  const adult = await ensureAdult(ctx, spec);
  const missing = roles.filter((role) => !adult.principal.staffRoles.includes(role));
  if (missing.length === 0) return adult;
  await service(ctx, StaffMembershipsService).create(
    ctx.system,
    { personId: adult.personId, roles: [...missing], facilityIds: [], policyReferences: [] },
    null,
  );
  return { ...adult, principal: await requirePrincipal(ctx, spec.subject) };
}

export async function seedStaff(ctx: DemoContext): Promise<DemoStaff> {
  const people = service(ctx, PeopleService);
  const seeded = async (subject: string): Promise<DemoAdult> => {
    const principal = await requirePrincipal(ctx, subject);
    // The development seed gives its accounts no contact point; without one every notice to them
    // is an undeliverable email and an exception for the front desk.
    const person = await people.getPerson(ctx.system, principal.personId as string);
    if (person.contactPoints.length === 0) {
      await people.addContactPoint(
        ctx.system,
        person.id,
        { kind: 'email', value: `${subject}@example.test`, isPrimary: true, verified: true },
        null,
      );
    }
    return {
      subject,
      personId: principal.personId as string,
      accountId: principal.accountId as string,
      principal,
    };
  };
  return {
    admin: await seeded('dev-admin'),
    desk: await seeded('dev-desk'),
    league: await seeded('dev-league'),
    coach: await seeded('dev-coach'),
    official: await seeded('dev-official'),
    manager: await ensureStaff(
      ctx,
      { subject: 'demo-manager', givenName: 'Morgan', familyName: 'Sample-Reyes' },
      [
        'general_manager',
        'program_manager',
        'finance_operator',
        'scheduler',
        'facilities_operator',
      ],
    ),
    secondCoach: await ensureStaff(
      ctx,
      { subject: 'demo-coach-2', givenName: 'Riley', familyName: 'Sample-Okafor' },
      ['coach'],
    ),
    secondOfficial: await ensureStaff(
      ctx,
      { subject: 'demo-official-2', givenName: 'Jordan', familyName: 'Sample-Lindqvist' },
      ['official'],
    ),
  };
}

/** Twelve households: one adult with a sign-in subject, and one or two children. */
const FAMILIES: ReadonlyArray<{
  key: string;
  adult: [string, string];
  phone: string;
  children: ReadonlyArray<[string, number]>;
}> = [
  { key: 'alder', adult: ['Priya', 'Alder'], phone: '+17025550101', children: [['Kiran', 8]] },
  {
    key: 'birch',
    adult: ['Tomas', 'Birch'],
    phone: '+17025550102',
    children: [
      ['Lena', 9],
      ['Milo', 7],
    ],
  },
  { key: 'cedar', adult: ['Amara', 'Cedar'], phone: '+17025550103', children: [['Zuri', 10]] },
  { key: 'dune', adult: ['Hiro', 'Dune'], phone: '+17025550104', children: [['Sora', 8]] },
  {
    key: 'elm',
    adult: ['Nadia', 'Elm'],
    phone: '+17025550105',
    children: [
      ['Omar', 11],
      ['Layla', 6],
    ],
  },
  { key: 'fern', adult: ['Caleb', 'Fern'], phone: '+17025550106', children: [['Ivy', 9]] },
  { key: 'grove', adult: ['Lucia', 'Grove'], phone: '+17025550107', children: [['Mateo', 7]] },
  { key: 'heath', adult: ['Owen', 'Heath'], phone: '+17025550108', children: [['Nora', 10]] },
  { key: 'isle', adult: ['Fatima', 'Isle'], phone: '+17025550109', children: [['Idris', 8]] },
  { key: 'juniper', adult: ['Ben', 'Juniper'], phone: '+17025550110', children: [['Tess', 9]] },
  { key: 'kestrel', adult: ['Mei', 'Kestrel'], phone: '+17025550111', children: [['Jun', 7]] },
];

/** A date of birth that makes the child `age` years old today, on a fixed day of the year. */
function birthDate(today: string, age: number): string {
  const year = Number(today.slice(0, 4)) - age - 1;
  return `${year}-12-01`;
}

async function ensureChildren(
  ctx: DemoContext,
  adult: DemoAdult,
  familyName: string,
  children: ReadonlyArray<[string, number]>,
  today: string,
): Promise<Array<{ personId: string; givenName: string }>> {
  const people = service(ctx, PeopleService);
  const authorities = await service(ctx, RelationshipAuthority).authoritiesOf(
    ctx.organizationId,
    adult.personId,
  );
  const names = await people.personNames(
    ctx.system,
    authorities.map((a) => a.subjectPersonId),
  );
  const out: Array<{ personId: string; givenName: string }> = [];
  for (const [givenName, age] of children) {
    const known = names.find((n) => n.givenName === givenName && n.familyName === familyName);
    if (known) {
      out.push({ personId: known.personId, givenName });
      continue;
    }
    const child = await people.createPerson(
      ctx.system,
      {
        kind: 'child',
        givenName,
        familyName,
        dateOfBirth: birthDate(today, age),
        contactPoints: [],
      },
      null,
    );
    await service(ctx, UnitOfWork).run(({ trx }) =>
      service(ctx, RelationshipsService).ensureAuthority(trx, ctx.system, ctx.organizationId, {
        actorPersonId: adult.personId,
        subjectPersonId: child.id,
        kind: 'guardian',
        permissions: ALL_PERMISSIONS,
        source: 'staff',
        correlationId: null,
      }),
    );
    out.push({ personId: child.id, givenName });
  }
  return out;
}

export async function seedFamilies(
  ctx: DemoContext,
  today: string,
  devChildPersonId: string,
): Promise<DemoFamily[]> {
  const families: DemoFamily[] = [];
  const households = service(ctx, HouseholdsService);
  const reads = service(ctx, AuthorityReadsService);
  /** One household per family, found again through the adult's own households. */
  const ensureHousehold = async (family: DemoFamily, name: string): Promise<void> => {
    if ((await reads.myHouseholds(family.adult.principal)).length > 0) return;
    const household = await households.createHousehold(ctx.system, { name }, null);
    for (const personId of [family.adult.personId, ...family.children.map((c) => c.personId)]) {
      await households.addMember(ctx.system, household.id, { personId }, null);
    }
  };
  for (const spec of FAMILIES) {
    const adult = await ensureAdult(ctx, {
      subject: `demo-family-${spec.key}`,
      givenName: spec.adult[0],
      familyName: spec.adult[1],
      phone: spec.phone,
    });
    const children = await ensureChildren(ctx, adult, spec.adult[1], spec.children, today);
    const family: DemoFamily = { key: spec.key, adult, children };
    await ensureHousehold(family, `${spec.adult[1]} household`);
    families.push(family);
  }
  // The seeded parent's household is the twelfth family (its child comes from the development seed).
  const parent = await requirePrincipal(ctx, 'dev-parent');
  const parentPerson = await service(ctx, PeopleService).getPerson(
    ctx.system,
    parent.personId as string,
  );
  if (parentPerson.contactPoints.length === 0) {
    await service(ctx, PeopleService).addContactPoint(
      ctx.system,
      parentPerson.id,
      { kind: 'email', value: 'dev-parent@example.test', isPrimary: true, verified: true },
      null,
    );
  }
  const seededFamily: DemoFamily = {
    key: 'dev',
    adult: {
      subject: 'dev-parent',
      personId: parent.personId as string,
      accountId: parent.accountId as string,
      principal: parent,
    },
    children: [{ personId: devChildPersonId, givenName: 'Dev' }],
  };
  await ensureHousehold(seededFamily, 'Dev household');
  families.push(seededFamily);
  return families;
}

/** Adults who play in the league or rent a field: an account each, no children. */
export async function seedAdults(
  ctx: DemoContext,
  specs: ReadonlyArray<{ key: string; givenName: string; familyName: string }>,
): Promise<Map<string, DemoAdult>> {
  const out = new Map<string, DemoAdult>();
  for (const spec of specs) {
    out.set(
      spec.key,
      await ensureAdult(ctx, {
        subject: `demo-adult-${spec.key}`,
        givenName: spec.givenName,
        familyName: spec.familyName,
      }),
    );
  }
  return out;
}
