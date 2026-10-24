import { newId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { expect } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { OutboxDispatcher } from '../../../kernel';
import {
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../../competition';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { WorkforceModule } from '../workforce.module';

/** Shared helpers for the workforce API tests (not a spec file). */

/** Saturday 2027-01-16, 12:00 in Los Angeles (the test facility's zone). */
export const CLOCK_START = '2027-01-16T20:00:00Z';

export const key = (): string => `k-${newId()}`;

export function workforceTestApp(options: { clockStart?: string } = {}): Promise<TestApp> {
  return createTestApp({
    imports: [WorkforceModule],
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

export interface CompetitionWorld {
  leagueManager: Actor;
  pitch: PitchFixture;
  season: SeasonFixture;
  divisionId: string;
}

export async function competitionWorld(t: TestApp): Promise<CompetitionWorld> {
  const leagueManager = await staffMember(t, ['league_manager']);
  const pitch = await seedPitchWithHalves(t.db, {
    organizationId: t.organizationId,
    facilityId: t.facilityId,
    name: 'Pitch 1',
  });
  const season = await createSeasonFixture(t, { status: 'active' });
  const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
  return { leagueManager, pitch, season, divisionId };
}

export interface ScheduledFixture {
  fixtureId: string;
  eventId: string;
  start: string;
  end: string;
  homeEntryId: string;
  awayEntryId: string;
}

let teams = 0;

/** A fixture between two fresh teams, scheduled through competition (and so scheduling). */
export async function scheduleFixture(
  t: TestApp,
  world: CompetitionWorld,
  input: { date: string; from?: string; to?: string; resourceId?: string },
): Promise<ScheduledFixture> {
  const homeCaptain = await adultCustomer(t);
  const awayCaptain = await adultCustomer(t);
  teams += 1;
  const home = await createTeamEntryFixture(t, {
    seasonId: world.season.seasonId,
    captainPersonId: homeCaptain.personId,
    teamName: `Lions ${teams}`,
    divisionId: world.divisionId,
  });
  const away = await createTeamEntryFixture(t, {
    seasonId: world.season.seasonId,
    captainPersonId: awayCaptain.personId,
    teamName: `Tigers ${teams}`,
    divisionId: world.divisionId,
  });
  const start = at(input.date, input.from ?? '18:00');
  const end = at(input.date, input.to ?? '19:00');
  const res = await t.http
    .post('/v1/fixtures')
    .set(world.leagueManager.header)
    .set('Idempotency-Key', key())
    .send({
      seasonId: world.season.seasonId,
      divisionId: world.divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [input.resourceId ?? world.pitch.pitchId],
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
    homeEntryId: home.teamEntryId,
    awayEntryId: away.teamEntryId,
  };
}

/** Runs the outbox dispatcher until no event is pending (follow-up handlers). */
export async function drainOutbox(t: TestApp): Promise<void> {
  const dispatcher = t.app.get(OutboxDispatcher);
  for (let i = 0; i < 20; i += 1) {
    const summary = await dispatcher.runOnce(100);
    if (summary.claimed === 0) return;
  }
}

/** `forbid_mutation` raises `restrict_violation` (SQLSTATE 23001). */
export function isRestrictViolation(error: unknown): boolean {
  return pgErrorCode(error) === '23001';
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
