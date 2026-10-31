import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createEntitlementDefinitionFixture,
  createOfferingSessionFixture,
  createProgramFixture,
} from '../../catalog';
import { createSeasonFixture, createTeamEntryFixture } from '../../competition';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

/**
 * Capacity shared between registration paths (SPK-REG-005, §4.7 invariant 3) and waitlist
 * queues that only hold people who still need the place (SPK-REG-008, DEC-006).
 */
describe('team roster pools and redundant waitlist entries (SPK-REG-005, SPK-REG-008, §4.7-3)', () => {
  let t: TestApp;
  let programManager: Actor;
  let leagueManager: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    programManager = await staff(t, ['program_manager']);
    leagueManager = await staff(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-08: a join_team registration takes a place in the team entry's roster pool
  // -------------------------------------------------------------------------------------------

  it('SPK-REG-005: a join_team hold acquires the team entry roster-place pool that placement respects', async () => {
    const seasonId = (await createSeasonFixture(t)).seasonId;
    const teamEntryId = (
      await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: (await adult(t)).personId,
        teamName: 'Small FC',
      })
    ).teamEntryId;
    const created = await post(t, '/v1/capacity-pools', programManager.header, {
      scopeType: 'team_entry',
      scopeId: teamEntryId,
      unit: 'roster_places',
      capacity: 1,
    });
    expect(created.status).toBe(201);
    const teamPoolId = created.body.id as string;
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const season = await offering(t, {
      programId: program,
      kind: 'season',
      capacityUnits: [{ unit: 'roster_places', limit: 100 }],
      basePriceMinor: 0,
    });
    const joinTeam = async () => {
      const player = await adult(t, { dateOfBirth: '1995-01-01' });
      await acknowledge(t, season, player.personId, player.personId);
      const basket = await post(t, '/v1/baskets', player.header, {
        fulfillmentMode: 'all_or_nothing',
      });
      const line = await post(t, `/v1/baskets/${basket.body.id as string}/lines`, player.header, {
        participantPersonId: player.personId,
        offeringId: season.offeringId,
        intent: 'join_team',
        teamEntryId,
      });
      expect(line.status, JSON.stringify(line.body)).toBe(201);
      const held = await post(t, `/v1/baskets/${basket.body.id as string}/hold`, player.header, {});
      return { player, basketId: basket.body.id as string, held };
    };
    const teamPool = () =>
      t.db
        .selectFrom('capacity_pools')
        .select(['capacity', 'held', 'committed'])
        .where('id', '=', teamPoolId)
        .executeTakeFirstOrThrow();

    const first = await joinTeam();
    expect(first.held.status, JSON.stringify(first.held.body)).toBe(200);
    expect(first.held.body.holds.map((h: { poolId: string }) => h.poolId)).toContain(teamPoolId);
    expect(first.held.body.holds).toHaveLength(2);
    expect(await teamPool()).toEqual({ capacity: 1, held: 1, committed: 0 });

    const second = await joinTeam();
    expect(second.held.status).toBe(409);
    expect(second.held.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { poolId: teamPoolId },
    });

    // Approved and completed: the place is committed against the enrollment.
    const applicationId = first.held.body.lines[0].applicationId as string;
    const accepted = await post(
      t,
      `/v1/applications/${applicationId}/accept`,
      programManager.header,
      {
        expectedRevision: 1,
      },
    );
    expect(accepted.status).toBe(200);
    const done = await post(t, `/v1/baskets/${first.basketId}/complete`, first.player.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    expect(await teamPool()).toEqual({ capacity: 1, held: 0, committed: 1 });
    const allocation = await t.db
      .selectFrom('allocations')
      .select(['enrollment_id', 'status'])
      .where('pool_id', '=', teamPoolId)
      .executeTakeFirstOrThrow();
    expect(allocation).toEqual({ enrollment_id: enrollmentId, status: 'active' });

    // Placement reads the same constraint: the team has no free roster place.
    const freeAgent = await adult(t, { dateOfBirth: '1996-01-01' });
    const request = await post(t, '/v1/placement-requests', freeAgent.header, {
      participantPersonId: freeAgent.personId,
      seasonId,
    });
    expect(request.status).toBe(201);
    const candidates = await t.http
      .get(`/v1/placement-requests/${request.body.id as string}/candidates`)
      .set(leagueManager.header);
    expect(candidates.status).toBe(200);
    const team = (
      (candidates.body.items ?? candidates.body) as Array<{
        teamEntryId: string;
        eligible: boolean;
        reasons: Array<{ code: string }>;
        capacity: { available: number } | null;
      }>
    ).find((c) => c.teamEntryId === teamEntryId);
    expect(team?.eligible).toBe(false);
    expect(team?.reasons.map((r) => r.code)).toContain('roster_capacity_full');
    expect(team?.capacity).toMatchObject({ available: 0 });

    // Cancelling the registration gives the team place back.
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, first.player.header, {
      expectedRevision: 2,
      reason: 'Moved away',
    });
    expect(canceled.status).toBe(200);
    expect(await teamPool()).toEqual({ capacity: 1, held: 0, committed: 0 });
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-09: an entry whose participant already holds the place leaves the queue
  // -------------------------------------------------------------------------------------------

  async function family(setups: OfferingSetup[]) {
    const guardian = await adult(t);
    const kid = await child(t, [guardian]);
    for (const setup of setups) await acknowledge(t, setup, kid, guardian.personId);
    return { guardian, kid };
  }
  async function register(owner: Actor, kid: string, offeringId: string) {
    const basket = await basketWith(t, owner, [{ participantPersonId: kid, offeringId }]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, owner.header, {});
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, owner.header, {});
    return { held, completed };
  }
  const join = async (who: { guardian: Actor; kid: string }, offeringId: string) => {
    const joined = await post(t, '/v1/waitlist-entries', who.guardian.header, {
      offeringId,
      participantPersonId: who.kid,
      intent: 'youth',
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    return joined.body.id as string;
  };
  const entry = (id: string) =>
    t.db
      .selectFrom('waitlist_entries')
      .select(['status', 'removal_reason', 'offer_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const cancel = async (owner: Actor, enrollmentId: string) => {
    const row = await t.db
      .selectFrom('enrollments')
      .select('revision')
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    const res = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, owner.header, {
      expectedRevision: row.revision,
      reason: 'moved',
    });
    expect(res.status).toBe(200);
  };

  it('SPK-REG-008: a waiting participant who registers directly leaves the queue and the next place goes to the next waiter', async () => {
    const setup = await offering(t, {
      capacityUnits: [{ unit: 'seats', limit: 1 }],
      basePriceMinor: 0,
    });
    const x = await family([setup]);
    const xEnrollment = (await register(x.guardian, x.kid, setup.offeringId)).completed.body
      .lines[0].enrollmentId as string;
    const p = await family([setup]);
    const pEntry = await join(p, setup.offeringId);
    // The place comes back and P registers directly before the offer is generated.
    await cancel(x.guardian, xEnrollment);
    const direct = await register(p.guardian, p.kid, setup.offeringId);
    expect(direct.completed.body.status).toBe('fulfilled');
    await drain(t);
    expect(await entry(pEntry)).toEqual({
      status: 'removed',
      removal_reason: 'equivalent_entitlement',
      offer_count: 0,
    });
    // The next freed place is offered to the next real waiter, not to P.
    const q = await family([setup]);
    const qEntry = await join(q, setup.offeringId);
    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['id', 'revision'])
      .where('offering_id', '=', setup.offeringId)
      .executeTakeFirstOrThrow();
    const raised = await post(t, `/v1/capacity-pools/${pool.id}/adjust`, programManager.header, {
      capacity: 2,
      reason: 'Extra coach',
      expectedRevision: pool.revision,
    });
    expect(raised.status).toBe(200);
    await drain(t);
    expect((await entry(qEntry)).status).toBe('offered');
    expect((await entry(pEntry)).offer_count).toBe(0);
  });

  it('SPK-REG-008: an equivalent program-scoped enrollment in another offering retires the waitlist entry and declines its open offer', async () => {
    const programId = await createProgramFixture(t, {
      ageBand: { minAgeYears: 6, maxAgeYears: 12 },
    });
    const entitlementDefinitionId = await createEntitlementDefinitionFixture(t, {
      equivalenceScope: 'program',
    });
    const classOf = () =>
      offering(t, {
        programId,
        entitlementDefinitionId,
        capacityUnits: [{ unit: 'seats', limit: 1 }],
        basePriceMinor: 0,
      });
    const classA = await classOf();
    const classB = await classOf();
    const x = await family([classB]);
    const xEnrollment = (await register(x.guardian, x.kid, classB.offeringId)).completed.body
      .lines[0].enrollmentId as string;
    const p = await family([classA, classB]);
    const q = await family([classB]);
    const pEntry = await join(p, classB.offeringId);
    t.clock.advance(1000);
    const qEntry = await join(q, classB.offeringId);
    // B's place frees up: P (first in line) is offered it and the offer holds the seat.
    await cancel(x.guardian, xEnrollment);
    await drain(t);
    expect((await entry(pEntry)).status).toBe('offered');
    expect((await entry(qEntry)).status).toBe('waiting');
    // P enrolls in the sibling class A instead: the B entry and its offer are no longer wanted.
    const sibling = await register(p.guardian, p.kid, classA.offeringId);
    expect(sibling.completed.body.status).toBe('fulfilled');
    await drain(t);
    expect(await entry(pEntry)).toMatchObject({
      status: 'removed',
      removal_reason: 'equivalent_entitlement',
    });
    const offers = await t.db
      .selectFrom('waitlist_offers')
      .select('status')
      .where('waitlist_entry_id', '=', pEntry)
      .execute();
    expect(offers.map((o) => o.status)).toEqual(['declined']);
    // The seat P's offer held moves on to Q at once, not after the 48 h offer window.
    expect((await entry(qEntry)).status).toBe('offered');
  });

  it('SPK-REG-008: a session waitlist entry leaves the queue once its participant books the session', async () => {
    const adults = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const pickup = await offering(t, {
      kind: 'pickup',
      programId: adults,
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: pickup.offeringId,
      scheduledStart: new Date('2026-11-12T02:00:00Z'),
      scheduledEnd: new Date('2026-11-12T03:30:00Z'),
    });
    const player = async () => {
      const actor = await adult(t);
      await acknowledge(t, pickup, actor.personId, actor.personId);
      return actor;
    };
    const book = (actor: Actor) =>
      post(t, '/v1/session-bookings', actor.header, {
        offeringId: pickup.offeringId,
        sessionId,
        participantPersonId: actor.personId,
      });
    const a = await player();
    const c = await player();
    const first = await book(a);
    expect(first.status).toBe(201);
    const joined = await post(t, '/v1/waitlist-entries', c.header, {
      offeringId: pickup.offeringId,
      participantPersonId: c.personId,
      intent: 'pickup',
      sessionId,
    });
    expect(joined.status).toBe(201);
    const canceled = await post(
      t,
      `/v1/session-bookings/${first.body.id as string}/cancel`,
      a.header,
      {
        expectedRevision: first.body.revision,
        reason: 'Cannot make it',
      },
    );
    expect(canceled.status).toBe(200);
    // C books the freed seat directly before the offer is generated.
    const direct = await book(c);
    expect(direct.status).toBe(201);
    expect(direct.body.status).toBe('confirmed');
    await drain(t);
    expect(await entry(joined.body.id as string)).toMatchObject({
      status: 'removed',
      removal_reason: 'equivalent_entitlement',
      offer_count: 0,
    });
  });
});
