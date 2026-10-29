import { newId, type CapabilityId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode, seedOrganization } from '@sportspark/db';
import { expect } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { DEFAULT_TEST_CAPABILITIES, createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { AutomationModule } from '../automation.module';
import type { AutomationSettings } from '../automation.settings';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import { enableAutomation, fakeAssistant } from '../testing/automation-fixtures';

/** Shared helpers for the automation API tests (not a spec file). */

/** Saturday 2027-01-16, 12:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-01-16T20:00:00.000Z';

export const key = (): string => `k-${newId()}`;

/**
 * AUT-02: the seeded organization of an automation test uses the assistant (capability
 * `assistant`, DEC-016); tests of the switch itself start from the default set.
 */
export const ASSISTANT_CAPABILITIES: readonly CapabilityId[] = [
  ...DEFAULT_TEST_CAPABILITIES,
  'assistant',
];

export interface AutomationTestApp {
  t: TestApp;
  fake: FakeAssistantProvider;
}

export async function automationTestApp(
  options: {
    clockStart?: string;
    settings?: Partial<AutomationSettings>;
    capabilities?: readonly CapabilityId[];
  } = {},
): Promise<AutomationTestApp> {
  const t = await createTestApp({
    imports: [AutomationModule],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
    configure: enableAutomation(options.settings),
    capabilities: options.capabilities ?? ASSISTANT_CAPABILITIES,
  });
  return { t, fake: fakeAssistant(t.app) };
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export async function adultCustomer(
  t: TestApp,
  input: { organizationId?: string; givenName?: string; familyName?: string } = {},
): Promise<Actor> {
  const personId = await createPersonFixture(t, {
    kind: 'adult',
    organizationId: input.organizationId,
    givenName: input.givenName,
    familyName: input.familyName,
  });
  const account = await createAccountFixture(t, { personId, organizationId: input.organizationId });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function staffMember(
  t: TestApp,
  roles: StaffRole[],
  options: { organizationId?: string; facilityIds?: string[]; personId?: string } = {},
): Promise<Actor & { membershipId: string }> {
  const staff = await createStaffMemberFixture(t, {
    roles,
    organizationId: options.organizationId,
    facilityIds: options.facilityIds,
    personId: options.personId,
  });
  return {
    personId: staff.personId,
    accountId: staff.accountId,
    membershipId: staff.membershipId,
    header: await authHeaderForPerson(t, staff.personId),
  };
}

export async function otherOrganization(
  t: TestApp,
): Promise<{ organizationId: string; facilityId: string }> {
  return seedOrganization(t.db, { slug: `other-${newId().slice(0, 8)}` });
}

export async function drainOutbox(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 30; i += 1) {
    const summary = await dispatcher.runOnce(100);
    if (summary.claimed === 0) return;
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

export function post(t: TestApp, path: string, actor: Actor, body: object, idempotencyKey = key()) {
  return t.http.post(path).set(actor.header).set('Idempotency-Key', idempotencyKey).send(body);
}

export function patch(
  t: TestApp,
  path: string,
  actor: Actor,
  body: object,
  idempotencyKey = key(),
) {
  return t.http.patch(path).set(actor.header).set('Idempotency-Key', idempotencyKey).send(body);
}

export function get(t: TestApp, path: string, actor: Actor) {
  return t.http.get(path).set(actor.header);
}

/** POST /v1/assistant/requests and expect 201. */
export async function ask(
  t: TestApp,
  actor: Actor,
  body: { prompt: string } & Record<string, unknown>,
  idempotencyKey = key(),
): Promise<Awaited<ReturnType<typeof post>>> {
  const res = await post(t, '/v1/assistant/requests', actor, body, idempotencyKey);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

/** A schedule draft opened by a scheduler through the scheduling API. */
export async function openDraft(
  t: TestApp,
  scheduler: Actor,
  name: string,
  changes: unknown[],
  facilityId: string = t.facilityId,
): Promise<{ id: string; revision: number; status: string }> {
  const res = await post(t, '/v1/schedule-drafts', scheduler, { facilityId, name, changes });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; revision: number; status: string };
}

export const createChange = (
  start: string,
  end: string,
  resourceIds: string[],
  title = 'Game',
) => ({
  kind: 'create',
  proposed: { kind: 'game', title, scheduledStart: start, scheduledEnd: end },
  resourceIds,
});

export async function countRows(
  t: TestApp,
  table: 'refund_attempts' | 'access_grants' | 'staff_memberships' | 'journals' | 'notifications',
): Promise<number> {
  const row = await t.db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
