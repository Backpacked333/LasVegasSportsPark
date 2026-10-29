import { newId, type CapabilityId, type StaffRole } from '@sportspark/contracts';
import { expect } from 'vitest';
import { Inbox, OutboxDispatcher } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../modules/identity';
import { createTestApp, type TestApp, type TestAppOptions } from '../../testing';

/**
 * Shared helpers for the cross-module journeys (not a spec file). Every journey boots the assembled
 * application (all fourteen domain modules and the identity module's principal resolver) on a
 * fully migrated database and drives it through HTTP; fixtures only create the people, places and
 * records a journey starts from. No module test double is installed here.
 */

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export function journeyApp(
  options: Pick<TestAppOptions, 'clockStart' | 'capabilities' | 'env' | 'configure'> = {},
): Promise<TestApp> {
  return createTestApp({
    imports: DOMAIN_MODULES,
    principalResolver: 'module',
    // A new organization: every Package G capability is off (DEC-016) unless a journey enables it
    // through the administration endpoint.
    capabilities: options.capabilities ?? [],
    clockStart: options.clockStart,
    env: options.env,
    configure: options.configure,
  });
}

export const key = (): string => `k-${newId()}`;

export async function adult(t: TestApp, organizationId?: string): Promise<Actor> {
  const personId = await createPersonFixture(t, { kind: 'adult', organizationId });
  const account = await createAccountFixture(t, { personId, organizationId });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function child(
  t: TestApp,
  guardians: readonly Actor[],
  permissions?: Parameters<typeof createRelationshipFixture>[1]['permissions'],
): Promise<string> {
  const personId = await createPersonFixture(t, { kind: 'child' });
  for (const guardian of guardians) {
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: personId,
      permissions,
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

export function post(
  t: TestApp,
  path: string,
  header: { Authorization: string },
  body: unknown = {},
  idempotencyKey = key(),
) {
  return t.http
    .post(path)
    .set(header)
    .set('Idempotency-Key', idempotencyKey)
    .send(body as object);
}

export function patch(
  t: TestApp,
  path: string,
  header: { Authorization: string },
  body: unknown = {},
) {
  return t.http
    .patch(path)
    .set(header)
    .set('Idempotency-Key', key())
    .send(body as object);
}

export function get(t: TestApp, path: string, header?: { Authorization: string }) {
  const req = t.http.get(path);
  return header ? req.set(header) : req;
}

/** Asserts the status and returns the body (the body is printed when the status differs). */
export async function ok<T = Record<string, unknown>>(
  response: Promise<{ status: number; body: unknown }> | { status: number; body: unknown },
  status = 200,
): Promise<T> {
  const res = await response;
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
}

/** Runs the outbox until nothing more is due (timers that are due, and their follow-ups). */
export async function drain(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 40; i += 1) {
    const summary = await dispatcher.runOnce(200);
    if (summary.claimed === 0) return;
  }
}

/** Applies recorded provider events, then their durable follow-ups. */
export async function processInbox(t: TestApp): Promise<void> {
  const inbox = t.app.get(Inbox);
  for (let i = 0; i < 10; i += 1) {
    const summary = await inbox.runOnce(200);
    if (summary.processed + summary.failed + summary.dead === 0) break;
  }
  await drain(t);
}

/**
 * K-12 (DEC-016): a system administrator switches a capability on for the organization, naming one
 * of its applicability references, through the administration endpoint (audited, with history).
 */
export async function enableCapability(
  t: TestApp,
  admin: Actor,
  capability: CapabilityId,
  decisionReference: string,
): Promise<void> {
  await ok(
    post(t, `/v1/admin/capabilities/${capability}/enable`, admin.header, {
      decisionReference,
      reason: `The operator decided ${decisionReference} for this journey`,
    }),
  );
}

export async function disableCapability(
  t: TestApp,
  admin: Actor,
  capability: CapabilityId,
  decisionReference: string,
): Promise<void> {
  await ok(
    post(t, `/v1/admin/capabilities/${capability}/disable`, admin.header, {
      decisionReference,
      reason: `The operator withdrew ${decisionReference} for this journey`,
    }),
  );
}

/** Two promises started together; under TEST_DATABASE_URL they overlap, under PGlite they serialize. */
export async function together<A, B>(a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  return Promise.all([a(), b()]);
}
