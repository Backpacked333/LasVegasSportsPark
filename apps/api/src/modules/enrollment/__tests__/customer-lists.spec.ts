import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createOfferingSessionFixture,
  createPolicyVersionFixture,
  createProgramFixture,
} from '../../catalog';
import { createSeasonFixture, createTeamEntryFixture } from '../../competition';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
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
} from './support';

/**
 * ENR-01 / ENR-02: a person's own registration lists, keyset paging, and the enrollment, calendar
 * and placement reads that say what, where (facility zone) and what is still outstanding.
 */
describe('customer registration lists and enrollment reads (ENR-01, ENR-02)', () => {
  let t: TestApp;
  let guardian: Actor;
  let otherFamily: Actor;
  let frontDesk: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    guardian = await adult(t);
    otherFamily = await adult(t);
    frontDesk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  it("SPK-REG-008: a guardian lists their child's waitlist entries with the open offer and its expiry", async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    // The only place is taken.
    const seated = await child(t, [otherFamily]);
    await acknowledge(t, setup, seated, otherFamily.personId);
    const first = await basketWith(t, otherFamily, [
      { participantPersonId: seated, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${first.id}/hold`, otherFamily.header)).status).toBe(200);
    const completed = await post(t, `/v1/baskets/${first.id}/complete`, otherFamily.header);
    expect(completed.status).toBe(200);
    const seatedEnrollment = completed.body.lines[0].enrollmentId as string;

    const kid = await child(t, [guardian]);
    await acknowledge(t, setup, kid, guardian.personId);
    const joined = await post(t, '/v1/waitlist-entries', guardian.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);

    // Nothing is offered yet.
    const before = await t.http.get('/v1/me/waitlist-entries').set(guardian.header);
    expect(before.status).toBe(200);
    expect(before.body.items).toEqual([
      expect.objectContaining({
        id: joined.body.id,
        participantPersonId: kid,
        status: 'waiting',
        offeringName: expect.any(String),
        openOffer: null,
      }),
    ]);

    // The place comes free and is offered to the waiting child.
    const cancel = await post(t, `/v1/enrollments/${seatedEnrollment}/cancel`, otherFamily.header, {
      reason: 'moving away',
      expectedRevision: 2,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    await drain(t);
    const listed = await t.http.get('/v1/me/waitlist-entries').set(guardian.header);
    expect(listed.body.items).toHaveLength(1);
    const item = listed.body.items[0];
    expect(item.status).toBe('offered');
    expect(item.openOffer).toMatchObject({ status: 'offered', expiresAt: expect.any(String) });
    expect(new Date(item.openOffer.expiresAt).getTime()).toBeGreaterThan(t.clock.now().getTime());
    expect(item.offers.map((o: { id: string }) => o.id)).toContain(item.openOffer.id);

    // Another household sees none of it; the participant's family only.
    const other = await t.http.get('/v1/me/waitlist-entries').set(otherFamily.header);
    expect(other.body.items.map((e: { id: string }) => e.id)).not.toContain(joined.body.id);
    // A status filter narrows the list.
    const waiting = await t.http.get('/v1/me/waitlist-entries?status=waiting').set(guardian.header);
    expect(waiting.body.items).toEqual([]);
  });

  it('SPK-UX-001: an interrupted registration is found from GET /v1/me/baskets after a reinstall', async () => {
    const parent = await adult(t);
    const setup = await offering(t);
    const kid = await child(t, [parent]);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${basket.id}/hold`, parent.header)).status).toBe(200);
    // The device lost every id: the server still knows the household's baskets.
    const mine = await t.http.get('/v1/me/baskets').set(parent.header);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      items: [
        {
          id: basket.id,
          status: 'held',
          ownerPersonId: parent.personId,
          lines: [expect.objectContaining({ participantPersonId: kid, outcome: 'held' })],
        },
      ],
      nextCursor: null,
    });
    const held = await t.http.get('/v1/me/baskets?status=held').set(parent.header);
    expect(held.body.items.map((b: { id: string }) => b.id)).toEqual([basket.id]);
    // Nobody else sees them.
    const other = await t.http.get('/v1/me/baskets').set(otherFamily.header);
    expect(other.body.items.map((b: { id: string }) => b.id)).not.toContain(basket.id);
  });

  it('§4.5: the own lists page with a keyset cursor, newest first, with no gap or repeat', async () => {
    const parent = await adult(t);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await post(t, '/v1/baskets', parent.header, {
        ownerPersonId: parent.personId,
      });
      expect(created.status).toBe(201);
      ids.push(created.body.id as string);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res: {
        status: number;
        body: { items: Array<{ id: string }>; nextCursor: string | null };
      } = await t.http
        .get(`/v1/me/baskets?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(parent.header);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((b: { id: string }) => b.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it('ENR-01: applications and trial participations of the family are listed for the guardian', async () => {
    const parent = await adult(t);
    const kid = await child(t, [parent]);
    const setup = await offering(t);
    const applied = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const trial = await offering(t, { kind: 'trial', basePriceMinor: 0 });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: trial.offeringId,
      scheduledStart: new Date('2026-11-20T01:00:00Z'),
      scheduledEnd: new Date('2026-11-20T02:00:00Z'),
    });
    await acknowledge(t, trial, kid, parent.personId);
    const tried = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId,
    });
    expect(tried.status, JSON.stringify(tried.body)).toBe(201);
    const applications = await t.http.get('/v1/me/applications').set(parent.header);
    expect(applications.body.items.map((a: { id: string }) => a.id)).toContain(applied.body.id);
    const trials = await t.http.get('/v1/me/trial-participations').set(parent.header);
    expect(trials.body.items.map((x: { id: string }) => x.id)).toEqual([tried.body.id]);
    const outsiders = await t.http.get('/v1/me/applications').set(otherFamily.header);
    expect(outsiders.body.items.map((a: { id: string }) => a.id)).not.toContain(applied.body.id);
  });

  it("SPK-AT-004 / §4.14: another guardian reads the child's trial without learning which adult booked it", async () => {
    const booker = await adult(t);
    const otherGuardian = await adult(t);
    const kid = await child(t, [booker, otherGuardian]);
    const trial = await offering(t, { kind: 'trial', basePriceMinor: 0 });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: trial.offeringId,
      scheduledStart: new Date('2026-11-21T01:00:00Z'),
      scheduledEnd: new Date('2026-11-21T02:00:00Z'),
    });
    await acknowledge(t, trial, kid, booker.personId);
    const booked = await post(t, '/v1/trial-participations', booker.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.registeredBy).toMatchObject({ personId: booker.personId });

    // The other guardian sees the participation, not the adult who booked it.
    const listed = await t.http.get('/v1/me/trial-participations').set(otherGuardian.header);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({
      id: booked.body.id,
      participantPersonId: kid,
      registeredBy: { kind: 'customer', accountId: null, personId: null },
      assistedByPersonId: null,
    });
    const single = await t.http
      .get(`/v1/trial-participations/${booked.body.id as string}`)
      .set(otherGuardian.header);
    expect(single.status).toBe(200);
    expect(single.body.registeredBy).toMatchObject({ accountId: null, personId: null });
    for (const body of [listed.body, single.body]) {
      expect(JSON.stringify(body)).not.toContain(booker.personId);
      expect(JSON.stringify(body)).not.toContain(booker.accountId);
    }

    // The booker and staff still see who booked it.
    const own = await t.http
      .get(`/v1/trial-participations/${booked.body.id as string}`)
      .set(booker.header);
    expect(own.body.registeredBy).toMatchObject({ personId: booker.personId });
    const desk = await t.http
      .get(`/v1/trial-participations/${booked.body.id as string}`)
      .set(frontDesk.header);
    expect(desk.status).toBe(200);
    expect(desk.body.registeredBy).toMatchObject({ personId: booker.personId });
  });

  it('SPK-UX-004: a pending enrollment states what is outstanding', async () => {
    const parent = await adult(t);
    const kid = await child(t, [parent]);
    // payment: held, unpaid.
    const paid = await offering(t, { basePriceMinor: 12_000 });
    await acknowledge(t, paid, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: paid.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header);
    const payment = await t.http
      .get(`/v1/enrollments/${held.body.lines[0].enrollmentId as string}`)
      .set(parent.header);
    expect(payment.body).toMatchObject({
      status: 'pending',
      pendingReason: 'payment',
      offering: {
        id: paid.offeringId,
        kind: 'term',
        facilityId: t.facilityId,
        timezone: 'America/Los_Angeles',
      },
    });
    expect(payment.body.offering.name).toEqual(expect.any(String));

    // approval: a team entry registration waits for review (DEC-028 proposed default).
    const season = await offering(t, {
      kind: 'season',
      basePriceMinor: 0,
      programId: await createProgramFixture(t, { ageBand: { minAgeYears: 18 } }),
    });
    const captain = await adult(t);
    await acknowledge(t, season, captain.personId, captain.personId);
    const teamBasket = await basketWith(t, captain, [
      {
        participantPersonId: captain.personId,
        offeringId: season.offeringId,
        intent: 'create_team_entry',
      },
    ]);
    const teamHeld = await post(t, `/v1/baskets/${teamBasket.id}/hold`, captain.header);
    expect(teamHeld.status, JSON.stringify(teamHeld.body)).toBe(200);
    const approval = await t.http
      .get(`/v1/enrollments/${teamHeld.body.lines[0].enrollmentId as string}`)
      .set(captain.header);
    expect(approval.body.pendingReason).toBe('approval');

    // forms: a required form the participant has not acknowledged.
    const form = await createPolicyVersionFixture(t, { kind: 'form' });
    const formsId = await createEnrollmentFixture(t, {
      offeringId: paid.offeringId,
      participantPersonId: await child(t, [parent]),
      status: 'pending',
    });
    await t.db
      .updateTable('enrollments')
      .set({
        policy_references: json({
          eligibilityPolicyVersionId: null,
          cancellationPolicyVersionId: null,
          requiredFormPolicyVersionIds: [form],
          approvalPolicyVersionId: null,
        }),
      })
      .where('id', '=', formsId)
      .execute();
    const forms = await t.http.get(`/v1/enrollments/${formsId}`).set(frontDesk.header);
    expect(forms.body.pendingReason).toBe('forms');

    // placement: an individual registrant still unplaced.
    const placementKid = await adult(t);
    const placementEnrollment = await createEnrollmentFixture(t, {
      offeringId: paid.offeringId,
      participantPersonId: placementKid.personId,
      status: 'pending',
      intent: 'individual_league',
    });
    const seasonId = (await createSeasonFixture(t)).seasonId;
    const requested = await post(t, '/v1/placement-requests', placementKid.header, {
      participantPersonId: placementKid.personId,
      seasonId,
    });
    expect(requested.status).toBe(201);
    await t.db
      .updateTable('placement_requests')
      .set({ enrollment_id: placementEnrollment })
      .where('id', '=', requested.body.id as string)
      .execute();
    const placement = await t.http
      .get(`/v1/enrollments/${placementEnrollment}`)
      .set(placementKid.header);
    expect(placement.body.pendingReason).toBe('placement');

    // A confirmed enrollment waits for nothing.
    const confirmed = await createEnrollmentFixture(t, {
      offeringId: paid.offeringId,
      participantPersonId: await child(t, [parent]),
    });
    const done = await t.http.get(`/v1/enrollments/${confirmed}`).set(frontDesk.header);
    expect(done.body.pendingReason).toBeNull();
  });

  it('ENR-02: an enrollment of a closed offering still names its offering', async () => {
    const parent = await adult(t);
    const kid = await child(t, [parent]);
    const setup = await offering(t, { startsOn: '2026-01-05', endsOn: '2026-03-30' });
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      status: 'completed',
    });
    await t.db
      .updateTable('offerings')
      .set({ publication_state: 'closed', closed_at: t.clock.now() })
      .where('id', '=', setup.offeringId)
      .execute();
    const read = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(read.status).toBe(200);
    expect(read.body.offering).toMatchObject({
      id: setup.offeringId,
      startsOn: '2026-01-05',
      endsOn: '2026-03-30',
      timezone: 'America/Los_Angeles',
    });
  });

  it('§4.5: GET /applications, /enrollments and /placement-requests page with nextCursor', async () => {
    const manager = await staff(t, ['program_manager', 'league_manager']);
    const setup = await offering(t, { basePriceMinor: 0 });
    const enrollments: string[] = [];
    const applications: string[] = [];
    const seasonId = (await createSeasonFixture(t)).seasonId;
    const placements: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const person = await adult(t);
      enrollments.push(
        await createEnrollmentFixture(t, {
          offeringId: setup.offeringId,
          participantPersonId: person.personId,
        }),
      );
      const applied = await post(t, '/v1/applications', person.header, {
        offeringId: setup.offeringId,
        participantPersonId: person.personId,
        intent: 'individual_league',
      });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      applications.push(applied.body.id as string);
      const placed = await post(t, '/v1/placement-requests', person.header, {
        participantPersonId: person.personId,
        seasonId,
      });
      placements.push(placed.body.id as string);
    }
    const pages = async (path: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let count = 0;
      do {
        const res: {
          status: number;
          body: { items: Array<{ id: string }>; nextCursor: string | null };
        } = await t.http
          .get(
            `${path}${path.includes('?') ? '&' : '?'}limit=2${cursor ? `&cursor=${cursor}` : ''}`,
          )
          .set(manager.header);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        seen.push(...res.body.items.map((x: { id: string }) => x.id));
        cursor = res.body.nextCursor;
        count += 1;
      } while (cursor && count < 10);
      return { seen, count };
    };
    const e = await pages(`/v1/enrollments?offeringId=${setup.offeringId}`);
    expect(e).toEqual({ seen: [...enrollments].reverse(), count: 2 });
    const a = await pages(`/v1/applications?offeringId=${setup.offeringId}`);
    expect(a).toEqual({ seen: [...applications].reverse(), count: 2 });
    const p = await pages(`/v1/placement-requests?seasonId=${seasonId}`);
    expect(p).toEqual({ seen: [...placements].reverse(), count: 2 });
  });

  it('SPK-SCHED-008: family calendar items carry the facility time zone', async () => {
    const parent = await adult(t);
    const kid = await child(t, [parent]);
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } });
    const setup = await offering(t, { programId: program });
    await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-11-10T01:00:00Z'),
      scheduledEnd: new Date('2026-11-10T02:00:00Z'),
    });
    await createEnrollmentFixture(t, { offeringId: setup.offeringId, participantPersonId: kid });
    const calendar = await t.http
      .get('/v1/me/family-calendar?from=2026-11-09T00:00:00Z&to=2026-11-12T00:00:00Z')
      .set(parent.header);
    expect(calendar.status).toBe(200);
    expect(calendar.body.items).toEqual([
      expect.objectContaining({
        personId: kid,
        offeringId: setup.offeringId,
        facilityId: t.facilityId,
        timezone: 'America/Los_Angeles',
      }),
    ]);
  });

  it('SPK-PLACE-003: an assigned placement names its team', async () => {
    const leagueManager = await staff(t, ['league_manager']);
    const seasonId = (await createSeasonFixture(t)).seasonId;
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: 'Comets',
    });
    const player = await adult(t, { dateOfBirth: '1995-05-05' });
    const requested = await post(t, '/v1/placement-requests', player.header, {
      participantPersonId: player.personId,
      seasonId,
    });
    const assigned = await post(
      t,
      `/v1/placement-requests/${requested.body.id as string}/assign`,
      leagueManager.header,
      { teamEntryId: entry.teamEntryId, expectedRevision: requested.body.revision },
    );
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body).toMatchObject({ status: 'assigned', assignedTeamName: 'Comets' });
    const read = await t.http
      .get(`/v1/placement-requests/${requested.body.id as string}`)
      .set(player.header);
    expect(read.body.assignedTeamName).toBe('Comets');
  });
});
