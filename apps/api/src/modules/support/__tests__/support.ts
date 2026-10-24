import { newId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode, seedOrganization } from '@sportspark/db';
import { expect } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../catalog';
import {
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { FakePaymentTokens } from '../../finance';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { SupportModule } from '../support.module';

/** Shared helpers for the support API tests (not a spec file). */

/** Saturday 2027-01-16, 12:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-01-16T20:00:00Z';

export const key = (): string => `k-${newId()}`;

export function supportTestApp(options: { clockStart?: string } = {}): Promise<TestApp> {
  return createTestApp({
    imports: [SupportModule],
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
  options: { organizationId?: string; facilityIds?: string[] } = {},
): Promise<Actor> {
  const staff = await createStaffMemberFixture(t, {
    roles,
    organizationId: options.organizationId,
    facilityIds: options.facilityIds,
  });
  return {
    personId: staff.personId,
    accountId: staff.accountId,
    header: await authHeaderForPerson(t, staff.personId),
  };
}

/** A second organization (with its own facility) in the same database. */
export async function otherOrganization(
  t: TestApp,
): Promise<{ organizationId: string; facilityId: string }> {
  return seedOrganization(t.db, { slug: `other-${newId().slice(0, 8)}` });
}

/** A second facility of the test organization. */
export async function secondFacility(t: TestApp): Promise<string> {
  const id = newId();
  await t.db
    .insertInto('facilities')
    .values({
      id,
      organization_id: t.organizationId,
      slug: `annex-${id.slice(0, 8)}`,
      name: 'Annex',
      timezone: 'America/Los_Angeles',
    })
    .execute();
  return id;
}

/** Runs the outbox dispatcher until no event is pending (follow-up handlers). */
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

export function post(
  t: TestApp,
  path: string,
  actor: Actor,
  body: object,
  idempotencyKey: string = key(),
) {
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

/** A child of the guardians with every permission (SPK-IAM-003 grants, none implied). */
export async function childOf(
  t: TestApp,
  guardians: readonly Actor[],
  input: { givenName?: string; familyName?: string; dateOfBirth?: string } = {},
): Promise<string> {
  const personId = await createPersonFixture(t, { kind: 'child', ...input });
  for (const guardian of guardians) {
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: personId,
    });
  }
  return personId;
}

/** A registration-open youth offering with approved policies, one required form and a price. */
export async function offering(t: TestApp, basePriceMinor = 12_000): Promise<OfferingFixture> {
  const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
  const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } });
  return createOfferingFixture(t, {
    responsibleManagerPersonId: manager.personId,
    programId,
    basePriceMinor,
    startsOn: '2027-02-01',
    endsOn: '2027-04-30',
  });
}

/**
 * The parent registers and pays for the child through the real modules: basket (enrollment),
 * quote and checkout with the fake processor (finance), so orders, payments and enrollments
 * carry their real facts and events.
 */
export async function registerAndPay(
  t: TestApp,
  parent: Actor,
  participantPersonId: string,
  setup: OfferingFixture,
): Promise<{
  checkoutId: string;
  orderId: string;
  paymentAttemptId: string;
  enrollmentIds: string[];
}> {
  const basket = await post(t, '/v1/baskets', parent, { ownerPersonId: parent.personId });
  expect(basket.status, JSON.stringify(basket.body)).toBe(201);
  await createAcknowledgmentFixture(t, {
    subjectPersonId: participantPersonId,
    policyVersionId: setup.formPolicyVersionId,
    signedByPersonId: parent.personId,
  });
  const line = await post(t, `/v1/baskets/${basket.body.id}/lines`, parent, {
    participantPersonId,
    offeringId: setup.offeringId,
    intent: 'youth',
  });
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  const quote = await post(t, '/v1/registration-quotes', parent, { basketId: basket.body.id });
  expect(quote.status, JSON.stringify(quote.body)).toBe(201);
  const checkout = await post(t, '/v1/registration-checkouts', parent, {
    quoteId: quote.body.id,
    payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
  });
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
  expect(checkout.body.status).toBe('completed');
  return {
    checkoutId: checkout.body.id,
    orderId: checkout.body.orderId,
    paymentAttemptId: checkout.body.payment.id,
    enrollmentIds: checkout.body.enrollmentIds,
  };
}

export interface CompetitionWorld {
  leagueManager: Actor;
  pitch: PitchFixture;
  seasonId: string;
  divisionId: string;
}

export async function competitionWorld(
  t: TestApp,
  pitchName = 'Pitch 1',
): Promise<CompetitionWorld> {
  const leagueManager = await staffMember(t, ['league_manager']);
  const pitch = await seedPitchWithHalves(t.db, {
    organizationId: t.organizationId,
    facilityId: t.facilityId,
    name: pitchName,
  });
  const season = await createSeasonFixture(t, { status: 'active' });
  const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
  return { leagueManager, pitch, seasonId: season.seasonId, divisionId };
}

let teams = 0;

/** A fixture between two fresh teams, scheduled (as a draft event) through competition. */
export async function scheduleFixture(
  t: TestApp,
  world: CompetitionWorld,
  input: { date: string; from: string; to: string },
): Promise<{ fixtureId: string; eventId: string; start: string; end: string }> {
  const homeCaptain = await adultCustomer(t);
  const awayCaptain = await adultCustomer(t);
  teams += 1;
  const home = await createTeamEntryFixture(t, {
    seasonId: world.seasonId,
    captainPersonId: homeCaptain.personId,
    teamName: `Lions ${teams}`,
    divisionId: world.divisionId,
  });
  const away = await createTeamEntryFixture(t, {
    seasonId: world.seasonId,
    captainPersonId: awayCaptain.personId,
    teamName: `Tigers ${teams}`,
    divisionId: world.divisionId,
  });
  const start = at(input.date, input.from);
  const end = at(input.date, input.to);
  const res = await post(t, '/v1/fixtures', world.leagueManager, {
    seasonId: world.seasonId,
    divisionId: world.divisionId,
    homeEntryId: home.teamEntryId,
    awayEntryId: away.teamEntryId,
    schedule: {
      facilityId: t.facilityId,
      resourceIds: [world.pitch.pitchId],
      scheduledStart: start,
      scheduledEnd: end,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    fixtureId: res.body.fixture.id as string,
    eventId: res.body.fixture.schedulingEventId as string,
    start,
    end,
  };
}
