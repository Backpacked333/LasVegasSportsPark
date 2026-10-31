import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture, createProgramFixture } from '../../catalog';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../enrollment.ports';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import { membershipOffering } from './package-g-support';
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

    it('GAPS-TRIAGE-01 / SPK-PLACE-004: entry requirements apply, and a priced booking is refused before any seat is held', async () => {
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
      // No checkout takes a single session (POL-045 / DEC-082 pending): no 201 for a booking
      // nobody can pay, and no seat, booking or hold is left behind.
      for (const actor of [unsigned, frontDesk]) {
        const unpayable = await post(t, '/v1/session-bookings', actor.header, {
          offeringId: priced.offeringId,
          sessionId: pricedSession,
          participantPersonId: unsigned.personId,
        });
        expect(unpayable.status, JSON.stringify(unpayable.body)).toBe(409);
        expect(unpayable.body).toMatchObject({
          code: 'RESOURCE_CONFLICT',
          nextAction: 'resolve_conflict',
          details: {
            code: 'SESSION_PAYMENT_UNAVAILABLE',
            kind: 'pickup',
            amountMinor: 1_000,
            pendingDecisions: ['POL-045', 'DEC-082'],
          },
        });
      }
      expect(
        await t.db
          .selectFrom('session_bookings')
          .select('id')
          .where('session_id', '=', pricedSession)
          .execute(),
      ).toEqual([]);
      const seats = await t.db
        .selectFrom('capacity_pools')
        .select(['held', 'committed'])
        .where('scope_id', '=', pricedSession)
        .execute();
      expect(seats.every((p) => p.held === 0 && p.committed === 0)).toBe(true);
      // Nor can anyone wait for such a seat (it could never be booked from an offer either).
      const waiting = await post(t, '/v1/waitlist-entries', unsigned.header, {
        offeringId: priced.offeringId,
        participantPersonId: unsigned.personId,
        intent: 'pickup',
        sessionId: pricedSession,
      });
      expect(waiting.status).toBe(409);
      expect(waiting.body.details.code).toBe('SESSION_PAYMENT_UNAVAILABLE');
      const notPickup = await offering(t, { programId: program });
      const notPickupSession = await session(notPickup, '2026-11-14T02:00:00Z');
      const wrong = await post(t, '/v1/session-bookings', unsigned.header, {
        offeringId: notPickup.offeringId,
        sessionId: notPickupSession,
        participantPersonId: unsigned.personId,
      });
      expect(wrong.status).toBe(400);
    });

    it('GAPS-TRIAGE-01 / SPK-PAY-002: a booking whose only charge is an approved fee owes money and is refused the same way', async () => {
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
      expect(booked.status).toBe(409);
      expect(booked.body.details).toMatchObject({
        code: 'SESSION_PAYMENT_UNAVAILABLE',
        amountMinor: 0,
      });
      const seats = await t.db
        .selectFrom('capacity_pools')
        .select(['held', 'committed'])
        .where('scope_id', '=', feeSession)
        .execute();
      expect(seats.every((p) => p.held === 0 && p.committed === 0)).toBe(true);
    });

    it('GAPS-TRIAGE-01 / SPK-REG-008: a pickup queue whose seat became priced makes no offer: acceptance and the staff offer are refused, and offer generation retires the waiter with a notice', async () => {
      const finance = await staff(t, ['finance_operator']);
      const manager = await staff(t, ['program_manager']);
      const one = await offering(t, {
        kind: 'pickup',
        programId: program,
        basePriceMinor: 0,
        capacityUnits: [{ unit: 'seats', limit: 1 }],
      });
      const seat = await session(one, '2026-11-16T02:00:00Z');
      const players: Actor[] = [];
      for (let i = 0; i < 3; i += 1) {
        const actor = await adult(t);
        await acknowledge(t, one, actor.personId, actor.personId);
        players.push(actor);
      }
      const [a, c, d] = players as [Actor, Actor, Actor];
      const join = async (actor: Actor) => {
        const joined = await post(t, '/v1/waitlist-entries', actor.header, {
          offeringId: one.offeringId,
          participantPersonId: actor.personId,
          intent: 'pickup',
          sessionId: seat,
        });
        expect(joined.status, JSON.stringify(joined.body)).toBe(201);
        return joined.body as { id: string; revision: number };
      };
      const entryOf = async (actor: Actor, id: string) =>
        (await t.http.get(`/v1/waitlist-entries/${id}`).set(actor.header)).body as {
          status: string;
          revision: number;
          offers: Array<{ id: string; status: string; revision: number }>;
        };
      const notices = (subjectId: string) =>
        t.db
          .selectFrom('notifications')
          .select(['kind', 'title', 'body'])
          .where('subject_id', '=', subjectId)
          .execute();
      const pool = () =>
        t.db
          .selectFrom('capacity_pools')
          .select(['held', 'committed'])
          .where('scope_id', '=', seat)
          .executeTakeFirstOrThrow();

      // The only seat is booked (free); C, then D, wait for it. A cancels and C is offered it.
      const booked = await post(t, '/v1/session-bookings', a.header, {
        offeringId: one.offeringId,
        sessionId: seat,
        participantPersonId: a.personId,
      });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      const cEntry = await join(c);
      const dEntry = await join(d);
      expect(
        (
          await post(t, `/v1/session-bookings/${booked.body.id as string}/cancel`, a.header, {
            expectedRevision: booked.body.revision,
            reason: 'Cannot make it',
          })
        ).status,
      ).toBe(200);
      await drain(t);
      const offered = await entryOf(c, cEntry.id);
      expect(offered.status).toBe('offered');
      const offer = offered.offers[0]!;

      // Finance prices the offering from now on (SPK-PAY-002: a new version, never a rewrite).
      const rule = await post(t, `/v1/offerings/${one.offeringId}/price-rules`, finance.header, {
        effectiveFrom: new Date(t.clock.now().getTime() + 60_000).toISOString(),
        basePriceMinor: 1_500,
        currency: 'USD',
        chargeLines: [],
      });
      expect(rule.status, JSON.stringify(rule.body)).toBe(201);
      t.clock.advance(2 * 60_000);

      // The offer made while the seat was free cannot be accepted now: nothing is booked, and the
      // offer stays open with its seat held until it is declined or expires.
      const refused = await post(t, `/v1/waitlist-offers/${offer.id}/accept`, c.header, {
        expectedRevision: offer.revision,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.details).toMatchObject({
        code: 'SESSION_PAYMENT_UNAVAILABLE',
        kind: 'pickup',
        amountMinor: 1_500,
        currency: 'USD',
        pendingDecisions: ['POL-045', 'DEC-082'],
      });
      expect(await entryOf(c, cEntry.id)).toMatchObject({
        status: 'offered',
        offers: [expect.objectContaining({ id: offer.id, status: 'offered' })],
      });
      expect(
        await t.db
          .selectFrom('session_bookings')
          .select('id')
          .where('session_id', '=', seat)
          .where('participant_person_id', '=', c.personId)
          .execute(),
      ).toEqual([]);
      expect(await pool()).toEqual({ held: 1, committed: 0 });

      // Staff cannot offer the seat to the next waiter either.
      const staffOffer = await post(t, `/v1/waitlist-entries/${dEntry.id}/offer`, manager.header, {
        reason: 'Seat freed',
        expectedRevision: dEntry.revision,
      });
      expect(staffOffer.status, JSON.stringify(staffOffer.body)).toBe(409);
      expect(staffOffer.body.details).toMatchObject({
        code: 'SESSION_PAYMENT_UNAVAILABLE',
        pendingDecisions: ['POL-045', 'DEC-082'],
      });

      // C declines; the freed seat is not offered to D, who could not book it: D leaves the queue
      // with the reason and is told why, and the seat is free again.
      expect(
        (
          await post(t, `/v1/waitlist-offers/${offer.id}/decline`, c.header, {
            expectedRevision: offer.revision,
          })
        ).status,
      ).toBe(200);
      await drain(t);
      const retired = await t.db
        .selectFrom('waitlist_entries')
        .select(['status', 'removal_reason', 'offer_count'])
        .where('id', '=', dEntry.id)
        .executeTakeFirstOrThrow();
      expect(retired).toEqual({
        status: 'removed',
        removal_reason: 'session_payment_unavailable',
        offer_count: 0,
      });
      expect(await notices(dEntry.id)).toEqual([
        expect.objectContaining({
          kind: 'registration_outcome',
          title: 'No longer on the waitlist',
          body: expect.stringContaining('now has a price'),
        }),
      ]);
      expect(await pool()).toEqual({ held: 0, committed: 0 });
      // C, who declined, is not told anything more about the queue they left.
      expect(await notices(cEntry.id)).toEqual([]);
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

    it('SPK-YOUTH-004 / GAPS-TRIAGE-01: a makeup seat is redeemed, never waited for: the join is refused, and an entry recorded earlier is retired with a notice instead of being offered', async () => {
      const manager = await staff(t, ['program_manager']);
      // A priced term (SPK-PAY-001) with one seat per session; its first session's seat is
      // taken by a redeemed makeup.
      const small = await offering(t, {
        basePriceMinor: 18_000,
        capacityUnits: [{ unit: 'seats', limit: 1 }],
      });
      const first = await child(t, [parent]);
      const second = await child(t, [parent]);
      for (const participant of [first, second]) {
        await acknowledge(t, small, participant, parent.personId);
      }
      const seat = await session(small, '2026-11-24T23:00:00Z');
      const makeup = await post(t, '/v1/makeup-entitlements', frontDesk.header, {
        participantPersonId: first,
        originKind: 'session_canceled',
        originatingSessionId: seat,
        eligibleOfferingIds: [small.offeringId],
        expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
        redemptionLimit: 1,
        reason: 'Pitch closed for frost',
      });
      expect(makeup.status, JSON.stringify(makeup.body)).toBe(201);
      const redeemed = await post(
        t,
        `/v1/makeup-entitlements/${makeup.body.id as string}/redeem`,
        parent.header,
        { offeringId: small.offeringId, sessionId: seat },
      );
      expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);

      // Waiting for a makeup seat is refused, naming the command that takes one; never the pickup
      // payment decisions or the term price.
      const joined = await post(t, '/v1/waitlist-entries', parent.header, {
        offeringId: small.offeringId,
        participantPersonId: second,
        intent: 'makeup',
        sessionId: seat,
      });
      expect(joined.status, JSON.stringify(joined.body)).toBe(400);
      expect(joined.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          code: 'MAKEUP_REDEMPTION_REQUIRED',
          command: 'POST /v1/makeup-entitlements/{id}/redeem',
        },
      });
      expect(JSON.stringify(joined.body)).not.toContain('POL-045');
      expect(
        await t.db
          .selectFrom('waitlist_entries')
          .select('id')
          .where('participant_person_id', '=', second)
          .execute(),
      ).toEqual([]);

      // An entry recorded before such joins were refused is never offered the seat.
      const pool = await t.db
        .selectFrom('capacity_pools')
        .select('id')
        .where('scope_id', '=', seat)
        .executeTakeFirstOrThrow();
      const legacyId = newId();
      await t.db
        .insertInto('waitlist_entries')
        .values({
          id: legacyId,
          organization_id: t.organizationId,
          offering_id: small.offeringId,
          pool_id: pool.id,
          session_id: seat,
          participant_person_id: second,
          intent: 'makeup',
          joined_at: t.clock.now(),
          queued_at: t.clock.now(),
          requested_by: json({ kind: 'customer', personId: parent.personId }),
          requested_by_person_id: parent.personId,
          payer_person_id: parent.personId,
          accepted_enrollment_id: null,
          withdrawn_at: null,
          removed_at: null,
          removal_reason: null,
        })
        .execute();
      const staffOffer = await post(t, `/v1/waitlist-entries/${legacyId}/offer`, manager.header, {
        reason: 'Seat freed',
        expectedRevision: 1,
      });
      expect(staffOffer.status, JSON.stringify(staffOffer.body)).toBe(400);
      expect(staffOffer.body.details.code).toBe('MAKEUP_REDEMPTION_REQUIRED');
      // The makeup booking is cancelled: the freed seat goes to nobody from the queue; the entry
      // leaves it with the reason and the family is told how a makeup seat is taken.
      expect(
        (
          await post(
            t,
            `/v1/session-bookings/${redeemed.body.id as string}/cancel`,
            parent.header,
            { expectedRevision: redeemed.body.revision, reason: 'Sick' },
          )
        ).status,
      ).toBe(200);
      await drain(t);
      expect(
        await t.db
          .selectFrom('waitlist_entries')
          .select(['status', 'removal_reason', 'offer_count'])
          .where('id', '=', legacyId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: 'removed',
        removal_reason: 'makeup_redemption_required',
        offer_count: 0,
      });
      expect(
        await t.db
          .selectFrom('notifications')
          .select(['kind', 'body'])
          .where('subject_id', '=', legacyId)
          .execute(),
      ).toEqual([
        expect.objectContaining({
          kind: 'registration_outcome',
          body: expect.stringContaining('redeeming the makeup'),
        }),
      ]);
      expect(
        await t.db
          .selectFrom('capacity_pools')
          .select(['held', 'committed'])
          .where('id', '=', pool.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ held: 0, committed: 0 });
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
    // The session starts within the hour (the file shares one clock, so it advances only a little).
    const trialStart = new Date(t.clock.now().getTime() + 60 * 60_000);
    const trialSession = await session(trial, trialStart.toISOString());
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
    // SPK-YOUTH-003: attendance is recorded once the session has taken place.
    t.clock.advance(90 * 60_000);
    const attended = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
      outcome: 'attended',
      expectedRevision: 1,
    });
    expect(attended.body).toMatchObject({ status: 'attended' });
    const attendedAt = attended.body.attendedAt as string;
    expect(new Date(attendedAt).getTime()).toBeGreaterThan(trialStart.getTime());
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
    const trialSession = await session(
      trial,
      new Date(t.clock.now().getTime() + 30 * 60_000).toISOString(),
    );
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
    t.clock.advance(60 * 60_000);
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

  it('GAPS-TRIAGE-01 / SPK-YOUTH-003: a priced trial is refused, with or without a session, and nothing is recorded', async () => {
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const pricedTrial = await offering(t, {
      kind: 'trial',
      programId: trialProgram,
      basePriceMinor: 2_000,
    });
    const trialSession = await session(
      pricedTrial,
      new Date(t.clock.now().getTime() + 120 * 60_000).toISOString(),
    );
    const kid = await child(t, [parent]);
    await acknowledge(t, pricedTrial, kid, parent.personId);
    for (const sessionId of [trialSession, undefined]) {
      const refused = await post(t, '/v1/trial-participations', parent.header, {
        offeringId: pricedTrial.offeringId,
        participantPersonId: kid,
        ...(sessionId ? { sessionId } : {}),
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.details).toMatchObject({
        code: 'SESSION_PAYMENT_UNAVAILABLE',
        kind: 'trial',
        amountMinor: 2_000,
        pendingDecisions: ['DEC-003'],
      });
    }
    expect(
      await t.db
        .selectFrom('trial_participations')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('session_bookings')
        .select('id')
        .where('session_id', '=', trialSession)
        .execute(),
    ).toEqual([]);
  });

  it('CAPABILITIES-04 / SPK-COND-003: a trial converts only into participation: a rental needs its booking, a membership its switch', async () => {
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: trialProgram, basePriceMinor: 0 });
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    const convert = (targetOfferingId: string, intent?: string) =>
      post(t, `/v1/trial-participations/${id}/convert`, parent.header, {
        targetOfferingId,
        ...(intent ? { intent } : {}),
        expectedRevision: created.body.revision,
      });
    // A rental exists only with its reservation and staffing (POST /v1/bookings), whatever the
    // rentals switch says: no follow-up line would ever book the space.
    const rental = await offering(t, { kind: 'rental', basePriceMinor: 5_000 });
    for (const intent of ['rental_request', 'party_request']) {
      const refused = await convert(rental.offeringId, intent);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.details.code).toBe('BOOKING_REQUIRED');
    }
    // A membership is a Package G sale: refused while memberships is off (the test default).
    const membership = await membershipOffering(t, {
      attendance: { mode: 'none' },
      term: { kind: 'offering_dates' },
      renewal: { noticeLeadDays: null },
    });
    const gated = await convert(membership.offeringId, 'membership');
    expect(gated.status).toBe(403);
    expect(gated.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'memberships',
    });
    // Nothing was written by the refusals: no application, no follow-up basket, the trial as it was.
    expect(
      await t.db
        .selectFrom('applications')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('basket_lines')
        .select('id')
        .where('trial_participation_id', '=', id)
        .execute(),
    ).toEqual([]);
    // Participation is still a conversion.
    const term = await offering(t, { programId: trialProgram, basePriceMinor: 18_000 });
    const converted = await convert(term.offeringId);
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.basket.lines[0]).toMatchObject({
      intent: 'youth',
      trialParticipationId: id,
    });
  });

  it('SPK-YOUTH-003 / SPK-AT-019: trial attendance and no-show cannot be recorded before the session starts', async () => {
    const trialProgram = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: trialProgram, basePriceMinor: 0 });
    const start = new Date(t.clock.now().getTime() + 2 * DAY);
    const trialSession = await session(trial, start.toISOString());
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId: trialSession,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    for (const outcome of ['attended', 'no_show'] as const) {
      const early = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
        outcome,
        expectedRevision: 1,
      });
      expect(early.status, JSON.stringify(early.body)).toBe(400);
      expect(early.body.code).toBe('VALIDATION_FAILED');
      expect(early.body.details).toMatchObject({
        code: 'trial_not_started',
        scheduledFor: start.toISOString(),
      });
    }
    const unchanged = await t.http.get(`/v1/trial-participations/${id}`).set(parent.header);
    expect(unchanged.body).toMatchObject({ status: 'scheduled', revision: 1, attendedAt: null });
    // The family may still cancel before the session.
    const canceled = await post(t, `/v1/trial-participations/${id}/outcome`, parent.header, {
      outcome: 'canceled',
      expectedRevision: 1,
    });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({ status: 'canceled' });
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
