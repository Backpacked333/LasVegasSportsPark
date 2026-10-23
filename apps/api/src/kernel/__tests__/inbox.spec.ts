import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { Inbox } from '../inbox/inbox';

describe('provider inbox (§4.11 webhooks, §4.12)', () => {
  let t: TestApp;
  let inbox: Inbox;
  const handled: string[] = [];
  let failing = false;

  beforeAll(async () => {
    t = await createTestApp();
    inbox = t.app.get(Inbox);
    inbox.on('fake-payments', 'record', async (event) => {
      if (failing) throw new Error('downstream unavailable');
      handled.push(event.providerEventId);
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('records duplicates once and processes each event once', async () => {
    const a = await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_1',
      eventType: 'payment.succeeded',
      payload: { ok: true },
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    const b = await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_1',
      eventType: 'payment.succeeded',
      payload: { ok: true },
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(await inbox.runOnce()).toMatchObject({ processed: 1 });
    expect(handled).toEqual(['evt_1']);
    expect(await inbox.runOnce()).toMatchObject({ processed: 0 });
  });

  it('retries failed events and dead-letters with an exception after repeated failure', async () => {
    failing = true;
    await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_2',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    for (let i = 0; i < 9; i += 1) {
      expect(await inbox.runOnce()).toMatchObject({ failed: 1 });
    }
    expect(await inbox.runOnce()).toMatchObject({ dead: 1 });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'reliability.inbox_dead_letter')
      .executeTakeFirst();
    expect(exception).toBeDefined();
    failing = false;
    expect(handled).toEqual(['evt_1']);
  });
});
