import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { currentTransaction } from '../database/transaction-context';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { Inbox } from '../inbox/inbox';
import { retryDelayMs } from '../outbox/outbox-dispatcher';

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

  it('§4.12: retries failed events with backoff and dead-letters with an owned exception after max attempts', async () => {
    failing = true;
    const { id } = await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_2',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    const row = () =>
      t.db.selectFrom('inbox_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(await inbox.runOnce()).toMatchObject({ failed: 1 });
    for (let attempt = 1; attempt < 9; attempt += 1) {
      const failed = await row();
      expect(failed).toMatchObject({ status: 'failed', attempts: attempt });
      expect(new Date(failed.available_at).getTime()).toBe(
        t.clock.now().getTime() + retryDelayMs(attempt),
      );
      // Not before its retry time: an immediate poll leaves it alone and uses no attempt.
      expect(await inbox.runOnce()).toEqual({ processed: 0, failed: 0, dead: 0 });
      expect((await row()).attempts).toBe(attempt);
      t.clock.advance(retryDelayMs(attempt));
      expect(await inbox.runOnce()).toMatchObject({ failed: 1 });
    }
    t.clock.advance(retryDelayMs(9));
    expect(await inbox.runOnce()).toMatchObject({ dead: 1 });
    expect(await row()).toMatchObject({
      status: 'dead',
      attempts: 10,
      failure_owner: 'system_administrator',
      locked_by: null,
    });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'reliability.inbox_dead_letter')
      .executeTakeFirst();
    expect(exception).toMatchObject({ owner_queue: 'system_administrator', affected_id: id });
    failing = false;
    expect(handled).toEqual(['evt_1']);
  });

  it('§4.12: an event without an organization is dead-lettered with a failure owner', async () => {
    failing = true;
    const { id } = await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_orgless',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: null,
      signatureVerified: true,
    });
    await t.db.updateTable('inbox_events').set({ max_attempts: 2 }).where('id', '=', id).execute();
    expect(await inbox.runOnce()).toMatchObject({ failed: 1 });
    t.clock.advance(retryDelayMs(1));
    expect(await inbox.runOnce()).toMatchObject({ dead: 1 });
    expect(
      await t.db.selectFrom('inbox_events').selectAll().where('id', '=', id).executeTakeFirst(),
    ).toMatchObject({ status: 'dead', attempts: 2, failure_owner: 'system_administrator' });
    failing = false;
  });

  it('§4.12: concurrent runners never claim the same event: each event is processed by exactly one runner', async () => {
    const exceptions = t.app.get(OperationalExceptions);
    const calls: string[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const runner = (label: string) => {
      const instance = new Inbox(t.db, t.config, t.clock, exceptions);
      instance.on('fake-concurrent', 'record', async (event) => {
        calls.push(`${label}:${event.providerEventId}`);
        firstStarted();
        // Yield so the other runner polls while this event is being processed.
        await new Promise((resolve) => setImmediate(resolve));
      });
      return instance;
    };
    const a = runner('a');
    const b = runner('b');
    for (const n of [1, 2, 3, 4]) {
      await a.record({
        provider: 'fake-concurrent',
        providerEventId: `concurrent_${n}`,
        eventType: 'payment.succeeded',
        payload: {},
        organizationId: t.organizationId,
        signatureVerified: true,
      });
    }
    const first = a.runOnce();
    await started;
    const second = b.runOnce();
    const [sa, sb] = await Promise.all([first, second]);
    expect(sa.processed + sb.processed).toBe(4);
    expect(sa.failed + sb.failed + sa.dead + sb.dead).toBe(0);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.split(':')[1])).size).toBe(4);
  });

  it('§4.12: a runner whose claim is still leased is not overtaken; an expired lease is reclaimed and processed once', async () => {
    const { id } = await inbox.record({
      provider: 'fake-payments',
      providerEventId: 'evt_leased',
      eventType: 'payment.succeeded',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    // Another worker claimed it and stopped (crash): its lease is still running.
    await t.db
      .updateTable('inbox_events')
      .set({
        locked_by: 'dead-worker:claim',
        locked_until: new Date(t.clock.now().getTime() + t.config.OUTBOX_LOCK_LEASE_SECONDS * 1000),
      })
      .where('id', '=', id)
      .execute();
    expect(await inbox.runOnce()).toEqual({ processed: 0, failed: 0, dead: 0 });
    t.clock.advance(t.config.OUTBOX_LOCK_LEASE_SECONDS * 1000 + 1);
    expect(await inbox.runOnce()).toMatchObject({ processed: 1 });
    expect(handled.filter((e) => e === 'evt_leased')).toHaveLength(1);
    expect(
      await t.db.selectFrom('inbox_events').selectAll().where('id', '=', id).executeTakeFirst(),
    ).toMatchObject({ status: 'processed', locked_by: null, locked_until: null });
  });

  it('runs handlers in the transaction context, and after-commit hooks only after a committed attempt', async () => {
    const uow = t.app.get(UnitOfWork);
    const seen: Array<{ current: boolean; reader: boolean; ownWrite: boolean }> = [];
    const hooks: string[] = [];
    let failOnce = true;
    inbox.on('fake-context', 'probe', async (event, ctx) => {
      await ctx.trx
        .insertInto('organizations')
        .values({ id: newId(), slug: `inbox-ctx-${event.providerEventId}`, name: 'ctx' })
        .execute();
      const own = await uow
        .reader()
        .selectFrom('organizations')
        .select('id')
        .where('slug', '=', `inbox-ctx-${event.providerEventId}`)
        .executeTakeFirst();
      seen.push({
        current: currentTransaction() === ctx.trx,
        reader: uow.reader() === ctx.trx,
        ownWrite: own !== undefined,
      });
      ctx.afterCommit(() => {
        hooks.push(`${event.providerEventId}:attempt-${ctx.attempt}`);
      });
      if (failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
    });
    const { id } = await inbox.record({
      provider: 'fake-context',
      providerEventId: 'ctx_1',
      eventType: 'probe',
      payload: {},
      organizationId: t.organizationId,
      signatureVerified: true,
    });
    expect(await inbox.runOnce()).toMatchObject({ failed: 1 });
    expect(hooks).toEqual([]);
    t.clock.advance(retryDelayMs(1));
    expect(await inbox.runOnce()).toMatchObject({ processed: 1 });
    expect(seen).toEqual([
      { current: true, reader: true, ownWrite: true },
      { current: true, reader: true, ownWrite: true },
    ]);
    expect(hooks).toEqual(['ctx_1:attempt-2']);
    // A replay of a consumed event runs no handler and no hook.
    await t.db
      .updateTable('inbox_events')
      .set({ status: 'received' })
      .where('id', '=', id)
      .execute();
    expect(await inbox.runOnce()).toMatchObject({ processed: 1 });
    expect(hooks).toEqual(['ctx_1:attempt-2']);
  });
});
