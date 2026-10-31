import {
  newId,
  type CapabilityId,
  type CapacityUnit,
  type ChargeLine,
  type OfferingKind,
  type StaffRole,
} from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { OutboxDispatcher } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../catalog';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import type { GrantPermissionValue } from '@sportspark/db';
import { EnrollmentModule } from '../enrollment.module';
import { withStage3Doubles } from './stage3-doubles';

/** Shared helpers for the enrollment API tests (not a spec file). */

export const CLOCK_START = '2026-11-02T15:00:00Z';

export const key = (): string => `k-${newId()}`;

export function enrollmentTestApp(
  options: {
    clockStart?: string;
    capabilities?: readonly CapabilityId[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<TestApp> {
  return createTestApp({
    imports: [EnrollmentModule],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
    capabilities: options.capabilities,
    env: options.env,
    // Stage-3 port members other work items implement answer through their declared contract
    // until those items are merged (stage3-doubles.ts).
    configure: withStage3Doubles,
  });
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export async function adult(
  t: TestApp,
  input: { dateOfBirth?: string; organizationId?: string } = {},
): Promise<Actor> {
  const personId = await createPersonFixture(t, {
    kind: 'adult',
    dateOfBirth: input.dateOfBirth,
    organizationId: input.organizationId,
  });
  const account = await createAccountFixture(t, { personId, organizationId: input.organizationId });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function child(
  t: TestApp,
  guardians: readonly Actor[],
  input: { dateOfBirth?: string; permissions?: readonly GrantPermissionValue[] } = {},
): Promise<string> {
  const personId = await createPersonFixture(t, { kind: 'child', dateOfBirth: input.dateOfBirth });
  for (const guardian of guardians) {
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: personId,
      permissions: input.permissions,
    });
  }
  return personId;
}

export async function staff(
  t: TestApp,
  roles: StaffRole[],
  organizationId?: string,
): Promise<Actor> {
  const member = await createStaffMemberFixture(t, { roles, organizationId });
  return {
    personId: member.personId,
    accountId: member.accountId,
    header: await authHeaderForPerson(t, member.personId),
  };
}

export interface OfferingSetup extends OfferingFixture {
  managerPersonId: string;
}

/** A registration-open offering with approved policies, one required form and a price. */
export async function offering(
  t: TestApp,
  input: {
    kind?: OfferingKind;
    capacityUnits?: CapacityUnit[];
    basePriceMinor?: number | null;
    chargeLines?: ChargeLine[];
    ageBand?: { minAgeYears?: number; maxAgeYears?: number };
    programId?: string;
    startsOn?: string;
    endsOn?: string;
    registrationClosesAt?: Date;
    entitlementDefinitionId?: string;
    managerPersonId?: string;
    cancellationPolicyVersionId?: string;
    eligibilityPolicyVersionId?: string;
  } = {},
): Promise<OfferingSetup> {
  const managerPersonId =
    input.managerPersonId ??
    (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
  const programId =
    input.programId ??
    (await createProgramFixture(t, {
      ageBand: input.ageBand ?? { minAgeYears: 6, maxAgeYears: 12 },
    }));
  const created = await createOfferingFixture(t, {
    responsibleManagerPersonId: managerPersonId,
    programId,
    kind: input.kind ?? 'term',
    capacityUnits: input.capacityUnits ?? [{ unit: 'seats', limit: 20 }],
    basePriceMinor: input.basePriceMinor === undefined ? 15_000 : input.basePriceMinor,
    chargeLines: input.chargeLines,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    registrationClosesAt: input.registrationClosesAt,
    entitlementDefinitionId: input.entitlementDefinitionId,
    cancellationPolicyVersionId: input.cancellationPolicyVersionId,
    eligibilityPolicyVersionId: input.eligibilityPolicyVersionId,
  });
  return { ...created, managerPersonId };
}

/** The participant's required form, acknowledged by the real signer (SPK-REG-009). */
export async function acknowledge(
  t: TestApp,
  setup: OfferingSetup,
  subjectPersonId: string,
  signedByPersonId: string,
): Promise<void> {
  await createAcknowledgmentFixture(t, {
    subjectPersonId,
    policyVersionId: setup.formPolicyVersionId,
    signedByPersonId,
  });
}

/** Runs the outbox until nothing more is due (timers that are due, and their follow-ups). */
export async function drain(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 25; i += 1) {
    const summary = await dispatcher.runOnce(200);
    if (summary.claimed === 0) return;
  }
}

/** POST helper with a fresh idempotency key. */
export function post(
  t: TestApp,
  path: string,
  header: { Authorization: string },
  body: unknown = {},
) {
  return t.http
    .post(path)
    .set(header)
    .set('Idempotency-Key', key())
    .send(body as object);
}

/** Opens a basket for `owner`, adds one line per participant and returns the basket body. */
export async function basketWith(
  t: TestApp,
  owner: Actor,
  lines: ReadonlyArray<{ participantPersonId: string; offeringId: string; intent?: string }>,
  options: {
    header?: { Authorization: string };
    fulfillmentMode?: 'all_or_nothing' | 'partial';
  } = {},
): Promise<{ id: string; revision: number; body: Record<string, unknown> }> {
  const header = options.header ?? owner.header;
  const created = await post(t, '/v1/baskets', header, {
    ownerPersonId: owner.personId,
    fulfillmentMode: options.fulfillmentMode ?? 'all_or_nothing',
    acceptPartialFulfillment: options.fulfillmentMode === 'partial',
  });
  if (created.status !== 201)
    throw new Error(`basket: ${created.status} ${JSON.stringify(created.body)}`);
  let body = created.body as Record<string, unknown>;
  for (const line of lines) {
    const added = await post(t, `/v1/baskets/${body['id'] as string}/lines`, header, {
      participantPersonId: line.participantPersonId,
      offeringId: line.offeringId,
      intent: line.intent ?? 'youth',
    });
    if (added.status !== 201)
      throw new Error(`line: ${added.status} ${JSON.stringify(added.body)}`);
    body = added.body as Record<string, unknown>;
  }
  return { id: body['id'] as string, revision: body['revision'] as number, body };
}

/** `forbid_mutation` raises `restrict_violation` (SQLSTATE 23001). */
export function isRestrictViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23001';
}

export async function rejectsWith(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgErrorCode(error);
  }
  throw new Error('expected the database to reject the statement');
}
