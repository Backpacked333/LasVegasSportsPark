import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import { TEST_CONFIG_ENV, type TestApp } from '../../../testing';
import { FakePaymentProvider } from '../providers/fake-payment.provider';
import { deliver, financeTestApp, provider } from './support';

/**
 * §4.14 / §5.2: the fake payment provider signs its webhooks with a published test constant by
 * default. A development or staging host reachable from the internet sets
 * FINANCE_FAKE_WEBHOOK_SECRET, and from then on only webhooks signed with that secret are
 * accepted: nobody who has read the source can post a payment outcome.
 */
describe('fake payment webhook secret override (§4.14, §5.2)', () => {
  const SECRET = 's'.repeat(40);
  let t: TestApp;
  beforeAll(async () => {
    t = await financeTestApp({ env: { FINANCE_FAKE_WEBHOOK_SECRET: SECRET } });
  });
  afterAll(async () => {
    await t?.close();
  });

  const orphan = (id: string) => ({
    id,
    type: 'payment.succeeded' as const,
    sequence: 1,
    data: {
      organizationId: t.organizationId,
      providerReference: 'fp_does_not_exist',
      amountMinor: 1_234,
      currency: 'USD',
    },
  });

  it('§4.14 / §5.2: a staging host with FINANCE_FAKE_WEBHOOK_SECRET refuses payment webhooks signed with the published test constant and records nothing', async () => {
    const body = orphan('evt_secret_constant');
    const refused = await deliver(t, { body, signature: FakePaymentProvider.sign(body) });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('AUTHENTICATION_REQUIRED');
    const recorded = await t.db
      .selectFrom('inbox_events')
      .select('id')
      .where('provider_event_id', '=', body.id)
      .executeTakeFirst();
    expect(recorded).toBeUndefined();
  });

  it("§4.11: the provider's own signature (the configured secret) is accepted (202) and a repeat is the duplicate scenario", async () => {
    const body = orphan('evt_secret_configured');
    const signed = { body, signature: provider(t).sign(body) };
    expect(provider(t).sign(body)).toBe(FakePaymentProvider.sign(body, SECRET));
    const first = await deliver(t, signed);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.duplicate).toBe(false);
    const again = await deliver(t, signed);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ inboxEventId: first.body.inboxEventId, duplicate: true });
  });

  it('§4.14: a FINANCE_FAKE_WEBHOOK_SECRET shorter than 32 characters refuses to boot', () => {
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, FINANCE_FAKE_WEBHOOK_SECRET: 'short' })).toThrow(
      /FINANCE_FAKE_WEBHOOK_SECRET/,
    );
  });
});
