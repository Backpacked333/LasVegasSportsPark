import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import { createOfferingSessionFixture, createProgramFixture } from '../../modules/catalog';
import {
  CLOCK_START,
  acknowledge,
  adult,
  child,
  drain,
  offering,
  post,
  staff,
} from '../../modules/enrollment/__tests__/support';
import { FakePaymentTokens } from '../../modules/finance';
import { createTestApp, type TestApp } from '../../testing';

const HOUR = 60 * 60_000;

/**
 * SPK-AT-019 (spec §6.1): "Trial converts to paid participation — separate trial history and paid
 * entitlement", over the assembled application: the trial (enrollment) is attended, then converted
 * into a basket that is quoted and paid through finance (`/v1/registration-quotes`,
 * `/v1/registration-checkouts`). SPK-YOUTH-003: the trial outcome is an observation, so it cannot
 * be recorded before the session starts.
 */
describe('SPK-AT-019: trial converts to paid participation (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-AT-019: the trial is attended once its session took place, converts, and is paid through checkout; trial history and the paid entitlement stay separate', async () => {
    const parent = await adult(t);
    const frontDesk = await staff(t, ['front_desk']);
    const program = await createProgramFixture(t, {
      ageBand: { minAgeYears: 5, maxAgeYears: 12 },
    });
    const trial = await offering(t, { kind: 'trial', programId: program, basePriceMinor: 0 });
    const start = new Date(t.clock.now().getTime() + 2 * HOUR);
    const trialSession = await createOfferingSessionFixture(t, {
      offeringId: trial.offeringId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + HOUR),
    });
    const term = await offering(t, { programId: program, basePriceMinor: 18_000 });
    const kid = await child(t, [parent]);
    await acknowledge(t, trial, kid, parent.personId);
    const created = await post(t, '/v1/trial-participations', parent.header, {
      offeringId: trial.offeringId,
      participantPersonId: kid,
      sessionId: trialSession,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;

    // SPK-YOUTH-003: attendance is observed, not predicted
    const early = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
      outcome: 'attended',
      expectedRevision: 1,
    });
    expect(early.status, JSON.stringify(early.body)).toBe(400);
    expect(early.body.details).toMatchObject({ code: 'trial_not_started' });

    t.clock.advance(3 * HOUR + 30 * 60_000);
    const attended = await post(t, `/v1/trial-participations/${id}/outcome`, frontDesk.header, {
      outcome: 'attended',
      expectedRevision: 1,
    });
    expect(attended.status, JSON.stringify(attended.body)).toBe(200);
    expect(new Date(attended.body.attendedAt as string).getTime()).toBeGreaterThan(start.getTime());

    const converted = await post(t, `/v1/trial-participations/${id}/convert`, parent.header, {
      targetOfferingId: term.offeringId,
      expectedRevision: 2,
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    await acknowledge(t, term, kid, parent.personId);
    const basketId = converted.body.basket.id as string;

    const quote = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expect(quote.body.totalMinor).toBe(18_000);
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.body.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain(t);

    const after = await t.http.get(`/v1/trial-participations/${id}`).set(parent.header);
    expect(after.body).toMatchObject({ status: 'converted', attendedAt: attended.body.attendedAt });
    const enrollments = await t.http
      .get(`/v1/enrollments?participantPersonId=${kid}`)
      .set(parent.header);
    const paid = (enrollments.body.items as Array<Record<string, unknown>>).filter(
      (e) => e['offeringId'] === term.offeringId,
    );
    expect(paid).toEqual([
      expect.objectContaining({ status: 'confirmed', trialParticipationId: id }),
    ]);
    expect(paid[0]?.['orderRef']).toEqual(expect.any(String));
    // the trial booking stays as history, separate from the paid entitlement
    const booking = await t.http
      .get(`/v1/session-bookings/${created.body.sessionBookingId as string}`)
      .set(parent.header);
    expect(booking.status).toBe(200);
    expect(booking.body.kind).toBe('trial');
  });
});
