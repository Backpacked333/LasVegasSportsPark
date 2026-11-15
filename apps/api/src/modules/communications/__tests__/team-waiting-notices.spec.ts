import { newId, type DomainEvent } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, setCapability, type TestApp } from '../../../testing';
import {
  CompetitionEvents,
  CompetitionModule,
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { TeamWaitingNotices } from '../services/team-waiting-notices';
import { dispatchOutbox, recipientsOf } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const HOUR = 3_600_000;
const WAITING_EVENTS = [
  CompetitionEvents.teamPlaceOffered.type,
  CompetitionEvents.teamPlaceOfferResolved.type,
  CompetitionEvents.teamEntryStatusChanged.type,
];

interface Actor {
  personId: string;
  header: { Authorization: string };
}

/**
 * SPK-COMP-006 (QA M-5, M-7): the captain and co-captains of a waiting team are told when a place
 * is offered, what became of the offer, and when the team joins or leaves the waiting list. The
 * facts are announced by competition's own commands over the API and reach this module through
 * the outbox; nothing here writes a competition table.
 */
describe('team waiting list notices (SPK-COMP-006, QA M-5 and M-7)', () => {
  let t: TestApp;
  let org: string;
  let leagueManager: Actor;
  let seasonId: string;
  let seasonLabel: string;
  let keys = 0;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule, CompetitionModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
      capabilities: ['team_waitlist'],
    });
    org = t.organizationId;
    const staff = await createStaffMemberFixture(t, { roles: ['league_manager'] });
    leagueManager = {
      personId: staff.personId,
      header: await authHeaderForPerson(t, staff.personId),
    };
    const season = await createSeasonFixture(t, { status: 'open', name: 'Winter 2027' });
    seasonId = season.seasonId;
    const competition = await t.db
      .selectFrom('competitions')
      .select('name')
      .where('id', '=', season.competitionId)
      .executeTakeFirstOrThrow();
    seasonLabel = `${competition.name}, Winter 2027`;
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object = {}) =>
    t.http
      .post(`/v1${path}`)
      .set(actor.header)
      .set('Idempotency-Key', `team-waiting-notices-${(keys += 1)}`)
      .send(body);

  async function adult(): Promise<Actor> {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    return { personId, header: await authHeaderForPerson(t, personId) };
  }

  /** An applied, unplaced entry with a captain, a co-captain and one rostered player. */
  async function team(name: string) {
    const captain = await adult();
    const coCaptain = await adult();
    const player = await adult();
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      status: 'applied',
    });
    await assignTeamRoleFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: coCaptain.personId,
      role: 'co_captain',
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    return { captain, coCaptain, player, teamEntryId: entry.teamEntryId };
  }

  /** A division of one place that another team holds; `free()` gives the place back. */
  async function fullDivision(name: string, facilityId: string | null = null) {
    const divisionId = await createDivisionFixture(t, {
      seasonId,
      name,
      capacityTeamEntries: 1,
      facilityId,
    });
    const holder = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult()).personId,
      divisionId,
    });
    const free = async () => {
      const revision = await revisionOf('team_entries', holder.teamEntryId);
      const res = await post(`/team-entries/${holder.teamEntryId}/withdraw`, leagueManager, {
        expectedRevision: revision,
        reason: 'The team left the league.',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    return { divisionId, free };
  }

  const revisionOf = async (
    table: 'team_entries' | 'team_entry_place_offers',
    id: string,
  ): Promise<number> =>
    (await t.db.selectFrom(table).select('revision').where('id', '=', id).executeTakeFirstOrThrow())
      .revision;

  async function wait(teamEntryId: string, divisionId: string): Promise<void> {
    const res = await post(`/team-entries/${teamEntryId}/wait`, leagueManager, {
      divisionId,
      expectedRevision: await revisionOf('team_entries', teamEntryId),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function offer(teamEntryId: string): Promise<string> {
    const res = await post(`/team-entries/${teamEntryId}/place-offers`, leagueManager, {
      expectedRevision: await revisionOf('team_entries', teamEntryId),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.offer.id as string;
  }

  async function dispatch(): Promise<void> {
    const summary = await dispatchOutbox(t.app);
    expect(summary.dead).toBe(0);
  }

  /** The notices about one team entry or one of its offers, in the order they were composed. */
  const noticesAbout = (subjectId: string) =>
    t.db
      .selectFrom('notifications')
      .select(['id', 'kind', 'category', 'protected', 'subject_type', 'title', 'body', 'status'])
      .where('organization_id', '=', org)
      .where('subject_id', '=', subjectId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();

  const recipientIds = async (notificationId: string): Promise<string[]> =>
    (await recipientsOf(t.db, org, notificationId)).map((r) => r.person_id).sort();

  const eventOf = (type: string, aggregateId: string) =>
    t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', type)
      .where('aggregate_id', '=', aggregateId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();

  it('SPK-COMP-006: when staff move a team to waiting its captain and co-captain are told once; the offer of a freed place tells them which team and division, until when it is open and that it is answered in the app; a replay creates no second notice', async () => {
    const { divisionId, free } = await fullDivision('Monday Premier', t.facilityId);
    const falcons = await team('Falcons');
    await wait(falcons.teamEntryId, divisionId);
    await dispatch();

    const captains = [falcons.captain.personId, falcons.coCaptain.personId].sort();
    const [waiting, ...moreWaiting] = await noticesAbout(falcons.teamEntryId);
    expect(moreWaiting).toEqual([]);
    expect(waiting).toMatchObject({
      kind: 'team_waiting_list',
      category: 'operational',
      protected: true,
      subject_type: 'team_entry',
      title: 'On the waiting list: Falcons',
      body: `Falcons is on the waiting list of ${seasonLabel}. It holds no place and owes nothing while it waits; you will be told when a place is offered. Registrations players have already made are not changed by this.`,
      status: 'dispatched',
    });
    // captain and co-captain; a rostered player is not told
    expect(await recipientIds(waiting?.id as string)).toEqual(captains);

    await free();
    const offerId = await offer(falcons.teamEntryId);
    await dispatch();
    const [offered, ...moreOffered] = await noticesAbout(offerId);
    expect(moreOffered).toEqual([]);
    // 48 hours from 2026-10-23T12:00Z, read in the division's facility zone (America/Los_Angeles)
    expect(offered).toMatchObject({
      kind: 'team_place_offer',
      category: 'operational',
      protected: true,
      subject_type: 'team_entry_place_offer',
      title: 'Place offered: Falcons',
      body: 'A place in Monday Premier is offered to Falcons. The offer is open until Sun, Oct 25, 5:00 AM. Accept or decline it in the app.',
      status: 'dispatched',
    });
    expect(await recipientIds(offered?.id as string)).toEqual(captains);
    const stored = await t.db
      .selectFrom('notifications')
      .select(['facility_id', 'details_after'])
      .where('id', '=', offered?.id as string)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      facility_id: t.facilityId,
      details_after: {
        offerId,
        teamEntryId: falcons.teamEntryId,
        seasonId,
        divisionId,
        expiresAt: '2026-10-25T12:00:00.000Z',
        timezone: 'America/Los_Angeles',
      },
    });

    // Replay: the dispatcher redelivers both events, and the handlers are called again directly.
    const offeredEvent = await eventOf(
      CompetitionEvents.teamPlaceOffered.type,
      falcons.teamEntryId,
    );
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where('organization_id', '=', org)
      .where('aggregate_id', '=', falcons.teamEntryId)
      .where('event_type', 'in', WAITING_EVENTS)
      .execute();
    await dispatch();
    const replayed = {
      id: offeredEvent.id,
      type: offeredEvent.event_type,
      organizationId: org,
      aggregateType: offeredEvent.aggregate_type,
      aggregateId: offeredEvent.aggregate_id,
      payload: offeredEvent.payload,
      correlationId: null,
      operationId: null,
      occurredAt: t.clock.now().toISOString(),
    } as unknown as DomainEvent<never>;
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(TeamWaitingNotices).onTeamPlaceOffered(trx, replayed));
    expect(await noticesAbout(offerId)).toHaveLength(1);
    expect(await noticesAbout(falcons.teamEntryId)).toHaveLength(1);
  });

  it('SPK-COMP-006: an offer that is not answered expires and the captains are told the place is no longer held; the team stays on the list', async () => {
    const { divisionId, free } = await fullDivision('Tuesday Open');
    const herons = await team('Herons');
    await wait(herons.teamEntryId, divisionId);
    await free();
    const offerId = await offer(herons.teamEntryId);
    await dispatch();
    // The division names no facility: the instant is given in UTC and says so.
    expect((await noticesAbout(offerId))[0]?.body).toBe(
      'A place in Tuesday Open is offered to Herons. The offer is open until Sun, Oct 25, 12:00 PM (UTC). Accept or decline it in the app.',
    );

    t.clock.advance(48 * HOUR);
    await dispatch();
    await dispatch();
    const offerRow = await t.db
      .selectFrom('team_entry_place_offers')
      .select('status')
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    expect(offerRow.status).toBe('expired');
    const about = await noticesAbout(offerId);
    expect(about.map((n) => [n.kind, n.title])).toEqual([
      ['team_place_offer', 'Place offered: Herons'],
      ['team_waiting_list', 'Place offer expired: Herons'],
    ]);
    expect(about[1]).toMatchObject({
      category: 'operational',
      protected: true,
      body: 'The place offered to Herons in Tuesday Open was not answered in time and is no longer held. Herons stays on the waiting list.',
      status: 'dispatched',
    });
    expect(await recipientIds(about[1]?.id as string)).toEqual(
      [herons.captain.personId, herons.coCaptain.personId].sort(),
    );
    // the expiry timer redelivered: still one expiry notice
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where('organization_id', '=', org)
      .where('event_type', '=', CompetitionEvents.teamPlaceOfferResolved.type)
      .where('aggregate_id', '=', herons.teamEntryId)
      .execute();
    await dispatch();
    expect(await noticesAbout(offerId)).toHaveLength(2);
  });

  it('SPK-COMP-006: an offer withdrawn by staff, declined or accepted by the captain is told in one short notice each; accepting says the entry goes on to approval and payment', async () => {
    // Independent of the test before it, which moves the clock.
    t.clock.set(new Date('2026-11-02T12:00:00Z'));
    const { divisionId, free } = await fullDivision('Wednesday Coed');
    const kites = await team('Kites');
    await wait(kites.teamEntryId, divisionId);
    await free();

    const withdrawn = await offer(kites.teamEntryId);
    const withdrew = await post(`/team-entry-place-offers/${withdrawn}/withdraw`, leagueManager, {
      expectedRevision: await revisionOf('team_entry_place_offers', withdrawn),
      reason: 'Offered by mistake.',
    });
    expect(withdrew.status, JSON.stringify(withdrew.body)).toBe(200);
    await dispatch();
    expect((await noticesAbout(withdrawn)).map((n) => [n.kind, n.title, n.body])).toEqual([
      [
        'team_place_offer',
        'Place offered: Kites',
        'A place in Wednesday Coed is offered to Kites. The offer is open until Wed, Nov 4, 12:00 PM (UTC). Accept or decline it in the app.',
      ],
      [
        'team_waiting_list',
        'Place offer withdrawn: Kites',
        'League staff withdrew the place offered to Kites in Wednesday Coed. Kites stays on the waiting list.',
      ],
    ]);

    const declined = await offer(kites.teamEntryId);
    const declinedBy = await post(`/team-entry-place-offers/${declined}/decline`, kites.captain, {
      expectedRevision: await revisionOf('team_entry_place_offers', declined),
    });
    expect(declinedBy.status, JSON.stringify(declinedBy.body)).toBe(200);
    await dispatch();
    expect((await noticesAbout(declined)).map((n) => [n.title, n.body])[1]).toEqual([
      'Place declined: Kites',
      'The place offered to Kites in Wednesday Coed was declined. Kites stays on the waiting list.',
    ]);

    const accepted = await offer(kites.teamEntryId);
    const acceptedBy = await post(`/team-entry-place-offers/${accepted}/accept`, kites.captain, {
      expectedRevision: await revisionOf('team_entry_place_offers', accepted),
    });
    expect(acceptedBy.status, JSON.stringify(acceptedBy.body)).toBe(200);
    await dispatch();
    const about = await noticesAbout(accepted);
    expect(about.map((n) => [n.title, n.body])[1]).toEqual([
      'Place accepted: Kites',
      'Kites accepted the place offered in Wednesday Coed. The entry now follows the usual approval and payment steps.',
    ]);
    expect(await recipientIds(about[1]?.id as string)).toEqual(
      [kites.captain.personId, kites.coCaptain.personId].sort(),
    );
    // Leaving the list by accepting is told by the offer notice alone: the entry's own notices
    // are still only the one from the day it began to wait.
    expect((await noticesAbout(kites.teamEntryId)).map((n) => n.title)).toEqual([
      'On the waiting list: Kites',
    ]);
  });

  it('SPK-COMP-006: a waiting team that is withdrawn is told once that it left the list, also when an open offer closes with it; a status change that does not concern the waiting list tells nothing', async () => {
    const { divisionId, free } = await fullDivision('Thursday Masters');
    const swifts = await team('Swifts');
    await wait(swifts.teamEntryId, divisionId);
    await free();
    const offerId = await offer(swifts.teamEntryId);
    await dispatch();

    const withdrew = await post(`/team-entries/${swifts.teamEntryId}/withdraw`, swifts.captain, {
      expectedRevision: await revisionOf('team_entries', swifts.teamEntryId),
      reason: 'We cannot field a team this season.',
    });
    expect(withdrew.status, JSON.stringify(withdrew.body)).toBe(200);
    await dispatch();
    expect((await noticesAbout(swifts.teamEntryId)).map((n) => [n.kind, n.title, n.body])).toEqual([
      [
        'team_waiting_list',
        'On the waiting list: Swifts',
        `Swifts is on the waiting list of ${seasonLabel}. It holds no place and owes nothing while it waits; you will be told when a place is offered. Registrations players have already made are not changed by this.`,
      ],
      [
        'team_waiting_list',
        'No longer waiting: Swifts',
        `Swifts was withdrawn and is no longer on the waiting list of ${seasonLabel}.`,
      ],
    ]);
    // the offer closed with the entry: no separate "offer withdrawn" notice
    const offerRow = await t.db
      .selectFrom('team_entry_place_offers')
      .select('status')
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    expect(offerRow.status).toBe('withdrawn');
    expect((await noticesAbout(offerId)).map((n) => n.title)).toEqual(['Place offered: Swifts']);

    // An ordinary approval (applied to approved) is not a waiting-list fact.
    const open = await createDivisionFixture(t, { seasonId, name: 'Friday Open' });
    const terns = await team('Terns');
    const approved = await post(`/team-entries/${terns.teamEntryId}/approve`, leagueManager, {
      divisionId: open,
      expectedRevision: await revisionOf('team_entries', terns.teamEntryId),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');
    await dispatch();
    expect(await noticesAbout(terns.teamEntryId)).toEqual([]);
  });

  it('SPK-COMP-006: with the team waiting list turned off nothing waits and nothing is offered, so no event is announced and no notice is composed', async () => {
    const { divisionId } = await fullDivision('Saturday Rec');
    const wrens = await team('Wrens');
    await setCapability(t.db, org, 'team_waitlist', false);
    try {
      const refused = await post(`/team-entries/${wrens.teamEntryId}/wait`, leagueManager, {
        divisionId,
        expectedRevision: await revisionOf('team_entries', wrens.teamEntryId),
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      // a placement into the full division is refused as before the amendment, not made to wait
      const placed = await post(`/team-entries/${wrens.teamEntryId}/approve`, leagueManager, {
        divisionId,
        expectedRevision: await revisionOf('team_entries', wrens.teamEntryId),
      });
      expect(placed.status, JSON.stringify(placed.body)).toBe(409);
      await dispatch();
      const events = await t.db
        .selectFrom('outbox_events')
        .select('event_type')
        .where('organization_id', '=', org)
        .where('aggregate_id', '=', wrens.teamEntryId)
        .where('event_type', 'in', WAITING_EVENTS)
        .execute();
      expect(events).toEqual([]);
      expect(await noticesAbout(wrens.teamEntryId)).toEqual([]);
    } finally {
      await setCapability(t.db, org, 'team_waitlist', true);
    }
  });

  it('SPK-COMP-006: a fact about an entry nobody captains, or an unknown entry, composes nothing and does not fail', async () => {
    const unknown = {
      id: newId(),
      type: CompetitionEvents.teamPlaceOffered.type,
      organizationId: org,
      aggregateType: 'team_entry',
      aggregateId: newId(),
      payload: {
        offerId: newId(),
        teamEntryId: newId(),
        seasonId,
        divisionId: newId(),
        positionAtOffer: 1,
        expiresAt: '2026-10-25T12:00:00.000Z',
      },
      correlationId: null,
      operationId: null,
      occurredAt: t.clock.now().toISOString(),
    } as unknown as DomainEvent<never>;
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(TeamWaitingNotices).onTeamPlaceOffered(trx, unknown));
    const composed = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('organization_id', '=', org)
      .where('source_event_id', '=', unknown.id)
      .execute();
    expect(composed).toEqual([]);
  });
});
