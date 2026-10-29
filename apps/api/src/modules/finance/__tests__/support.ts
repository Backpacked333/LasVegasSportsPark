import {
  newId,
  type CapabilityId,
  type CapacityUnit,
  type ChargeLine,
  type StaffRole,
} from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Inbox, OutboxDispatcher } from '../../../kernel';
import { createTestApp, type TestApp, type TestAppOptions } from '../../../testing';
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
import { FinanceModule } from '../finance.module';
import { FinanceWorker } from '../services/finance-worker';
import {
  FAKE_PAYMENTS_PROVIDER,
  FAKE_PAYMENTS_SIGNATURE_HEADER,
  FakePaymentProvider,
} from '../providers/fake-payment.provider';
import { withStage3Doubles } from './stage3-doubles';

type TestAppImports = NonNullable<TestAppOptions['imports']>;

/** Shared helpers for the finance API tests (not a spec file). */

export const CLOCK_START = '2026-11-02T15:00:00Z';
export const MINUTE = 60_000;

export const key = (): string => `k-${newId()}`;

export function financeTestApp(
  options: {
    clockStart?: string;
    configure?: (b: TestingModuleBuilder) => TestingModuleBuilder;
    imports?: TestAppImports;
    capabilities?: readonly CapabilityId[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<TestApp> {
  return createTestApp({
    imports: [FinanceModule, ...(options.imports ?? [])],
    principalResolver: 'module',
    clockStart: options.clockStart ?? CLOCK_START,
    capabilities: options.capabilities,
    env: options.env,
    // Stage-3 port members other work items implement (ID-01, ID-09, CAT-02) answer through their
    // declared contract until those land (stage3-doubles.ts).
    configure: (b) => {
      const doubled = withStage3Doubles(b);
      return options.configure ? options.configure(doubled) : doubled;
    },
  });
}

export interface Actor {
  personId: string;
  accountId: string;
  header: { Authorization: string };
}

export async function adult(t: TestApp, organizationId?: string): Promise<Actor> {
  const personId = await createPersonFixture(t, { kind: 'adult', organizationId });
  const account = await createAccountFixture(t, { personId, organizationId });
  return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
}

export async function child(
  t: TestApp,
  guardians: readonly Actor[],
  permissions?: readonly GrantPermissionValue[],
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

/** A registration-open offering with approved policies, one required form and a price. */
export async function offering(
  t: TestApp,
  input: {
    basePriceMinor?: number | null;
    capacityUnits?: CapacityUnit[];
    chargeLines?: ChargeLine[];
  } = {},
): Promise<OfferingFixture> {
  const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
  const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } });
  return createOfferingFixture(t, {
    responsibleManagerPersonId: manager.personId,
    programId,
    capacityUnits: input.capacityUnits ?? [{ unit: 'seats', limit: 20 }],
    basePriceMinor: input.basePriceMinor === undefined ? 15_000 : input.basePriceMinor,
    chargeLines: input.chargeLines,
  });
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

/** A child of `parent` with the offering's form acknowledged, in a basket of its own. */
export async function basketFor(
  t: TestApp,
  parent: Actor,
  setups: readonly OfferingFixture[],
  options: { hold?: boolean; participants?: string[] } = {},
): Promise<{ basketId: string; participants: string[]; body: Record<string, unknown> }> {
  const participants: string[] = options.participants ?? [];
  if (participants.length === 0) {
    for (let i = 0; i < setups.length; i += 1) participants.push(await child(t, [parent]));
  }
  const created = await post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId });
  if (created.status !== 201)
    throw new Error(`basket ${created.status} ${JSON.stringify(created.body)}`);
  const basketId = created.body.id as string;
  let body = created.body as Record<string, unknown>;
  for (let i = 0; i < setups.length; i += 1) {
    const setup = setups[i] as OfferingFixture;
    const participant = participants[i] as string;
    await createAcknowledgmentFixture(t, {
      subjectPersonId: participant,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: parent.personId,
    });
    const added = await post(t, `/v1/baskets/${basketId}/lines`, parent.header, {
      participantPersonId: participant,
      offeringId: setup.offeringId,
      intent: 'youth',
    });
    if (added.status !== 201) throw new Error(`line ${added.status} ${JSON.stringify(added.body)}`);
    body = added.body as Record<string, unknown>;
  }
  if (options.hold ?? true) {
    const held = await post(t, `/v1/baskets/${basketId}/hold`, parent.header, {
      expectedRevision: body['revision'],
    });
    if (held.status !== 200) throw new Error(`hold ${held.status} ${JSON.stringify(held.body)}`);
    body = held.body as Record<string, unknown>;
  }
  return { basketId, participants, body };
}

export async function quoteFor(
  t: TestApp,
  actor: Actor,
  basketId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await post(t, '/v1/registration-quotes', actor.header, { basketId, ...extra });
  if (res.status !== 201) throw new Error(`quote ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, unknown> & {
    id: string;
    dueNowMinor: number;
    totalMinor: number;
  };
}

/** Runs the outbox until nothing more is due (timers that are due, and their follow-ups). */
export async function drain(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 25; i += 1) {
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

export function provider(t: TestApp): FakePaymentProvider {
  return t.app.get(FakePaymentProvider);
}

export function worker(t: TestApp): FinanceWorker {
  return t.app.get(FinanceWorker);
}

/** Posts a signed provider webhook as the provider would. */
export function deliver(t: TestApp, event: { body: unknown; signature: string }) {
  return t.http
    .post(`/v1/webhooks/payments/${FAKE_PAYMENTS_PROVIDER}`)
    .set(FAKE_PAYMENTS_SIGNATURE_HEADER, event.signature)
    .send(event.body as object);
}

/** `forbid_mutation` raises `restrict_violation` (SQLSTATE 23001). */
export async function rejectsWith(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return pgErrorCode(error);
  }
  throw new Error('expected the database to reject the statement');
}

/** Sum of debits and credits over every journal entry of the organization (must be equal). */
export async function ledgerTotals(t: TestApp): Promise<{ debits: number; credits: number }> {
  const rows = await t.db
    .selectFrom('journal_entries')
    .select(['debit_minor', 'credit_minor'])
    .where('organization_id', '=', t.organizationId)
    .execute();
  return {
    debits: rows.reduce((a, r) => a + r.debit_minor, 0),
    credits: rows.reduce((a, r) => a + r.credit_minor, 0),
  };
}

export async function balanceOf(t: TestApp, account: string): Promise<number> {
  const rows = await t.db
    .selectFrom('journal_entries')
    .select(['debit_minor', 'credit_minor'])
    .where('organization_id', '=', t.organizationId)
    .where('account_code', '=', account as never)
    .execute();
  return rows.reduce((a, r) => a + r.debit_minor - r.credit_minor, 0);
}
