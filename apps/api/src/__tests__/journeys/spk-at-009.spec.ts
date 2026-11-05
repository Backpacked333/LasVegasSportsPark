import { newId, type DomainEvent } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher, UnitOfWork } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import {
  createOfferingFixture,
  createProgramFixture,
  SessionsService,
} from '../../modules/catalog';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import { createEnrollmentFixture } from '../../modules/enrollment';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../modules/identity';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing';

const key = () => `k-${newId()}`;
const DAY = '2027-01-16';

/**
 * SPK-AT-009 (spec §6.1): "Field closure affects youth and adult bookings — complete impact
 * preview, approved resolution, consistent publication", over the assembled application.
 * SPK-SCHED-009: the closure identifies affected games, programs, customers, financial obligations
 * and messages; after the approved resolution (`cancel_affected`) every module agrees: the
 * scheduling event, the catalog session, the family calendar and the family's inbox for the youth
 * session, the fixture and its teams' notices for the adult game. Makeup or credit for the
 * canceled session stays a staff decision (DEC-003).
 */
describe('SPK-AT-009: field closure affects youth and adult bookings (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2027-01-10T20:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  const drain = async () => {
    const dispatcher = t.app.get(OutboxDispatcher);
    for (let i = 0; i < 40; i += 1) if ((await dispatcher.runOnce(200)).claimed === 0) return;
  };
  const send = (path: string, auth: { Authorization: string }, body: object) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key()).send(body);

  it('SPK-AT-009 / SPK-SCHED-009: the preview names the youth and adult customers and the paid order; cancel_affected cancels the catalog session, clears it from the family calendar, tells the guardian once and postpones the fixture', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 9',
    });
    const scheduler = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['scheduler'] })).personId,
    );
    const leagueManager = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['league_manager'] })).personId,
    );
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });

    // youth program: two weekly sessions on the north half, linked to their scheduling events
    const programId = await createProgramFixture(t, {});
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
      programId,
      basePriceMinor: 10_000,
    });
    const series = await send('/v1/event-series', scheduler, {
      facilityId: t.facilityId,
      kind: 'session',
      title: 'U10 clinic',
      recurrence: { frequency: 'weekly', interval: 1, startDate: DAY, count: 2 },
      localStartTime: '10:00',
      durationMinutes: 60,
      resourceIds: [pitch.northHalfId],
      sourceType: 'offering',
      sourceId: offering.offeringId,
    });
    expect(series.status, JSON.stringify(series.body)).toBe(201);
    const [firstEvent, secondEvent] = series.body.eventIds as string[];
    const sessionIds: string[] = [];
    for (const [i, eventId] of [firstEvent, secondEvent].entries()) {
      const day = i === 0 ? DAY : '2027-01-23';
      const session = await send(`/v1/offerings/${offering.offeringId}/sessions`, scheduler, {
        scheduledStart: at(day, '10:00'),
        scheduledEnd: at(day, '11:00'),
        schedulingEventId: eventId,
        sequence: i + 1,
      });
      expect(session.status, JSON.stringify(session.body)).toBe(201);
      sessionIds.push(session.body.id as string);
    }
    const parent = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: parent });
    const kid = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, { actorPersonId: parent, subjectPersonId: kid });
    const orderRef = newId();
    await createEnrollmentFixture(t, {
      offeringId: offering.offeringId,
      participantPersonId: kid,
      payerPersonId: parent,
      orderRef,
    });
    const parentHeader = await authHeaderForPerson(t, parent);

    // adult game on the whole pitch
    const season = await createSeasonFixture(t, { status: 'active' });
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    const captainA = await createPersonFixture(t, { kind: 'adult' });
    const captainB = await createPersonFixture(t, { kind: 'adult' });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainA,
      teamName: 'Hawks',
      divisionId,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captainB,
      teamName: 'Owls',
      divisionId,
    });
    await addRosterMemberFixture(t, { teamEntryId: home.teamEntryId, personId: captainA });
    await addRosterMemberFixture(t, { teamEntryId: away.teamEntryId, personId: captainB });
    const fixture = await send('/v1/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(DAY, '12:00'),
        scheduledEnd: at(DAY, '13:00'),
      },
    });
    expect(fixture.status, JSON.stringify(fixture.body)).toBe(201);
    await drain();

    const window = { from: at('2027-01-15', '00:00'), to: at('2027-01-18', '00:00') };
    const calendarBefore = await t.http
      .get('/v1/me/family-calendar')
      .query(window)
      .set(parentHeader);
    expect(
      (calendarBefore.body.items as Array<{ sessionId: string }>).map((i) => i.sessionId),
    ).toEqual([sessionIds[0]]);

    // the closure preview (SPK-SCHED-009)
    const closure = await send('/v1/closures', scheduler, {
      facilityId: t.facilityId,
      resourceId: pitch.pitchId,
      interval: { start: at(DAY, '08:00'), end: at(DAY, '20:00') },
      reason: 'Flooding',
      source: 'manual',
    });
    expect(closure.status, JSON.stringify(closure.body)).toBe(201);
    const impact = closure.body.impact;
    expect(impact.summary).toMatchObject({ games: 1, programs: 1, teams: 2 });
    const customers = new Map(
      (impact.customers as Array<{ personId: string; eventIds: string[]; via: string[] }>).map(
        (c) => [c.personId, c],
      ),
    );
    expect(customers.get(kid)).toEqual({
      personId: kid,
      eventIds: [firstEvent],
      via: ['enrollment'],
    });
    expect(customers.get(captainA)?.via).toEqual(['roster']);
    expect(customers.get(captainB)?.via).toEqual(['roster']);
    expect(customers.has(sessionIds[1] as string)).toBe(false);
    expect(impact.obligations).toEqual([{ type: 'order', id: orderRef, eventIds: [firstEvent] }]);
    expect(impact.summary).toMatchObject({ customers: 3, obligations: 1 });
    expect(Array.isArray(impact.messages)).toBe(true);
    // the preview carries ids and counts, never names (§4.14)
    expect(JSON.stringify(impact)).not.toMatch(/dateOfBirth|firstName|lastName/);

    // the approved resolution
    const applied = await send(`/v1/closures/${closure.body.id as string}/apply`, scheduler, {
      mode: 'cancel_affected',
      expectedRevision: closure.body.revision,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    await drain();

    // consistent publication: scheduling, catalog, the family calendar, the guardian, the fixture
    const event = await t.db
      .selectFrom('events')
      .select(['status'])
      .where('id', '=', firstEvent as string)
      .executeTakeFirstOrThrow();
    expect(event.status).toBe('canceled');
    const sessions = await t.db
      .selectFrom('offering_sessions')
      .select(['id', 'status', 'cancel_reason'])
      .where('offering_id', '=', offering.offeringId)
      .orderBy('sequence')
      .execute();
    expect(sessions.map((s) => s.status)).toEqual(['canceled', 'scheduled']);
    expect(sessions[0]?.cancel_reason).toContain('Flooding');
    const calendarAfter = await t.http
      .get('/v1/me/family-calendar')
      .query(window)
      .set(parentHeader);
    expect(calendarAfter.body.items).toEqual([]);
    const inbox = await t.http.get('/v1/me/inbox').set(parentHeader);
    expect(inbox.status).toBe(200);
    const notices = (inbox.body.items as Array<{ title: string }>).filter((n) =>
      n.title.startsWith('Canceled: U10 clinic'),
    );
    expect(notices).toHaveLength(1);
    const game = await t.http
      .get(`/v1/fixtures/${fixture.body.fixture.id as string}`)
      .set(leagueManager);
    expect(game.body.status).toBe('postponed');

    // replay: the catalog handler is idempotent (no second cancel, audit or event)
    const changed = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', '=', firstEvent as string)
      .where(sql<boolean>`payload->>'change' = 'canceled'`)
      .executeTakeFirstOrThrow();
    const replayed = await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(SessionsService).followSchedulingEvent(trx, {
        id: changed.id,
        type: changed.event_type,
        organizationId: changed.organization_id,
        correlationId: changed.correlation_id,
        payload: changed.payload,
      } as unknown as DomainEvent<{
        eventId: string;
        change: string;
        reason: string | null;
        closureId: string | null;
      }>),
    );
    expect(replayed).toBe(0);
    const audits = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('target_id', '=', sessionIds[0] as string)
      .where('action', '=', 'catalog.session_canceled')
      .execute();
    expect(audits).toHaveLength(1);
    await drain();
    const inboxAgain = await t.http.get('/v1/me/inbox').set(parentHeader);
    expect(
      (inboxAgain.body.items as Array<{ title: string }>).filter((n) =>
        n.title.startsWith('Canceled: U10 clinic'),
      ),
    ).toHaveLength(1);
  });
});
