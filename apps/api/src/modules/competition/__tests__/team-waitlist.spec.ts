import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOutboxChecked, setCapability, type TestApp } from '../../../testing';
import { seedResource } from '../../scheduling';
import { TeamWaitlistService } from '../services/team-waitlist.service';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

type Json = Record<string, unknown>;
const HOUR = 3_600_000;

/**
 * Team waiting list (SPK-COMP-006, proposed amendment PA-10; capability `team_waitlist`). The
 * values an operator has not decided (DEC-104) are the proposed defaults: staff choose the entry,
 * an offer stands 48 hours.
 */
describe('team waiting list (SPK-COMP-006)', () => {
  let t: TestApp;
  let leagueManager: Actor;

  beforeAll(async () => {
    t = await competitionTestApp({ capabilities: ['team_waitlist'] });
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  /** A season with one division of the given capacity, filled with approved teams. */
  async function fullDivision(capacity = 1): Promise<{
    season: SeasonFixture;
    divisionId: string;
    placed: Array<{ teamEntryId: string; captain: Actor }>;
  }> {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: capacity,
    });
    const placed = [];
    for (let i = 0; i < capacity; i += 1) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        divisionId,
      });
      placed.push({ teamEntryId: entry.teamEntryId, captain });
    }
    return { season, divisionId, placed };
  }

  /** A captain enters a team over the API; the entry is applied and unplaced. */
  async function enter(seasonId: string, name: string) {
    const captain = await adultCustomer(t);
    const res = await post('/team-entries', captain, { seasonId, team: { name } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return {
      captain,
      id: res.body.entry.id as string,
      revision: res.body.entry.revision as number,
    };
  }

  const revisionOf = async (entryId: string): Promise<number> =>
    (
      await t.db
        .selectFrom('team_entries')
        .select('revision')
        .where('id', '=', entryId)
        .executeTakeFirstOrThrow()
    ).revision;

  const list = async (seasonId: string, divisionId: string) => {
    const res = await get(
      `/seasons/${seasonId}/waiting-list?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.lists[0] as Json & { entries: Array<Json & { teamName: string }> };
  };

  it('SPK-COMP-006: a team entry waits when the division has no free place, keeps its order, holds no place and owes nothing; staff offer the freed place to the entry they choose with the order shown; accepting returns it to the approval path (SPK-COMP-004)', async () => {
    const { season, divisionId, placed } = await fullDivision(1);
    // A placement that meets a full division makes the entry wait (automatic, capability on).
    const bravo = await enter(season.seasonId, 'Bravo');
    const placedFull = await post(`/team-entries/${bravo.id}/approve`, leagueManager, {
      divisionId,
      expectedRevision: bravo.revision,
    });
    expect(placedFull.status, JSON.stringify(placedFull.body)).toBe(200);
    const waitingSince = t.clock.now().toISOString();
    expect(placedFull.body).toMatchObject({
      status: 'waiting',
      divisionId: null,
      waitingDivisionId: divisionId,
      waitingSince,
      approvedAt: null,
      financialStatusRef: null,
    });
    // Staff put a second entry on the list themselves, a minute later.
    t.clock.advance(60_000);
    const charlie = await enter(season.seasonId, 'Charlie');
    const waited = await post(`/team-entries/${charlie.id}/wait`, leagueManager, {
      divisionId,
      expectedRevision: charlie.revision,
    });
    expect(waited.status, JSON.stringify(waited.body)).toBe(200);
    expect(waited.body).toMatchObject({ status: 'waiting', divisionId: null });

    // The list shows the order and that no place is free.
    expect(await list(season.seasonId, divisionId)).toMatchObject({
      capacity: 1,
      placed: 1,
      openOffers: 0,
      freePlaces: 0,
      entries: [
        { position: 1, teamName: 'Bravo', teamEntryId: bravo.id, waitingSince, openOffer: null },
        { position: 2, teamName: 'Charlie', teamEntryId: charlie.id, openOffer: null },
      ],
    });
    // No place, no offer.
    const noPlace = await post(`/team-entries/${charlie.id}/place-offers`, leagueManager, {
      expectedRevision: await revisionOf(charlie.id),
    });
    expect(noPlace.status).toBe(409);
    expect(noPlace.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { divisionId, capacity: 1, occupied: 1 },
    });

    // A place opens: the placed team withdraws.
    const leaving = placed[0]!;
    const withdrawn = await post(`/team-entries/${leaving.teamEntryId}/withdraw`, leagueManager, {
      expectedRevision: await revisionOf(leaving.teamEntryId),
      reason: 'Team folded',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(await list(season.seasonId, divisionId)).toMatchObject({ placed: 0, freePlaces: 1 });

    // Staff choose Charlie, second in the order; the offer records the order it was made in.
    const offered = await post(`/team-entries/${charlie.id}/place-offers`, leagueManager, {
      expectedRevision: await revisionOf(charlie.id),
      note: 'Bravo asked to wait for the spring season',
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const offerId = offered.body.offer.id as string;
    expect(offered.body.offer).toMatchObject({
      teamEntryId: charlie.id,
      divisionId,
      status: 'offered',
      positionAtOffer: 2,
      offeredAt: t.clock.now().toISOString(),
      // 48 hours by proposed default (DEC-104).
      expiresAt: new Date(t.clock.now().getTime() + 48 * HOUR).toISOString(),
      resolvedAt: null,
    });
    expect(offered.body.entry).toMatchObject({ status: 'waiting', divisionId: null });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', offerId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: 'competition.offer_team_place',
      details: { positionAtOffer: 2, listLength: 2, followedOrder: false },
    });

    // The open offer holds the place: it cannot be offered or given to anyone else meanwhile.
    expect(await list(season.seasonId, divisionId)).toMatchObject({
      placed: 0,
      openOffers: 1,
      freePlaces: 0,
    });
    const second = await post(`/team-entries/${bravo.id}/place-offers`, leagueManager, {
      expectedRevision: await revisionOf(bravo.id),
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { capacity: 1, occupied: 1, heldByOffers: 1 },
    });
    const delta = await enter(season.seasonId, 'Delta');
    const deltaPlaced = await post(`/team-entries/${delta.id}/approve`, leagueManager, {
      divisionId,
      expectedRevision: delta.revision,
    });
    expect(deltaPlaced.body).toMatchObject({ status: 'waiting', divisionId: null });

    // The captain sees the wait, the order and the offer in the workspace.
    const workspace = await get(`/team-entries/${charlie.id}`, charlie.captain);
    expect(workspace.status).toBe(200);
    expect(workspace.body.waiting).toMatchObject({
      division: { id: divisionId },
      position: 2,
      listLength: 3,
      openOffer: { id: offerId, status: 'offered', divisionId },
    });
    expect(workspace.body.readiness.issues).toContainEqual(
      expect.objectContaining({ code: 'entry_waiting', responsibleRole: 'league_manager' }),
    );
    expect(workspace.body.viewer.availableActions).toEqual(
      expect.arrayContaining([
        'competition.accept_team_place_offer',
        'competition.decline_team_place_offer',
        'competition.withdraw_team_entry',
      ]),
    );
    // A waiting team is listed among the captain's teams, with no fixture.
    const mine = await get('/me/team-entries', charlie.captain);
    expect(mine.body).toEqual([
      expect.objectContaining({
        teamEntry: expect.objectContaining({ id: charlie.id, status: 'waiting' }),
        nextFixture: null,
      }),
    ]);

    // Another captain cannot answer the offer; the record is not revealed (§4.10).
    const stranger = await post(`/team-entry-place-offers/${offerId}/accept`, bravo.captain, {
      expectedRevision: 1,
    });
    expect(stranger.status).toBe(404);

    // The captain accepts: the entry is applied in the division, for the ordinary approval path.
    const accepted = await post(`/team-entry-place-offers/${offerId}/accept`, charlie.captain, {
      expectedRevision: 1,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.offer).toMatchObject({
      status: 'accepted',
      resolvedAt: t.clock.now().toISOString(),
    });
    expect(accepted.body.entry).toMatchObject({
      status: 'applied',
      divisionId,
      waitingSince: null,
      waitingDivisionId: null,
      approvedAt: null,
    });
    const approved = await post(`/team-entries/${charlie.id}/approve`, leagueManager, {
      expectedRevision: accepted.body.entry.revision,
    });
    expect(approved.body).toMatchObject({ status: 'approved', divisionId });
    // The others keep their order.
    expect(await list(season.seasonId, divisionId)).toMatchObject({
      placed: 1,
      openOffers: 0,
      freePlaces: 0,
      entries: [
        { position: 1, teamName: 'Bravo', waitingSince },
        { position: 2, teamName: 'Delta' },
      ],
    });
    // The offers of an entry are a record staff and the captain can read.
    const history = await get(`/team-entries/${charlie.id}/place-offers`, leagueManager);
    expect(history.body).toEqual([expect.objectContaining({ id: offerId, status: 'accepted' })]);
  });

  it('SPK-COMP-006 (security review L-5): the offers of an entry are read by league staff and its captain; to anybody else an existing entry answers exactly like an unknown one', async () => {
    const { season, placed } = await fullDivision(1);
    const entry = placed[0]!;
    const outsider = await adultCustomer(t);
    const otherCaptain = (await enter(season.seasonId, 'Hotel')).captain;
    const answer = (res: { status: number; body: Json }) => ({
      status: res.status,
      code: res.body['code'],
      message: res.body['message'],
      details: res.body['details'],
    });
    const read = (actor: Actor, entryId: string) =>
      get(`/team-entries/${entryId}/place-offers`, actor);
    const unknown = answer(await read(outsider, newId()));
    expect(unknown).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // An entry that exists, read by a person outside it and by the captain of another team.
    expect(answer(await read(outsider, entry.teamEntryId))).toEqual(unknown);
    expect(answer(await read(otherCaptain, entry.teamEntryId))).toEqual(unknown);
    // The answer names no id, so it cannot differ by which id was asked for.
    expect(JSON.stringify(unknown)).not.toContain(entry.teamEntryId);
    // Its captain and league staff read it.
    expect((await read(entry.captain, entry.teamEntryId)).status).toBe(200);
    expect((await read(leagueManager, entry.teamEntryId)).status).toBe(200);
    expect(answer(await read(leagueManager, newId()))).toEqual(unknown);
  });

  it('SPK-COMP-006: an offer expires at its expiry by a timer; the entry keeps its place in the order, the place is free again, and replaying the timer changes nothing', async () => {
    const { season, divisionId } = await fullDivision(1);
    const echo = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      status: 'waiting',
      waitingDivisionId: divisionId,
    });
    t.clock.advance(1000);
    const foxtrotCaptain = await adultCustomer(t);
    const foxtrot = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: foxtrotCaptain.personId,
      status: 'waiting',
      waitingDivisionId: divisionId,
    });
    await t.db
      .updateTable('divisions')
      .set({ capacity_team_entries: 2 })
      .where('id', '=', divisionId)
      .execute();
    const offered = await post(`/team-entries/${foxtrot.teamEntryId}/place-offers`, leagueManager, {
      expectedRevision: 1,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const offerId = offered.body.offer.id as string;
    // One open offer per entry.
    const again = await post(`/team-entries/${foxtrot.teamEntryId}/place-offers`, leagueManager, {
      expectedRevision: 1,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'OFFER_ALREADY_OPEN' },
    });

    // Before the expiry the timer is not due.
    t.clock.advance(47 * HOUR);
    await drainOutboxChecked(t);
    expect((await list(season.seasonId, divisionId)).entries[1]).toMatchObject({
      openOffer: { id: offerId, status: 'offered' },
    });
    // At the expiry an answer is too late even before the timer has run.
    t.clock.advance(HOUR);
    const late = await post(`/team-entry-place-offers/${offerId}/accept`, foxtrotCaptain, {
      expectedRevision: 1,
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'OFFER_EXPIRED' },
    });
    await drainOutboxChecked(t);
    const expired = await t.db
      .selectFrom('team_entry_place_offers')
      .selectAll()
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    expect(expired).toMatchObject({ status: 'expired', revision: 2 });
    expect(expired.resolved_by).toMatchObject({ kind: 'system' });
    expect(await list(season.seasonId, divisionId)).toMatchObject({
      openOffers: 0,
      freePlaces: 1,
      entries: [
        { position: 1, teamEntryId: echo.teamEntryId },
        { position: 2, teamEntryId: foxtrot.teamEntryId, openOffer: null },
      ],
    });
    // Idempotent under replay: the handler leaves a settled offer alone.
    const waitlist = t.app.get(TeamWaitlistService);
    const replayed = await t.db
      .transaction()
      .execute((trx) => waitlist.expireIfDue(trx, t.organizationId, offerId, null));
    expect(replayed).toBe(false);
    const audits = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', offerId)
      .where('action', '=', 'competition.expire_team_place_offer')
      .execute();
    expect(audits).toHaveLength(1);
    // The entry can be offered the place again.
    const reoffered = await post(
      `/team-entries/${foxtrot.teamEntryId}/place-offers`,
      leagueManager,
      { expectedRevision: 1 },
    );
    expect(reoffered.status, JSON.stringify(reoffered.body)).toBe(201);
  });

  it('SPK-COMP-006: the offer lifetime is configuration (COMPETITION_TEAM_PLACE_OFFER_HOURS)', async () => {
    const short = await competitionTestApp({
      capabilities: ['team_waitlist'],
      env: { COMPETITION_TEAM_PLACE_OFFER_HOURS: '6' },
    });
    try {
      const staff = await staffMember(short, ['league_manager']);
      const season = await createSeasonFixture(short, { status: 'open' });
      const divisionId = await createDivisionFixture(short, {
        seasonId: season.seasonId,
        capacityTeamEntries: 1,
      });
      const entry = await createTeamEntryFixture(short, {
        seasonId: season.seasonId,
        captainPersonId: (await adultCustomer(short)).personId,
        status: 'waiting',
        waitingDivisionId: divisionId,
      });
      const offered = await short.http
        .post(`/v1/team-entries/${entry.teamEntryId}/place-offers`)
        .set(staff.header)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: 1 });
      expect(offered.status, JSON.stringify(offered.body)).toBe(201);
      expect(offered.body.offer.expiresAt).toBe(
        new Date(short.clock.now().getTime() + 6 * HOUR).toISOString(),
      );
      const lists = await short.http
        .get(`/v1/seasons/${season.seasonId}/waiting-list`)
        .set(staff.header);
      expect(lists.body.offerHours).toBe(6);
    } finally {
      await short.close();
    }
  });

  it('SPK-COMP-006: a captain declines an offer and keeps the place in the order; staff withdraw an offer; a captain withdraws a waiting team and its open offer closes with it', async () => {
    const { season, divisionId } = await fullDivision(1);
    const golf = await enter(season.seasonId, 'Golf');
    const waiting = await post(`/team-entries/${golf.id}/wait`, leagueManager, {
      divisionId,
      expectedRevision: golf.revision,
    });
    expect(waiting.status).toBe(200);
    await t.db
      .updateTable('divisions')
      .set({ capacity_team_entries: 2 })
      .where('id', '=', divisionId)
      .execute();
    const offer = async () => {
      const res = await post(`/team-entries/${golf.id}/place-offers`, leagueManager, {
        expectedRevision: await revisionOf(golf.id),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.offer.id as string;
    };
    // Decline: only the captain or league staff; the entry stays where it was in the order.
    const first = await offer();
    const member = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId: golf.id, personId: member.personId });
    const byMember = await post(`/team-entry-place-offers/${first}/decline`, member, {
      expectedRevision: 1,
    });
    // Refused as not visible (§4.10): the protected command never tells a non-captain more.
    expect(byMember.status).toBe(404);
    // A rostered member still sees that the team waits.
    const memberView = await get(`/team-entries/${golf.id}`, member);
    expect(memberView.body.waiting).toMatchObject({ position: 1, openOffer: { id: first } });
    const declined = await post(`/team-entry-place-offers/${first}/decline`, golf.captain, {
      expectedRevision: 1,
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.offer).toMatchObject({ status: 'declined' });
    expect(declined.body.entry).toMatchObject({
      status: 'waiting',
      waitingSince: waiting.body.waitingSince,
    });
    const stale = await post(`/team-entry-place-offers/${first}/decline`, golf.captain, {
      expectedRevision: 2,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('INVALID_TRANSITION');
    // Withdraw an offer: league staff only.
    const secondOffer = await offer();
    const byCaptain = await post(`/team-entry-place-offers/${secondOffer}/withdraw`, golf.captain, {
      expectedRevision: 1,
      reason: 'x',
    });
    expect(byCaptain.status).toBe(403);
    const pulled = await post(`/team-entry-place-offers/${secondOffer}/withdraw`, leagueManager, {
      expectedRevision: 1,
      reason: 'Offered by mistake',
    });
    expect(pulled.body.offer).toMatchObject({
      status: 'withdrawn',
      resolutionReason: 'Offered by mistake',
    });
    // The captain withdraws the waiting team; the open offer closes and frees its place.
    const third = await offer();
    const out = await post(`/team-entries/${golf.id}/withdraw`, golf.captain, {
      expectedRevision: await revisionOf(golf.id),
      reason: 'We joined another league',
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body).toMatchObject({
      status: 'withdrawn',
      waitingSince: null,
      waitingDivisionId: null,
    });
    const closed = await t.db
      .selectFrom('team_entry_place_offers')
      .select(['status', 'resolution_reason'])
      .where('id', '=', third)
      .executeTakeFirstOrThrow();
    expect(closed).toEqual({ status: 'withdrawn', resolution_reason: 'The entry was withdrawn.' });
    expect(await list(season.seasonId, divisionId)).toMatchObject({
      openOffers: 0,
      freePlaces: 1,
      entries: [],
    });
  });

  it('SPK-COMP-006: a team waits only where there is no free place, without a place of its own and owing nothing; a season-wide wait needs every division full', async () => {
    const season = await createSeasonFixture(t, { status: 'open' });
    const roomy = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 2,
    });
    const hotel = await enter(season.seasonId, 'Hotel');
    const hasRoom = await post(`/team-entries/${hotel.id}/wait`, leagueManager, {
      divisionId: roomy,
      expectedRevision: hotel.revision,
    });
    expect(hasRoom.status).toBe(409);
    expect(hasRoom.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'DIVISION_HAS_ROOM' },
    });
    const seasonHasRoom = await post(`/team-entries/${hotel.id}/wait`, leagueManager, {
      expectedRevision: hotel.revision,
    });
    expect(seasonHasRoom.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'SEASON_HAS_ROOM', divisionsWithRoom: [roomy] },
    });
    // Only league management makes an entry wait.
    const byCaptain = await post(`/team-entries/${hotel.id}/wait`, hotel.captain, {
      expectedRevision: hotel.revision,
    });
    expect(byCaptain.status).toBe(403);
    // Fill the division: now the season has no free place and the entry may wait for any.
    for (const name of ['India', 'Juliet']) {
      const entry = await enter(season.seasonId, name);
      const res = await post(`/team-entries/${entry.id}/approve`, leagueManager, {
        divisionId: roomy,
        expectedRevision: entry.revision,
      });
      expect(res.body.status).toBe('approved');
    }
    const seasonWide = await post(`/team-entries/${hotel.id}/wait`, leagueManager, {
      expectedRevision: hotel.revision,
    });
    expect(seasonWide.status, JSON.stringify(seasonWide.body)).toBe(200);
    expect(seasonWide.body).toMatchObject({ status: 'waiting', waitingDivisionId: null });
    const lists = await get(`/seasons/${season.seasonId}/waiting-list`, leagueManager);
    expect(lists.body.lists).toEqual([
      expect.objectContaining({ division: { id: roomy, name: expect.any(String) }, entries: [] }),
      expect.objectContaining({
        division: null,
        capacity: null,
        entries: [expect.objectContaining({ position: 1, teamName: 'Hotel' })],
      }),
    ]);
    // An offer to a season-wide waiter names the division.
    const unnamed = await post(`/team-entries/${hotel.id}/place-offers`, leagueManager, {
      expectedRevision: seasonWide.body.revision,
    });
    expect(unnamed.status).toBe(400);
    // An entry that holds a place, or for which an obligation is recorded, does not wait: the
    // placement into a full division is refused as it always was.
    const { divisionId: full } = await (async () => ({
      divisionId: await createDivisionFixture(t, {
        seasonId: season.seasonId,
        capacityTeamEntries: 1,
      }),
    }))();
    await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId: full,
    });
    const owing = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      status: 'applied',
      financialStatusRef: 'obligation-1',
    });
    const refused = await post(`/team-entries/${owing.teamEntryId}/approve`, leagueManager, {
      divisionId: full,
      expectedRevision: 1,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      details: { capacity: 1, occupied: 1 },
    });
    const owingWait = await post(`/team-entries/${owing.teamEntryId}/wait`, leagueManager, {
      divisionId: full,
      expectedRevision: 1,
    });
    expect(owingWait.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'ENTRY_HAS_OBLIGATION' },
    });
    // A staff entry created straight into a full division waits for it.
    const created = await post('/team-entries', leagueManager, {
      seasonId: season.seasonId,
      team: { name: 'Kilo' },
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId: full,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.entry).toMatchObject({
      status: 'waiting',
      divisionId: null,
      waitingDivisionId: full,
    });
    // A waiting entry is still the team's one live entry in the season (§4.7 invariant 2).
    const duplicate = await post('/team-entries', leagueManager, {
      seasonId: season.seasonId,
      teamId: created.body.team.id,
      captainPersonId: (await adultCustomer(t)).personId,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_ENTITLEMENT');
  });

  it('SPK-COMP-006: waiting entries are excluded from schedules, fixture generation, standings and season counts', async () => {
    const { season, divisionId, placed } = await fullDivision(2);
    const lima = await enter(season.seasonId, 'Lima');
    const waiting = await post(`/team-entries/${lima.id}/approve`, leagueManager, {
      divisionId,
      expectedRevision: lima.revision,
    });
    expect(waiting.body.status).toBe('waiting');

    // Counts: the division's capacity consumption and the season's entries by status.
    const divisions = await get(`/divisions?seasonId=${season.seasonId}`, leagueManager);
    expect(divisions.body).toEqual([
      expect.objectContaining({ id: divisionId, capacityTeamEntries: 2, entryCount: 2 }),
    ]);
    const approvedEntries = await get(
      `/team-entries?seasonId=${season.seasonId}&status=approved`,
      leagueManager,
    );
    expect(approvedEntries.body.map((e: Json) => e['id']).sort()).toEqual(
      placed.map((p) => p.teamEntryId).sort(),
    );
    const inDivision = await get(
      `/team-entries?seasonId=${season.seasonId}&divisionId=${divisionId}`,
      leagueManager,
    );
    expect(inDivision.body).toHaveLength(2);

    // Schedules: a fixture cannot name a waiting entry.
    const fixture = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      round: 1,
      homeEntryId: placed[0]!.teamEntryId,
      awayEntryId: lima.id,
    });
    expect(fixture.status).toBeGreaterThanOrEqual(400);
    expect(
      await t.db
        .selectFrom('fixtures')
        .select('id')
        .where('season_id', '=', season.seasonId)
        .execute(),
    ).toEqual([]);
    // Fixture generation takes the approved entries of the division only.
    const pitch = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Waitlist pitch',
    });
    const specification = await post(
      `/divisions/${divisionId}/fixture-specifications`,
      leagueManager,
      {
        name: 'League phase',
        facilityId: t.facilityId,
        gamesPerTeam: 2,
        opponentFrequency: 2,
        startsOn: '2027-01-16',
        endsOn: '2027-04-10',
        minimumRestMinutes: 60,
        allowedStartTimes: [{ weekday: 6, time: '09:00' }],
        matchDurationMinutes: 60,
        requiredResourceIds: [pitch.resourceId],
      },
    );
    expect(specification.status, JSON.stringify(specification.body)).toBe(201);
    expect([...specification.body.teamEntryIds].sort()).toEqual(
      placed.map((p) => p.teamEntryId).sort(),
    );

    // Standings: the table lists the placed teams only.
    const standings = await get(
      `/seasons/${season.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(standings.status, JSON.stringify(standings.body)).toBe(200);
    expect(standings.body.rows.map((row: Json) => row['teamEntryId']).sort()).toEqual(
      placed.map((p) => p.teamEntryId).sort(),
    );
    // The roster of a waiting team is closed until it has a place.
    const invite = await post(`/team-entries/${lima.id}/invitations`, lima.captain, {
      recipientPersonId: (await adultCustomer(t)).personId,
    });
    expect(invite.status).toBeGreaterThanOrEqual(400);
  });

  it('SPK-COMP-006 capability off: declining, withdrawing and expiring still work, so an organization can wind its lists down; waiting, offering and accepting are refused', async () => {
    const { season, divisionId } = await fullDivision(1);
    const captain = await adultCustomer(t);
    const mike = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      status: 'waiting',
      waitingDivisionId: divisionId,
    });
    await t.db
      .updateTable('divisions')
      .set({ capacity_team_entries: 3 })
      .where('id', '=', divisionId)
      .execute();
    const offered = await post(`/team-entries/${mike.teamEntryId}/place-offers`, leagueManager, {
      expectedRevision: 1,
    });
    const offerId = offered.body.offer.id as string;
    await setCapability(t.db, t.organizationId, 'team_waitlist', false);
    try {
      const accept = await post(`/team-entry-place-offers/${offerId}/accept`, captain, {
        expectedRevision: 1,
      });
      expect(accept.status).toBe(403);
      expect(accept.body).toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'CAPABILITY_DISABLED', capability: 'team_waitlist' },
      });
      const offerAgain = await post(
        `/team-entries/${mike.teamEntryId}/place-offers`,
        leagueManager,
        {
          expectedRevision: 1,
        },
      );
      expect(offerAgain.body).toMatchObject({ details: { code: 'CAPABILITY_DISABLED' } });
      // The existing record stays readable and can be closed.
      const workspace = await get(`/team-entries/${mike.teamEntryId}`, captain);
      expect(workspace.body.waiting).toMatchObject({ position: 1, openOffer: { id: offerId } });
      const declined = await post(`/team-entry-place-offers/${offerId}/decline`, captain, {
        expectedRevision: 1,
      });
      expect(declined.status, JSON.stringify(declined.body)).toBe(200);
      const out = await post(`/team-entries/${mike.teamEntryId}/withdraw`, captain, {
        expectedRevision: 1,
        reason: 'No longer interested',
      });
      expect(out.body).toMatchObject({ status: 'withdrawn' });
    } finally {
      await setCapability(t.db, t.organizationId, 'team_waitlist', true);
    }
  });
});

/** With the switch off nothing changes for an organization that has not accepted the amendment. */
describe('team waiting list, capability off (SPK-COMP-006, ADR-002)', () => {
  let t: TestApp;
  let leagueManager: Actor;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);

  it('SPK-COMP-006 capability off: a full division refuses a placement exactly as before (CAPACITY_UNAVAILABLE with the capacity and the number occupied); nothing waits and the waiting commands answer CAPABILITY_DISABLED', async () => {
    const season = await createSeasonFixture(t, { status: 'open' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      capacityTeamEntries: 1,
    });
    await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId,
    });
    const captain = await adultCustomer(t);
    const created = await post('/team-entries', captain, {
      seasonId: season.seasonId,
      team: { name: 'Latecomers' },
    });
    const entryId = created.body.entry.id as string;
    const full = await post(`/team-entries/${entryId}/approve`, leagueManager, {
      divisionId,
      expectedRevision: 1,
    });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('CAPACITY_UNAVAILABLE');
    expect(full.body.details).toEqual({ divisionId, capacity: 1, occupied: 1 });
    const staffCreate = await post('/team-entries', leagueManager, {
      seasonId: season.seasonId,
      team: { name: 'Placed late' },
      captainPersonId: (await adultCustomer(t)).personId,
      divisionId,
    });
    expect(staffCreate.status).toBe(409);
    expect(staffCreate.body).toMatchObject({
      code: 'CAPACITY_UNAVAILABLE',
      message: 'The division is full.',
      details: { divisionId },
    });
    const entry = await t.db
      .selectFrom('team_entries')
      .select(['status', 'waiting_since', 'division_id'])
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ status: 'applied', waiting_since: null, division_id: null });
    const wait = await post(`/team-entries/${entryId}/wait`, leagueManager, {
      divisionId,
      expectedRevision: 1,
    });
    expect(wait.status).toBe(403);
    expect(wait.body).toMatchObject({
      code: 'ACCESS_DENIED',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'team_waitlist',
        applicabilityReferences: ['DEC-016', 'DEC-104'],
      },
    });
    // The list read stays available and is empty.
    const lists = await t.http
      .get(`/v1/seasons/${season.seasonId}/waiting-list`)
      .set(leagueManager.header);
    expect(lists.status).toBe(200);
    expect(lists.body.lists).toEqual([
      expect.objectContaining({ capacity: 1, placed: 1, freePlaces: 0, entries: [] }),
    ]);
  });
});
