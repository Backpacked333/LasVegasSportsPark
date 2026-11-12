import type { AppConfig } from '../../kernel/config';
import { APP_CONFIG } from '../../kernel/tokens';
import { AccountsService } from '../../modules/identity';
import type { DemoSession } from './client';
import type { DemoContext, DemoStaffKey, DemoStaffSpec } from './context';

/**
 * Demo-only staff next to the six seeded accounts (K-14), which keep exactly their roles. Two are
 * needed: approving a cancellation policy takes a finance operator and approving a maintenance
 * restriction a facilities operator, roles none of the six holds (§2.1, the permission matrix).
 * The program manager is the responsible manager of the demo offerings and drafts their policies,
 * so no policy is approved by its author; the second coach and the officials take assignments;
 * the general manager and the support operator are there to sign in as. Names are synthetic.
 */
export const DEMO_STAFF: readonly DemoStaffSpec[] = [
  {
    key: 'program',
    subject: 'demo-program',
    givenName: 'Pat',
    familyName: 'Sample (demo program manager)',
    roles: ['program_manager', 'scheduler'],
  },
  {
    key: 'finance',
    subject: 'demo-finance',
    givenName: 'Finley',
    familyName: 'Sample (demo finance)',
    roles: ['finance_operator'],
  },
  {
    key: 'facilities',
    subject: 'demo-facilities',
    givenName: 'Frankie',
    familyName: 'Sample (demo facilities)',
    roles: ['facilities_operator'],
  },
  {
    key: 'manager',
    subject: 'demo-manager',
    givenName: 'Morgan',
    familyName: 'Sample (demo general manager)',
    roles: ['general_manager'],
  },
  {
    key: 'support',
    subject: 'demo-support',
    givenName: 'Sidney',
    familyName: 'Sample (demo support)',
    roles: ['support_operator'],
  },
  {
    key: 'coach2',
    subject: 'demo-coach-2',
    givenName: 'Cory',
    familyName: 'Sample (demo coach)',
    roles: ['coach'],
  },
  {
    key: 'official2',
    subject: 'demo-official-2',
    givenName: 'Ollie',
    familyName: 'Sample (demo official)',
    roles: ['official'],
  },
  {
    key: 'official3',
    subject: 'demo-official-3',
    givenName: 'Robin',
    familyName: 'Sample (demo official)',
    roles: ['official'],
  },
];

/** The seeded staff accounts' subjects by the key the demo uses for them. */
export const SEEDED_STAFF: Readonly<Record<string, DemoStaffKey>> = {
  'dev-admin': 'admin',
  'dev-desk': 'desk',
  'dev-league': 'league',
  'dev-coach': 'coach',
  'dev-official': 'official',
};

/**
 * Signs an existing local account in: the token `POST /v1/dev/tokens` would mint, obtained from
 * identity's exported service because that route allows ten tokens a minute per address and the
 * seed signs in more people than that.
 */
export function signInWith(ctx: Pick<DemoContext, 'app'>) {
  const accounts = ctx.app.get(AccountsService);
  return async (subject: string, accountId: string, personId: string): Promise<DemoSession> => {
    const minted = await accounts.mintDevToken(
      { accountId },
      { host: 'localhost', remoteAddress: '127.0.0.1', forwarded: false },
    );
    return { subject, accountId, personId, token: minted.token };
  };
}

export interface DemoPersonInput {
  kind: 'adult' | 'child';
  givenName: string;
  familyName: string;
  dateOfBirth?: string;
}

/** A synthetic address under the reserved `.example` domain (RFC 2606): nothing is ever sent. */
function demoEmail(ctx: DemoContext, givenName: string): string {
  ctx.sequence.email += 1;
  const name = givenName.toLowerCase().replace(/[^a-z]+/g, '');
  return `${name}.${ctx.sequence.email}@demo.example`;
}

/**
 * A person record created by the system administrator through `POST /v1/people`. Every adult gets
 * a verified synthetic email address, so the fake messaging provider can deliver their notices
 * (an adult without an address leaves one failed-delivery exception per notice).
 */
export async function createPerson(ctx: DemoContext, input: DemoPersonInput): Promise<string> {
  const person = await ctx.api.post<{ id: string }>('/people', ctx.staff.admin, {
    kind: input.kind,
    givenName: input.givenName,
    familyName: input.familyName,
    dateOfBirth: input.dateOfBirth,
    contactPoints:
      input.kind === 'adult'
        ? [
            {
              kind: 'email',
              value: demoEmail(ctx, input.givenName),
              isPrimary: true,
              verified: true,
            },
          ]
        : [],
  });
  return person.id;
}

/**
 * A local account for a person, so the demo can act as them and a developer can sign in as them.
 * The account is listed in the seed's summary.
 */
export async function createAccount(
  ctx: DemoContext,
  subject: string,
  personId: string,
  about: string,
): Promise<DemoSession> {
  const issuer = ctx.app.get<AppConfig>(APP_CONFIG).AUTH_ISSUER;
  const account = await ctx.api.post<{ id: string }>('/accounts', ctx.staff.admin, {
    issuer,
    subject,
    personId,
  });
  ctx.accounts.push({ subject, accountId: account.id, personId, about });
  return ctx.signIn(subject, account.id, personId);
}

export async function createStaff(ctx: DemoContext, spec: DemoStaffSpec): Promise<DemoSession> {
  const personId = await createPerson(ctx, {
    kind: 'adult',
    givenName: spec.givenName,
    familyName: spec.familyName,
  });
  const session = await createAccount(
    ctx,
    spec.subject,
    personId,
    `staff: ${spec.roles.join(', ')}`,
  );
  await ctx.api.post('/staff-memberships', ctx.staff.admin, {
    personId,
    roles: spec.roles,
    facilityIds: [],
  });
  // Roles are read when a token is resolved, so the session minted above already carries them.
  return session;
}

interface PersonDetail {
  revision: number;
  dateOfBirth: string | null;
  contactPoints: Array<{ kind: string }>;
}

/**
 * The seeded people have no date of birth and no contact point. The front desk records what the
 * demo needs: a date of birth (eligibility is evaluated from it, never from a stored age: §4.5)
 * and a synthetic email address. A value already on record is kept.
 */
export async function completeSeededPerson(
  ctx: DemoContext,
  personId: string,
  input: { dateOfBirth?: string; email?: string },
): Promise<void> {
  const person = await ctx.api.get<PersonDetail>(`/people/${personId}`, ctx.staff.desk);
  if (input.dateOfBirth && !person.dateOfBirth) {
    await ctx.api.patch(`/people/${personId}`, ctx.staff.desk, {
      dateOfBirth: input.dateOfBirth,
      expectedRevision: person.revision,
    });
  }
  if (input.email && !person.contactPoints.some((c) => c.kind === 'email')) {
    await ctx.api.post(`/people/${personId}/contact-points`, ctx.staff.desk, {
      kind: 'email',
      value: input.email,
      isPrimary: true,
      verified: true,
    });
  }
}

/** A guardian relationship with the six permissions (SPK-IAM-003), recorded by staff. */
export async function makeGuardian(
  ctx: DemoContext,
  guardianPersonId: string,
  childPersonId: string,
): Promise<void> {
  await ctx.api.post('/relationships', ctx.staff.admin, {
    actorPersonId: guardianPersonId,
    subjectPersonId: childPersonId,
    kind: 'guardian',
    permissions: ['view', 'register', 'pay', 'complete_forms', 'receive_messages', 'collect'],
  });
}
