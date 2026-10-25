import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture, createProgramFixture } from '../../catalog';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../enrollment.ports';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import {
  acknowledge,
  adult,
  child,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const DAY = 86_400_000;

describe('pickup, makeups, trials and the family calendar (SPK-PLACE-004, SPK-YOUTH-002..007, SPK-AT-019/020)', () => {
  let t: TestApp;
  let parent: Actor;
  let frontDesk: Actor;
  let uow: UnitOfWork;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    frontDesk = await staff(t, ['front_desk']);
    uow = t.app.get(UnitOfWork);
  });
  afterAll(async () => {
    await t.close();
  });

  const session = (setup: OfferingSetup, start: string, minutes = 60) =>
    createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date(start),
      scheduledEnd: new Date(new Date(start).getTime() + minutes * 60_000),
    });

  describe('SPK-PLACE-004: pickup sessions', () => {
    let pickup: OfferingSetup;
    let sessionId: string;
    let program: string;

    beforeAll(async () => {
      program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
      pickup = await offering(t, {
        kind: 'pickup',
        programId: program,
        basePriceMinor: 0,
        capacityUnits: [{ unit: 'seats', limit: 2 }],
      });
      sessionId = await session(pickup, '2026-11-12T02:00:00Z', 90);
    });

    async function player(): Promise<Actor> {
      const actor = await adult(t);
      await acknowledge(t, pickup, actor.personId, actor.personId);
      return actor;
    }

    it('books seats in the session pool with its own waitlist, and never creates league membership', async () => {
      const [a, b, c] = [await player(), await player(), await player()];
      const book = (actor: Actor) =>
        post(t, '/v1/session-bookings', actor.header, {
          offeringId: pickup.offeringId,
          sessionId,
          participantPersonId: actor.personId,
        });
      const first = await book(a);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        kind: 'pickup',
        status: 'confirmed',
        price: { basePriceMinor: 0 },
        sessionId,
      });
      expect((await book(b)).status).toBe(201);
      const full = await book(c);
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('CAPACITY_UNAVAILABLE');
      const pools = await t.db
        .selectFrom('capacity_pools')
        .selectAll()
        .where('scope_id', '=', sessionId)
        .execute();
      expect(pools).toEqual([
        expect.objectContaining({
          scope_type: 'session',
          unit: 'session_seats',
          capacity: 2,
          committed: 2,
        }),
      ]);
      const joined = await post(t, '/v1/waitlist-entries', c.header, {
        offeringId: pickup.offeringId,
        participantPersonId: c.personId,
        intent: 'pickup',
        sessionId,
      });
      expect(joined.status).toBe(201);
      expect(joined.body).toMatchObject({ sessionId, status: 'waiting' });
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
      expect(canceled.body.status).toBe('canceled');
      await drain(t);
      const offered = await t.http
        .get(`/v1/waitlist-entries/${joined.body.id as string}`)
        .set(c.header);
      expect(offered.body.status).toBe('offered');
      const accepted = await post(
        t,
        `/v1/waitlist-offers/${offered.body.offers[0].id as string}/accept`,
        c.header,
        {},
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.basket).toBeNull();
      expect(accepted.body.sessionBooking).toMatchObject({
        status: 'confirmed',
        participantPersonId: c.personId,
        kind: 'pickup',
      });
      // Pickup attendance never creates league membership or an enrollment.
      const entries = t.app.get<TeamEntryQueryPort>(TEAM_ENTRY_QUERY_PORT);
      for (const actor of [a, b, c]) {
        expect(
          await entries.entriesOfPerson(t.organizationId, actor.personId, t.clock.now()),
        ).toEqual([]);
        expect(
          await t.db
            .selectFrom('enrollments')
            .select('id')
            .where('participant_person_id', '=', actor.personId)
            .execute(),
        ).toEqual([]);
      }
    });

    it('applies its entry requirements and payment rules; an unpaid booking expires with its hold', async () => {
      const priced = await offering(t, {
        kind: 'pickup',
        programId: program,
        basePriceMinor: 1_000,
        capacityUnits: [{ unit: 'seats', limit: 5 }],
      });
      const pricedSession = await session(priced, '2026-11-13T02:00:00Z');
      const unsigned = await adult(t);
      const refused = await post(t, '/v1/session-bookings', unsigned.header, {
        offeringId: priced.offeringId,
        sessionId: pricedSession,
        participantPersonId: unsigned.personId,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('MISSING_ACKNOWLEDGMENT');
      await acknowledge(t, priced, unsigned.personId, unsigned.personId);
      const pending = await post(t, '/v1/session-bookings', unsigned.header, {
        offeringId: priced.offeringId,
        sessionId: pricedSession,
        participantPersonId: unsigned.personId,
      });
      expect(pending.status).toBe(201);
      expect(pending.body).toMatchObject({ status: 'pending', price: { basePriceMinor: 1_000 } });
      const confirm = await post(
        t,
        `/v1/session-bookings/${pending.body.id as string}/confirm`,
        unsigned.header,
        { expectedRevision: 1 },
      );
      expect(confirm.status).toBe(409);
      expect(confirm.body.details.code).toBe('PAYMENT_REQUIRED');
      t.clock.advance(11 * 60_000);
      await drain(t);
      const expired = await t.http
        .get(`/v1/session-bookings/${pending.body.id as string}`)
        .set(unsigned.header);
      expect(expired.body).toMatchObject({ status: 'expired' });
      const notPickup = await offering(t, { programId: program });
      const notPickupSession = await session(notPickup, '2026-11-14T02:00:00Z');
      const wrong = await post(t, '/v1/session-bookings', unsigned.header, {
        offeringId: notPickup.offeringId,
        sessionId: notPickupSession,
        participantPersonId: unsigned.personId,
      });
      expect(wrong.status).toBe(400);
    });

    it('SPK-PLACE-004 / SPK-PAY-002: a booking whose only charge is an approved fee stays pending and confirm refuses', async () => {
      const feeOnly = await offering(t, {
        kind: 'pickup',
        programId: program,
        basePriceMinor: 0,
        chargeLines: [
          { code: 'court', label: 'Court fee', kind: 'fee', amountMinor: 500, inclusive: false },
        ],
        capacityUnits: [{ unit: 'seats', limit: 5 }],
      });
      const feeSession = await session(feeOnly, '2026-11-15T02:00:00Z');
      const actor = await adult(t);
      await acknowledge(t, feeOnly, actor.personId, actor.personId);
      const booked = await post(t, '/v1/session-bookings', actor.header, {
        offeringId: feeOnly.offeringId,
        sessionId: feeSession,
        participantPersonId: actor.personId,
      });
      expect(booked.status).toBe(201);
      expect(booked.body).toMatchObject({
        status: 'pending',
        price: { basePriceMinor: 0, chargeLines: [expect.objectContaining({ amountMinor: 500 })] },
      });
      expect(booked.body.expiresAt).not.toBeNull();
      const confirm = await post(
        t,
        `/v1/session-bookings/${booked.body.id as string}/confirm`,
        actor.header,
        { expectedRevision: booked.body.revision },
      );
      expect(confirm.status).toBe(409);
      expect(confirm.body.details.code).toBe('PAYMENT_REQUIRED');
      const seats = await t.db
        .selectFrom('capacity_pools')
        .select(['held', 'committed'])
        .where('scope_id', '=', feeSession)
        .executeTakeFirstOrThrow();
      expect(seats).toEqual({ held: 1, committed: 0 });
    });
  });

  describe('SPK-YOUTH-004 / SPK-AT-020: makeup entitlements', () => {
    let term: OfferingSetup;
    let kid: string;
    let sessions: string[];

    beforeAll(async () => {
      term = await offering(t);
      kid = await child(t, [parent]);
      await acknowledge(t, term, kid, parent.personId);
      sessions = [
        await session(term, '2026-11-20T23:00:00Z'),
        await session(term, '2026-11-27T23:00:00Z'),
      ];
    });

    const issue = (overrides: Record<string, unknown> = {}) =>
      post(t, '/v1/makeup-entitlements', frontDesk.header, {
        participantPersonId: kid,
        originKind: 'session_canceled',
        originatingSessionId: sessions[0],
        eligibleOfferingIds: [term.offeringId],
        expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
        redemptionLimit: 1,
        reason: 'Pitch closed for frost',
        ...overrides,
      });

    it('two concurrent redemptions of a single-use makeup yield exactly one booking', async () => {
      expect(
        (await post(t, '/v1/makeup-entitlements', parent.header, { participantPersonId: kid }))
          .status,
      ).toBe(400);
      const parentIssue = await post(t, '/v1/makeup-entitlements', parent.header, {
        participantPersonId: kid,
        originKind: 'manual',
        eligibleOfferingIds: [term.offeringId],
        expiresAt: new Date(t.clock.now().getTime() + DAY).toISOString(),
        reason: 'self-issued',
      });
      expect(parentIssue.status).toBe(403);
      const issued = await issue();
      expect(issued.status).toBe(201);
      expect(issued.body).toMatchObject({
        status: 'active',
        redemptionLimit: 1,
        redeemedCount: 0,
        originatingSessionId: sessions[0],
      });
      // A makeup is not money (SPK-YOUTH-004): no amount or currency anywhere on it.
      expect(Object.keys(issued.body)).not.toEqual(expect.arrayContaining(['amountMinor']));
      expect(JSON.stringify(issued.body)).not.toContain('currency');
      const id = issued.body.id as string;
      const results = await Promise.all(
        sessions.map((sessionId) =>
          post(t, `/v1/makeup-entitlements/${id}/redeem`, parent.header, {
            offeringId: term.offeringId,
            sessionId,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = results.find((r) => r.status === 201)!;
      expect(winner.body).toMatchObject({
        kind: 'makeup',
        status: 'confirmed',
        price: null,
        makeupEntitlementId: id,
      });
      expect(results.find((r) => r.status === 409)!.body.code).toBe('RESOURCE_CONFLICT');
      const after = await t.http.get(`/v1/makeup-entitlements/${id}`).set(parent.header);
      expect(after.body).toMatchObject({ status: 'exhausted', redeemedCount: 1 });
      expect(after.body.redemptions).toEqual([
        expect.objectContaining({ kind: 'redeem', sessionBookingId: winner.body.id }),
      ]);
      // Canceling the makeup booking before the session gives the makeup back as a new history row.
      const canceled = await post(
        t,
        `/v1/session-bookings/${winner.body.id as string}/cancel`,
        parent.header,
        {
          expectedRevision: winner.body.revision,
          reason: 'Sick',
        },
      );
      expect(canceled.status).toBe(200);
      const restored = await t.http.get(`/v1/makeup-entitlements/${id}`).set(parent.header);
      expect(restored.body).toMatchObject({ status: 'active', redeemedCount: 0 });
      expect(restored.body.redemptions.map((r: { kind: string }) => r.kind)).toEqual([
        'redeem',
        'reversal',
      ]);
      const again = await post(t, `/v1/makeup-entitlements/${id}/redeem`, parent.header, {
        offeringId: term.offeringId,
        sessionId: sessions[1],
      });
      expect(again.status).toBe(201);
    });

    it('redeems only in eligible replacements, before expiry, and never for another household', async () => {
      const issued = await issue({
        expiresAt: new Date(t.clock.now().getTime() + 2 * DAY).toISOString(),
      });
      const id = issued.body.id as string;
      const elsewhere = await offering(t);
      await acknowledge(t, elsewhere, kid, parent.personId);
      const elsewhereSession = await session(elsewhere, '2026-11-21T23:00:00Z');
      const wrong = await post(t, `/v1/makeup-entitlements/${id}/redeem`, parent.header, {
        offeringId: elsewhere.offeringId,
        sessionId: elsewhereSession,
      });
      expect(wrong.status).toBe(422);
      expect(wrong.body.details.reasons[0].code).toBe('makeup_replacement_not_eligible');
      const stranger = await adult(t);
      expect((await t.http.get(`/v1/makeup-entitlements/${id}`).set(stranger.header)).status).toBe(
        404,
      );
      expect(
        (
          await post(t, `/v1/makeup-entitlements/${id}/redeem`, stranger.header, {
            offeringId: term.offeringId,
            sessionId: sessions[0],
          })
        ).status,
      ).toBe(404);
      t.clock.advance(3 * DAY);
      await drain(t);
      const lapsed = await t.http.get(`/v1/makeup-entitlements/${id}`).set(parent.header);
      expect(lapsed.body.status).toBe('expired');
      const late = await post(t, `/v1/makeup-entitlements/${id}/redeem`, parent.header, {
        offeringId: term.offeringId,
        sessionId: sessions[1],
      });
      expect(late.status).toBe(409);
      expect(late.body.details.code).toBe('MAKEUP_NOT_REDEEMABLE');
    });
  });

  it('SPK-AT-019: a trial converts to term participation with separate trial history and paid entitlement', async () => {
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: trialProgram, basePriceMinor: 0 });
    const trialSession = await session(trial, '2026-11-15T17:00:00Z');
    const term = await offering(t, { programId: trialProgram, basePriceMinor: 18_000 });
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId: trialSession,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'scheduled',
      followUpConsent: false,
      sessionId: trialSession,
    });
    expect(created.body.sessionBookingId).toEqual(expect.any(String));
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    const second = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
    });
    expect(second.status).toBe(409);
    const id = created.body.id as string;
    expect(
      (
        await post(t, `/v1/trial-participations/${id}/outcome`, parent.header, {
          outcome: 'attended',
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
    const attended = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
      outcome: 'attended',
      expectedRevision: 1,
    });
    expect(attended.body).toMatchObject({ status: 'attended' });
    const attendedAt = attended.body.attendedAt as string;
    // Staff may not reuse the trial for a follow-up without the family's permission (SPK-YOUTH-003).
    const byStaff = await post(t, `/v1/trial-participations/${id}/convert`, frontDesk.header, {
      targetOfferingId: term.offeringId,
      expectedRevision: 2,
      payerPersonId: parent.personId,
    });
    expect(byStaff.status).toBe(409);
    expect(byStaff.body.details.code).toBe('FOLLOW_UP_CONSENT_REQUIRED');
    const converted = await post(t, `/v1/trial-participations/${id}/convert`, parent.header, {
      targetOfferingId: term.offeringId,
      expectedRevision: 2,
    });
    expect(converted.status).toBe(201);
    // A follow-up offer: nothing is charged, held or enrolled yet.
    expect(converted.body.basket).toMatchObject({
      status: 'open',
      holds: [],
      ownerPersonId: parent.personId,
    });
    expect(converted.body.basket.lines[0]).toMatchObject({
      trialParticipationId: id,
      participantPersonId: kid,
      enrollmentId: null,
    });
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    await acknowledge(t, term, kid, parent.personId);
    const held = await post(
      t,
      `/v1/baskets/${converted.body.basket.id as string}/hold`,
      parent.header,
      {},
    );
    expect(held.status).toBe(200);
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    await uow.run(({ trx }) =>
      t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, enrollmentId, {
          actor: finance,
          orderRef: 'order-term',
        }),
    );
    const after = await t.http.get(`/v1/trial-participations/${id}`).set(parent.header);
    expect(after.body).toMatchObject({
      status: 'converted',
      convertedEnrollmentId: enrollmentId,
      attendedAt,
    });
    const enrollment = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(enrollment.body).toMatchObject({
      status: 'confirmed',
      trialParticipationId: id,
      offeringId: term.offeringId,
    });
    const trialBooking = await t.http
      .get(`/v1/session-bookings/${created.body.sessionBookingId as string}`)
      .set(parent.header);
    expect(trialBooking.body).toMatchObject({ kind: 'trial', status: 'confirmed' });
  });

  it('SPK-AT-019 / SPK-YOUTH-003: a no-show trial keeps its outcome after it converts to paid participation', async () => {
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: trialProgram, basePriceMinor: 0 });
    const trialSession = await session(trial, '2026-11-16T17:00:00Z');
    const term = await offering(t, { programId: trialProgram, basePriceMinor: 18_000 });
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId: trialSession,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const noShow = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
      outcome: 'no_show',
      expectedRevision: 1,
    });
    expect(noShow.status).toBe(200);
    expect(noShow.body).toMatchObject({ status: 'no_show', attendedAt: null });
    const noShowAt = noShow.body.noShowAt as string;
    expect(noShowAt).toEqual(expect.any(String));
    const converted = await post(t, `/v1/trial-participations/${id}/convert`, parent.header, {
      targetOfferingId: term.offeringId,
      expectedRevision: 2,
    });
    expect(converted.status).toBe(201);
    await acknowledge(t, term, kid, parent.personId);
    const held = await post(
      t,
      `/v1/baskets/${converted.body.basket.id as string}/hold`,
      parent.header,
      {},
    );
    expect(held.status).toBe(200);
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    await uow.run(({ trx }) =>
      t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, enrollmentId, {
          actor: systemPrincipal(t.organizationId, 'finance.checkout'),
          orderRef: 'order-term-2',
        }),
    );
    // The paid entitlement is linked; the trial's own history (a no-show) is still there.
    const after = await t.http.get(`/v1/trial-participations/${id}`).set(parent.header);
    expect(after.body).toMatchObject({
      status: 'converted',
      convertedEnrollmentId: enrollmentId,
      noShowAt,
      attendedAt: null,
    });
  });

  it('SPK-YOUTH-007: one calendar for all authorized children, overlaps highlighted but not prevented', async () => {
    const term = await offering(t);
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: trialProgram, basePriceMinor: 0 });
    const first = await child(t, [parent]);
    const second = await child(t, [parent]);
    await session(term, '2026-11-10T17:00:00Z');
    await session(term, '2027-03-10T17:00:00Z');
    await createEnrollmentFixture(t, {
      offeringId: term.offeringId,
      participantPersonId: first,
      payerPersonId: parent.personId,
    });
    const trialSession = await session(trial, '2026-11-10T17:30:00Z');
    await acknowledge(t, trial, second, parent.personId);
    const overlapping = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: second,
      sessionId: trialSession,
    });
    expect(overlapping.status).toBe(201);
    const res = await t.http
      .get('/v1/me/family-calendar?from=2026-11-09T00:00:00Z&to=2026-11-12T00:00:00Z')
      .set(parent.header);
    expect(res.status).toBe(200);
    expect(res.body.participantPersonIds).toEqual(
      expect.arrayContaining([parent.personId, first, second]),
    );
    const mine = res.body.items.filter(
      (i: { personId: string }) => i.personId === first || i.personId === second,
    );
    expect(mine.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'enrollment_session',
      'session_booking',
    ]);
    expect(res.body.overlaps).toEqual([
      expect.objectContaining({
        personIds: expect.arrayContaining([first, second]),
        start: '2026-11-10T17:30:00.000Z',
        end: '2026-11-10T18:00:00.000Z',
      }),
    ]);
    const stranger = await adult(t);
    const theirs = await t.http
      .get('/v1/me/family-calendar?from=2026-11-09T00:00:00Z&to=2026-11-12T00:00:00Z')
      .set(stranger.header);
    expect(theirs.body).toMatchObject({
      participantPersonIds: [stranger.personId],
      items: [],
      overlaps: [],
    });
    // SPK-AT-015 precondition: each child's participation is separate, so arrival records only the
    // actual child and the selected session (the entry module reads this port).
    const participation = await t.app
      .get<EnrollmentPort>(ENROLLMENT_PORT)
      .participationsOf(t.organizationId, [first, second], {
        from: new Date('2026-11-09T00:00:00Z'),
        to: new Date('2026-11-12T00:00:00Z'),
      });
    expect(
      participation.map((p) => [
        p.participantPersonId,
        p.enrollments.length,
        p.sessionBookings.length,
      ]),
    ).toEqual([
      [first, 1, 0],
      [second, 0, 1],
    ]);
    expect(participation[1]!.sessionBookings[0]).toMatchObject({
      kind: 'trial',
      sessionId: trialSession,
    });
    const tooLong = await t.http
      .get('/v1/me/family-calendar?from=2026-11-09T00:00:00Z&to=2027-06-12T00:00:00Z')
      .set(parent.header);
    expect(tooLong.status).toBe(400);
  });
});
