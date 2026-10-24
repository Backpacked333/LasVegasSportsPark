import { describe, expect, it } from 'vitest';
import { PaymentOutcomeUnknownError } from '../finance.ports';
import { FakePaymentProvider, FakePaymentTokens, fakeFeeFor } from './fake-payment.provider';

const meta = (id: string) => ({
  organizationId: '00000000-0000-7000-8000-000000000001',
  paymentAttemptId: id,
});

describe('FakePaymentProvider (§5.2 deterministic provider scenarios)', () => {
  it('captures, deduplicates by idempotency key and never charges twice', async () => {
    const provider = new FakePaymentProvider();
    const request = {
      idempotencyKey: 'a1',
      amountMinor: 10_000,
      currency: 'USD',
      paymentMethodRef: FakePaymentTokens.succeed,
      metadata: meta('a1'),
    };
    const first = await provider.createPayment(request);
    const second = await provider.createPayment(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'succeeded', feeMinor: fakeFeeFor(10_000) });
    expect(provider.chargeCount()).toBe(1);
    expect(provider.paymentCalls).toHaveLength(2);
  });

  it('SPK-PAY-007: a timeout is not a failure — the provider may hold the money', async () => {
    const provider = new FakePaymentProvider();
    await expect(
      provider.createPayment({
        idempotencyKey: 'a2',
        amountMinor: 500,
        currency: 'USD',
        paymentMethodRef: FakePaymentTokens.timeout,
        metadata: meta('a2'),
      }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(await provider.retrievePayment('a2')).toMatchObject({ status: 'succeeded' });
    expect(await provider.retrievePayment('never-sent')).toBeNull();
  });

  it('signs webhooks and rejects tampered bodies', () => {
    const provider = new FakePaymentProvider();
    void provider.createPayment({
      idempotencyKey: 'a3',
      amountMinor: 700,
      currency: 'USD',
      paymentMethodRef: FakePaymentTokens.processing,
      metadata: meta('a3'),
    });
    provider.settlePayment('a3', 'succeeded');
    const event = provider.paymentWebhook('a3');
    expect(event.body.type).toBe('payment.succeeded');
    expect(provider.verifyWebhook(event.body, event.signature)).toBe(true);
    expect(
      provider.verifyWebhook(
        { ...event.body, data: { ...event.body.data, amountMinor: 1 } },
        event.signature,
      ),
    ).toBe(false);
    expect(provider.verifyWebhook(event.body, undefined)).toBe(false);
  });

  it('scripts refund outcomes deterministically', async () => {
    const provider = new FakePaymentProvider();
    provider.scriptRefunds('timeout', 'fail');
    const base = { providerPaymentReference: 'fp_x', amountMinor: 100, currency: 'USD' };
    await expect(
      provider.createRefund({
        ...base,
        idempotencyKey: 'r1',
        metadata: { organizationId: 'o', refundAttemptId: 'r1' },
      }),
    ).rejects.toBeInstanceOf(PaymentOutcomeUnknownError);
    expect(
      await provider.createRefund({
        ...base,
        idempotencyKey: 'r2',
        metadata: { organizationId: 'o', refundAttemptId: 'r2' },
      }),
    ).toMatchObject({ status: 'failed' });
    expect(
      await provider.createRefund({
        ...base,
        idempotencyKey: 'r3',
        metadata: { organizationId: 'o', refundAttemptId: 'r3' },
      }),
    ).toMatchObject({ status: 'succeeded' });
  });
});
