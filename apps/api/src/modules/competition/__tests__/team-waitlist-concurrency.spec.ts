import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

/**
 * The last place of a division under overlapping commands (SPK-COMP-006, §4.7 invariant 3,
 * ADR-006 "two staff offering the last place at once"). Every placement and every offer locks the
 * division row before it counts (the entry row first, then the division), so the two commands
 * serialize and the loser sees the winner's row. Under TEST_DATABASE_URL the transactions really
 * overlap; under PGlite they run one after the other. The asserted outcome holds in both modes:
 * the placed entries and the open offers never exceed the capacity, whichever command wins.
 */
describe('team waiting list under concurrent commands (SPK-COMP-006, §4.7)', () => {
  let t: TestApp;
  let first: Actor;
  let second: Actor;

  beforeAll(async () => {
    t = await competitionTestApp({ capabilities: ['team_waitlist'] });
    first = await staffMember(t, ['league_manager']);
    second = await staffMember(t, ['general_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);

  /** A division with exactly one free place and two teams waiting for it. */
  async function lastPlace() {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 2,
    });
    await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId,
    });
    const waiting = [];
    for (let i = 0; i < 2; i += 1) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        status: 'waiting',
        waitingDivisionId: divisionId,
      });
      waiting.push({ id: entry.teamEntryId, captain });
    }
    return { seasonId: season.seasonId, divisionId, waiting };
  }

  async function occupancy(divisionId: string) {
    const placed = await t.db
      .selectFrom('team_entries')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('division_id', '=', divisionId)
      .where('status', 'in', ['applied', 'approved'])
      .executeTakeFirstOrThrow();
    const offers = await t.db
      .selectFrom('team_entry_place_offers')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('division_id', '=', divisionId)
      .where('status', '=', 'offered')
      .executeTakeFirstOrThrow();
    return { placed: Number(placed.n), openOffers: Number(offers.n) };
  }

  it('SPK-COMP-006: two staff offering the last place at once: exactly one offer is made, the other is refused with CAPACITY_UNAVAILABLE', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { divisionId, waiting } = await lastPlace();
      const [a, b] = await Promise.all([
        post(`/team-entries/${waiting[0]!.id}/place-offers`, first, { expectedRevision: 1 }),
        post(`/team-entries/${waiting[1]!.id}/place-offers`, second, { expectedRevision: 1 }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, JSON.stringify([a.body, b.body])).toEqual([201, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body).toMatchObject({
        code: 'CAPACITY_UNAVAILABLE',
        details: { divisionId, capacity: 2, occupied: 2, heldByOffers: 1 },
      });
      expect(await occupancy(divisionId)).toEqual({ placed: 1, openOffers: 1 });
    }
  });

  it('SPK-COMP-006: the same entry offered twice at once: one open offer, never two', async () => {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 5,
    });
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      status: 'waiting',
      waitingDivisionId: divisionId,
    });
    const [a, b] = await Promise.all([
      post(`/team-entries/${entry.teamEntryId}/place-offers`, first, { expectedRevision: 1 }),
      post(`/team-entries/${entry.teamEntryId}/place-offers`, second, { expectedRevision: 1 }),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'OFFER_ALREADY_OPEN' },
    });
    expect(await occupancy(divisionId)).toEqual({ placed: 0, openOffers: 1 });
  });

  it('SPK-COMP-006 / SPK-COMP-004: an approval racing an offer for the last place: one of them takes it; the approval that loses makes its entry wait, the offer that loses is refused', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { seasonId, divisionId, waiting } = await lastPlace();
      const applied = await createTeamEntryFixture(t, {
        seasonId,
        captainPersonId: (await adultCustomer(t)).personId,
        status: 'applied',
      });
      const [approval, offer] = await Promise.all([
        post(`/team-entries/${applied.teamEntryId}/approve`, first, {
          divisionId,
          expectedRevision: 1,
        }),
        post(`/team-entries/${waiting[0]!.id}/place-offers`, second, { expectedRevision: 1 }),
      ]);
      expect(approval.status, JSON.stringify(approval.body)).toBe(200);
      const after = await occupancy(divisionId);
      // The capacity (2) is never exceeded, whichever command reached the division first.
      expect(after.placed + after.openOffers).toBe(2);
      if (offer.status === 201) {
        // The offer holds the place: the approval found the division full and the entry waits.
        expect(approval.body).toMatchObject({ status: 'waiting', divisionId: null });
        expect(after).toEqual({ placed: 1, openOffers: 1 });
      } else {
        expect(offer.status).toBe(409);
        expect(offer.body).toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
        expect(approval.body).toMatchObject({ status: 'approved', divisionId });
        expect(after).toEqual({ placed: 2, openOffers: 0 });
      }
    }
  });

  it('SPK-COMP-006: an acceptance racing the withdrawal of the same offer: the offer is resolved once', async () => {
    const { divisionId, waiting } = await lastPlace();
    const offered = await post(`/team-entries/${waiting[0]!.id}/place-offers`, first, {
      expectedRevision: 1,
    });
    expect(offered.status).toBe(201);
    const offerId = offered.body.offer.id as string;
    const [accept, withdraw] = await Promise.all([
      post(`/team-entry-place-offers/${offerId}/accept`, waiting[0]!.captain, {
        expectedRevision: 1,
      }),
      post(`/team-entry-place-offers/${offerId}/withdraw`, second, {
        expectedRevision: 1,
        reason: 'Offered by mistake',
      }),
    ]);
    expect([accept.status, withdraw.status].sort()).toEqual([200, 409]);
    const offer = await t.db
      .selectFrom('team_entry_place_offers')
      .select(['status', 'revision'])
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    expect(offer.revision).toBe(2);
    const entry = await t.db
      .selectFrom('team_entries')
      .select(['status', 'division_id'])
      .where('id', '=', waiting[0]!.id)
      .executeTakeFirstOrThrow();
    if (accept.status === 200) {
      expect(offer.status).toBe('accepted');
      expect(entry).toEqual({ status: 'applied', division_id: divisionId });
    } else {
      expect(offer.status).toBe('withdrawn');
      expect(entry).toEqual({ status: 'waiting', division_id: null });
    }
  });
});
