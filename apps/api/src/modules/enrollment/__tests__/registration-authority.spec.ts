import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture, createProgramFixture } from '../../catalog';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
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
 * §4.7 invariant 1, §4.14 object-level authorization, SPK-REG-008/009, SPK-IAM-003/006: who may
 * own and pay for a registration, and authority over each participant read at the moment it is
 * used (not only when the line was added).
 */
describe('registration authority: owner, payer and current participant authority (§4.7-1, SPK-REG-008/009, SPK-IAM-003)', () => {
  let t: TestApp;
  let frontDesk: Actor;
  let programManager: Actor;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    frontDesk = await staff(t, ['front_desk']);
    programManager = await staff(t, ['program_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  /** A one-seat offering whose place is held by another family, a waitlist entry, then an offer. */
  async function offerFor(
    joiner: Actor,
    guardians: Actor[],
  ): Promise<{ offerId: string; entryId: string; kid: string; setup: OfferingSetup }> {
    const setup = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const holder = await adult(t);
    const holderKid = await child(t, [holder]);
    await acknowledge(t, setup, holderKid, holder.personId);
    const held = await basketWith(t, holder, [
      { participantPersonId: holderKid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${held.id}/hold`, holder.header, {})).status).toBe(200);
    const kid = await child(t, guardians);
    await acknowledge(t, setup, kid, guardians[0]!.personId);
    const joined = await post(t, '/v1/waitlist-entries', joiner.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    await post(t, `/v1/baskets/${held.id}/release`, holder.header, { reason: 'changed plans' });
    await drain(t);
    const entry = await t.http
      .get(`/v1/waitlist-entries/${joined.body.id as string}`)
      .set(programManager.header);
    expect(entry.body.status).toBe('offered');
    return { offerId: entry.body.offers[0].id as string, entryId: entry.body.id, kid, setup };
  }

  const offerState = async (offerId: string) => {
    const offer = await t.db
      .selectFrom('waitlist_offers')
      .select(['status', 'hold_id'])
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    const hold = await t.db
      .selectFrom('holds')
      .select('status')
      .where('id', '=', offer.hold_id)
      .executeTakeFirstOrThrow();
    return { offer: offer.status, hold: hold.status };
  };

  it('§4.7-1 / SPK-REG-008: accepting an offer never makes an unrelated adult the basket owner or payer', async () => {
    const guardian = await adult(t);
    const stranger = await adult(t);
    const { offerId, kid } = await offerFor(guardian, [guardian]);
    const foreignOwner = await post(t, `/v1/waitlist-offers/${offerId}/accept`, guardian.header, {
      ownerPersonId: stranger.personId,
      payerPersonId: stranger.personId,
    });
    // The same authority POST /baskets requires over the owner's household.
    expect(foreignOwner.status).toBe(403);
    expect(foreignOwner.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    const foreignPayer = await post(t, `/v1/waitlist-offers/${offerId}/accept`, guardian.header, {
      payerPersonId: stranger.personId,
    });
    expect(foreignPayer.status).toBe(403);
    expect(foreignPayer.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    // Nothing was consumed: the offer and its reserved place are still there.
    expect(await offerState(offerId)).toEqual({ offer: 'offered', hold: 'active' });
    expect(
      await t.db
        .selectFrom('baskets')
        .select('id')
        .where('owner_person_id', '=', stranger.personId)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    // The guardian accepts for their own household.
    const own = await post(t, `/v1/waitlist-offers/${offerId}/accept`, guardian.header, {});
    expect(own.status).toBe(200);
    expect(own.body.basket).toMatchObject({
      ownerPersonId: guardian.personId,
      payerPersonId: guardian.personId,
      status: 'held',
    });
  });

  it('SPK-REG-008: a co-guardian accepting an offer the other guardian joined owns and pays for the basket', async () => {
    const first = await adult(t);
    const second = await adult(t);
    const { offerId } = await offerFor(first, [first, second]);
    const accepted = await post(t, `/v1/waitlist-offers/${offerId}/accept`, second.header, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body.basket).toMatchObject({
      ownerPersonId: second.personId,
      payerPersonId: second.personId,
    });
    const enrollmentId = accepted.body.basket.lines[0].enrollmentId as string;
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['payer_person_id', 'status'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(enrollment).toEqual({ payer_person_id: second.personId, status: 'pending' });
    const read = await t.http
      .get(`/v1/baskets/${accepted.body.basket.id as string}`)
      .set(second.header);
    expect(read.status).toBe(200);
  });

  it('SPK-REG-009: staff accepting a staff-joined entry must name the family owner, never themselves', async () => {
    const parent = await adult(t);
    const { offerId } = await offerFor(frontDesk, [parent]);
    const unnamed = await post(t, `/v1/waitlist-offers/${offerId}/accept`, frontDesk.header, {});
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.code).toBe('VALIDATION_FAILED');
    expect(await offerState(offerId)).toEqual({ offer: 'offered', hold: 'active' });
    expect(
      await t.db
        .selectFrom('baskets')
        .select('id')
        .where('owner_person_id', '=', frontDesk.personId)
        .execute(),
    ).toEqual([]);
    const named = await post(t, `/v1/waitlist-offers/${offerId}/accept`, frontDesk.header, {
      ownerPersonId: parent.personId,
    });
    expect(named.status).toBe(200);
    expect(named.body.basket).toMatchObject({
      ownerPersonId: parent.personId,
      payerPersonId: parent.personId,
      assistedByPersonId: frontDesk.personId,
    });
  });

  it('§4.7-1 / SPK-REG-009: a customer names only themselves as payer; staff may name another payer', async () => {
    const setup = await offering(t);
    const parent = await adult(t);
    const stranger = await adult(t);
    const kid = await child(t, [parent]);
    const refused = (res: { status: number; body: { code?: string } }) => {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    };
    refused(
      await post(t, '/v1/baskets', parent.header, {
        payerPersonId: stranger.personId,
        fulfillmentMode: 'all_or_nothing',
      }),
    );
    refused(
      await post(t, '/v1/applications', parent.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
        payerPersonId: stranger.personId,
      }),
    );
    // Waitlist: the only place is held so the child may wait for it.
    const full = await offering(t, { capacityUnits: [{ unit: 'seats', limit: 1 }] });
    const holder = await adult(t);
    const holderKid = await child(t, [holder]);
    await acknowledge(t, full, holderKid, holder.personId);
    const held = await basketWith(t, holder, [
      { participantPersonId: holderKid, offeringId: full.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${held.id}/hold`, holder.header, {})).status).toBe(200);
    refused(
      await post(t, '/v1/waitlist-entries', parent.header, {
        offeringId: full.offeringId,
        participantPersonId: kid,
        intent: 'youth',
        payerPersonId: stranger.personId,
      }),
    );
    // Pickup session booking and a trial booking.
    const adults = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const pickup = await offering(t, { kind: 'pickup', programId: adults, basePriceMinor: 0 });
    const pickupSession = await createOfferingSessionFixture(t, {
      offeringId: pickup.offeringId,
      scheduledStart: new Date('2026-11-12T02:00:00Z'),
      scheduledEnd: new Date('2026-11-12T03:30:00Z'),
    });
    await acknowledge(t, pickup, parent.personId, parent.personId);
    refused(
      await post(t, '/v1/session-bookings', parent.header, {
        offeringId: pickup.offeringId,
        sessionId: pickupSession,
        participantPersonId: parent.personId,
        payerPersonId: stranger.personId,
      }),
    );
    const trial = await offering(t, { kind: 'trial', basePriceMinor: 0 });
    await acknowledge(t, trial, kid, parent.personId);
    refused(
      await post(t, '/v1/trial-participations', parent.header, {
        offeringId: trial.offeringId,
        participantPersonId: kid,
        payerPersonId: stranger.personId,
      }),
    );
    const trialRow = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
    });
    expect(trialRow.status).toBe(201);
    refused(
      await post(
        t,
        `/v1/trial-participations/${trialRow.body.id as string}/convert`,
        parent.header,
        {
          targetOfferingId: setup.offeringId,
          expectedRevision: trialRow.body.revision,
          payerPersonId: stranger.personId,
        },
      ),
    );
    // Nothing was written for the stranger.
    for (const table of [
      'baskets',
      'applications',
      'waitlist_entries',
      'session_bookings',
    ] as const) {
      expect(
        await t.db
          .selectFrom(table)
          .select('id')
          .where('payer_person_id', '=', stranger.personId)
          .execute(),
      ).toEqual([]);
    }
    // Assisted registration (SPK-REG-009): staff name the family's payer.
    const assisted = await post(t, '/v1/applications', frontDesk.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
      payerPersonId: parent.personId,
    });
    expect(assisted.status).toBe(201);
    expect(assisted.body.payerPersonId).toBe(parent.personId);
    const assistedBasket = await post(t, '/v1/baskets', frontDesk.header, {
      ownerPersonId: parent.personId,
      payerPersonId: stranger.personId,
      fulfillmentMode: 'all_or_nothing',
    });
    expect(assistedBasket.status).toBe(201);
    expect(assistedBasket.body.payerPersonId).toBe(stranger.personId);
  });

  // -------------------------------------------------------------------------------------------
  // SPK-IAM-003/006: authority over the participant is current when the place is held or confirmed
  // -------------------------------------------------------------------------------------------

  async function relatedChild(guardian: Actor, setup: OfferingSetup) {
    const kid = await createPersonFixture(t, { kind: 'child' });
    const relationship = await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: kid,
    });
    await acknowledge(t, setup, kid, guardian.personId);
    return { kid, registerGrantId: relationship.grantIds.register as string };
  }

  async function revoke(grantId: string) {
    const revoked = await post(t, `/v1/access-grants/${grantId}/revoke`, programManager.header, {
      reason: 'custody change',
    });
    expect(revoked.status).toBe(200);
    t.clock.advance(1000);
  }

  it('§4.7-1 / SPK-IAM-003: a hold after the adult lost register authority over the child is refused', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const parent = await adult(t);
    const { kid, registerGrantId } = await relatedChild(parent, setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    await revoke(registerGrantId);
    const direct = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(direct.status).toBe(403);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(403);
    expect(held.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    expect(
      await t.db
        .selectFrom('enrollments')
        .select('id')
        .where('participant_person_id', '=', kid)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db.selectFrom('holds').select('id').where('basket_id', '=', basket.id).execute(),
    ).toEqual([]);
  });

  it('SPK-REG-004 / SPK-IAM-003: in a partial basket only the line whose authority was revoked fails', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const parent = await adult(t);
    const revokedKid = await relatedChild(parent, setup);
    const keptKid = await relatedChild(parent, setup);
    const basket = await basketWith(
      t,
      parent,
      [
        { participantPersonId: revokedKid.kid, offeringId: setup.offeringId },
        { participantPersonId: keptKid.kid, offeringId: setup.offeringId },
      ],
      { fulfillmentMode: 'partial' },
    );
    await revoke(revokedKid.registerGrantId);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    const lines = held.body.lines as Array<{
      participantPersonId: string;
      outcome: string;
      outcomeReason: string | null;
    }>;
    expect(lines.find((l) => l.participantPersonId === revokedKid.kid)).toMatchObject({
      outcome: 'failed',
      outcomeReason: expect.stringContaining('PARTICIPANT_AUTHORITY_REQUIRED'),
    });
    expect(lines.find((l) => l.participantPersonId === keptKid.kid)?.outcome).toBe('held');
    expect(held.body.holds).toHaveLength(1);
  });

  it('§4.7-1 / SPK-IAM-003: completing after the authority was revoked is refused and the basket can be released', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const parent = await adult(t);
    const { kid, registerGrantId } = await relatedChild(parent, setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    await revoke(registerGrantId);
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status).toBe(403);
    expect(completed.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('participant_person_id', '=', kid)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('pending');
    const released = await post(t, `/v1/baskets/${basket.id}/release`, parent.header, {
      reason: 'no longer responsible',
    });
    expect(released.status).toBe(200);
    expect(released.body.status).toBe('released');
  });
});
