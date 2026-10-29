import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import { createOfferingSessionFixture } from '../../modules/catalog';
import {
  FAKE_PAYMENTS_PROVIDER,
  FAKE_PAYMENTS_SIGNATURE_HEADER,
  FakePaymentProvider,
  FakePaymentTokens,
} from '../../modules/finance';
import { basketFor, offering, quoteFor } from '../../modules/finance/__tests__/support';
import { adult, child, drain, get, journeyApp, key, ok, post, processInbox } from './support';

/**
 * SPK-UX-001 ("foreground refresh after interrupted registration or payment") and SPK-AT-023
 * ("worker stops after registration commit: durable follow-up resumes without duplicate
 * effects"), §4.11, §4.12, across enrollment (basket, enrollments, family calendar), finance
 * (checkout, payment, receipts), communications (notices) and the kernel inbox and outbox, on the
 * assembled application. The payment needs a customer challenge; the app is interrupted; the
 * provider's answer arrives while no worker runs.
 */
describe('SPK-UX-001 / SPK-AT-023: interrupted payment resumes once (assembled application)', () => {
  it('the app reads the interrupted checkout back, a retried request charges nothing more, and the provider outcome recorded while the worker was stopped completes the registration exactly once', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-02T15:00:00Z' });
    try {
      const parent = await adult(t);
      const kid = await child(t, [parent]);
      const program = await offering(t, { basePriceMinor: 12_500 });
      const sessionId = await createOfferingSessionFixture(t, {
        offeringId: program.offeringId,
        scheduledStart: new Date('2027-01-12T01:00:00Z'),
        scheduledEnd: new Date('2027-01-12T02:00:00Z'),
      });
      const { basketId } = await basketFor(t, parent, [program], { participants: [kid] });
      const quote = await quoteFor(t, parent, basketId);
      const provider = t.app.get(FakePaymentProvider);

      // The payment needs the customer's challenge; then the app is interrupted.
      const idempotencyKey = key();
      const body = {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.requireAction },
      };
      const started = await ok<{
        id: string;
        status: string;
        nextAction: string;
        payment: { id: string; status: string };
      }>(post(t, '/v1/registration-checkouts', parent.header, body, idempotencyKey), 201);
      expect(started).toMatchObject({
        status: 'awaiting_payment',
        nextAction: 'complete_payment_action',
        payment: { status: 'action_required' },
      });
      const charges = provider.chargeCount();

      // Foreground refresh: the app finds the checkout and what it waits for.
      const mine = await ok<{ items: Array<{ id: string; status: string; nextAction: string }> }>(
        get(t, '/v1/me/registration-checkouts', parent.header),
      );
      expect(mine.items).toEqual([
        expect.objectContaining({
          id: started.id,
          status: 'awaiting_payment',
          nextAction: 'complete_payment_action',
        }),
      ]);
      const enrollmentsOf = async () =>
        (
          await ok<{ items: Array<{ id: string; status: string }> }>(
            get(t, `/v1/enrollments?participantPersonId=${kid}`, parent.header),
          )
        ).items;
      expect((await enrollmentsOf()).map((e) => e.status)).not.toContain('confirmed');
      // The interrupted request is retried with its key: the same answer, no second charge.
      const replay = await post(
        t,
        '/v1/registration-checkouts',
        parent.header,
        body,
        idempotencyKey,
      );
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ id: started.id, payment: { id: started.payment.id } });
      expect(provider.chargeCount()).toBe(charges);

      // The provider's success arrives while no worker runs: recorded, not yet applied.
      provider.settlePayment(started.payment.id, 'succeeded');
      const event = provider.paymentWebhook(started.payment.id);
      const webhook = () =>
        t.http
          .post(`/v1/webhooks/payments/${FAKE_PAYMENTS_PROVIDER}`)
          .set(FAKE_PAYMENTS_SIGNATURE_HEADER, event.signature)
          .send(event.body as object);
      expect((await webhook()).status).toBeLessThan(300);
      expect(
        (
          await ok<{ status: string }>(
            get(t, `/v1/registration-checkouts/${started.id}`, parent.header),
          )
        ).status,
      ).toBe('awaiting_payment');

      // The worker resumes: the recorded outcome completes the registration.
      await processInbox(t);
      await drain(t);
      const completed = await ok<{ status: string }>(
        get(t, `/v1/registration-checkouts/${started.id}`, parent.header),
      );
      expect(completed.status).toBe('completed');
      const confirmed = (await enrollmentsOf()).filter((e) => e.status === 'confirmed');
      expect(confirmed).toHaveLength(1);
      const effects = async () => ({
        receipts: (await ok<{ items: unknown[] }>(get(t, '/v1/me/receipts', parent.header))).items
          .length,
        journals: (await t.db.selectFrom('journals').select('id').execute()).length,
        notifications: (await t.db.selectFrom('notifications').select('id').execute()).length,
        enrollments: (await enrollmentsOf()).map((e) => [e.id, e.status]),
      });
      const once = await effects();
      expect(once.receipts).toBe(1);
      const calendar = await ok<{ items: Array<{ sessionId: string; personId: string }> }>(
        t.http
          .get('/v1/me/family-calendar')
          .query({ from: '2027-01-11T00:00:00Z', to: '2027-01-13T00:00:00Z' })
          .set(parent.header),
      );
      expect(calendar.items).toEqual([expect.objectContaining({ sessionId, personId: kid })]);

      // The provider repeats the event and the workers run again: nothing happens twice.
      const repeated = await webhook();
      expect(repeated.status).toBeLessThan(300);
      expect(repeated.body).toMatchObject({ duplicate: true });
      await processInbox(t);
      await drain(t);
      expect(await effects()).toEqual(once);
      expect(provider.chargeCount()).toBe(charges);
    } finally {
      await t.close();
    }
  });
});
