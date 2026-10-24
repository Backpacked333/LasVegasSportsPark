import { newId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { expect } from 'vitest';
import { Inbox, OutboxDispatcher } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  type OfferingFixture,
} from '../../catalog';
import { createEnrollmentFixture } from '../../enrollment';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import { at } from '../../scheduling';
import type { GrantPermissionValue } from '@sportspark/db';
import { EntryModule } from '../entry.module';

/** Shared helpers for the entry API tests (not a spec file). */

/** Saturday 2027-01-16, 09:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-01-16T17:00:00Z';
export const TODAY = '2027-01-16';

export const key = (): string => `k-${newId()}`;

export function entryTestApp(options: { clockStart?: string } = {}): Promise<TestApp> {
  return createTestApp({
    imports: [EntryModule],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
  });
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export async function adultCustomer(
  t: TestApp,
  input: { organizationId?: string; givenName?: string } = {},
): Promise<Actor> {
  const personId = await createPersonFixture(t, {
    kind: 'adult',
    organizationId: input.organizationId,
    givenName: input.givenName,
  });
  const account = await createAccountFixture(t, {
    personId,
    organizationId: input.organizationId,
  });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function staffMember(
  t: TestApp,
  roles: StaffRole[],
  options: { organizationId?: string; facilityIds?: string[]; personId?: string } = {},
): Promise<Actor> {
  const staff = await createStaffMemberFixture(t, {
    roles,
    organizationId: options.organizationId,
    facilityIds: options.facilityIds,
    personId: options.personId,
  });
  return {
    personId: staff.personId,
    accountId: staff.accountId,
    header: await authHeaderForPerson(t, staff.personId),
  };
}

export function post(t: TestApp, path: string, actor: Actor, body: object, idempotencyKey = key()) {
  return t.http.post(path).set(actor.header).set('Idempotency-Key', idempotencyKey).send(body);
}

export interface Family {
  guardian: Actor;
  childA: string;
  childB: string;
  householdId: string;
}

/** A guardian with an account, two children (guardian holds the given permissions), one household. */
export async function family(
  t: TestApp,
  desk: Actor,
  permissions?: readonly GrantPermissionValue[],
): Promise<Family> {
  const guardian = await adultCustomer(t);
  const childA = await createPersonFixture(t, { kind: 'child', givenName: 'Ava' });
  const childB = await createPersonFixture(t, { kind: 'child', givenName: 'Ben' });
  for (const child of [childA, childB]) {
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions,
    });
  }
  const household = await post(t, '/v1/households', desk, { name: 'Household' });
  expect(household.status, JSON.stringify(household.body)).toBe(201);
  const householdId = household.body.id as string;
  for (const personId of [guardian.personId, childA, childB]) {
    const added = await post(t, `/v1/households/${householdId}/members`, desk, { personId });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return { guardian, childA, childB, householdId };
}

export interface Program {
  offering: OfferingFixture;
  sessionId: string;
  start: string;
  end: string;
}

/** A published youth offering at the test facility with one session today, 10:00-11:00 local. */
export async function program(
  t: TestApp,
  manager: Actor,
  input: { from?: string; to?: string; facilityId?: string } = {},
): Promise<Program> {
  const offering = await createOfferingFixture(t, {
    responsibleManagerPersonId: manager.personId,
    facilityId: input.facilityId,
  });
  const start = at(TODAY, input.from ?? '10:00');
  const end = at(TODAY, input.to ?? '11:00');
  const sessionId = await createOfferingSessionFixture(t, {
    offeringId: offering.offeringId,
    scheduledStart: new Date(start),
    scheduledEnd: new Date(end),
  });
  return { offering, sessionId, start, end };
}

/** A confirmed enrollment with the required form acknowledged by the guardian. */
export async function enroll(
  t: TestApp,
  p: Program,
  childId: string,
  guardianId: string,
  options: { status?: 'pending' | 'confirmed'; acknowledge?: boolean } = {},
): Promise<string> {
  const enrollmentId = await createEnrollmentFixture(t, {
    offeringId: p.offering.offeringId,
    participantPersonId: childId,
    status: options.status ?? 'confirmed',
  });
  if (options.acknowledge ?? true) {
    await createAcknowledgmentFixture(t, {
      subjectPersonId: childId,
      policyVersionId: p.offering.formPolicyVersionId,
      signedByPersonId: guardianId,
    });
  }
  return enrollmentId;
}

export const sessionRef = (p: Program) => ({
  type: 'session' as const,
  offeringId: p.offering.offeringId,
  sessionId: p.sessionId,
});

/** Runs the outbox dispatcher until no event is pending (follow-up handlers). */
export async function drainOutbox(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 20; i += 1) {
    const summary = await dispatcher.runOnce(100);
    if (summary.claimed === 0) return;
  }
}

export async function drainInbox(t: TestApp): Promise<void> {
  const inbox = t.app.get(Inbox);
  for (let i = 0; i < 10; i += 1) {
    const summary = await inbox.runOnce(100);
    if (summary.processed + summary.failed + summary.dead === 0) return;
  }
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}`).not.toBeNull();
  expect(pgErrorCode(caught)).toBe(code);
}

/** Open operational exceptions of a category (the Today workspace queue). */
export async function exceptionsOf(t: TestApp, category: string) {
  return t.db
    .selectFrom('operational_exceptions')
    .selectAll()
    .where('organization_id', '=', t.organizationId)
    .where('category', '=', category)
    .execute();
}
