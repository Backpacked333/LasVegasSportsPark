import { defineEvent, z, type DomainEvent } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { currentTransaction } from '../database/transaction-context';
import { UnitOfWork } from '../database/unit-of-work';
import { EventHandlerRegistry } from '../outbox/event-handler.registry';
import { Outbox } from '../outbox/outbox';
import { OutboxDispatcher, retryDelayMs } from '../outbox/outbox-dispatcher';

const Pinged = defineEvent('test.pinged', z.object({ n: z.number() }));

describe('transactional outbox and durable dispatch (§4.12, SPK-AT-023)', () => {
  let t: TestApp;
  let uow: UnitOfWork;
  let outbox: Outbox;
  let registry: EventHandlerRegistry;
  let dispatcher: OutboxDispatcher;
  const received: Array<{ handler: string; event: DomainEvent }> = [];
  let failuresLeft = 0;

  beforeAll(async () => {
    t = await createTestApp();
    uow = t.app.get(UnitOfWork);
    outbox = t.app.get(Outbox);
    registry = t.app.get(EventHandlerRegistry);
    dispatcher = t.app.get(OutboxDispatcher);
    registry.on(Pinged.type, 'recorder', async (event, ctx) => {
      // handler effects commit together with the consumption record
      await ctx.trx
        .insertInto('audit_records')
        .values({
          id: event.id,
          organization_id: event.organizationId,
          actor: JSON.stringify({ kind: 'system', actorLabel: 'recorder' }),
          action: 'test.recorded',
          target_type: 'ping',
          target_id: event.aggregateId,
          before_revision: null,
          after_revision: null,
          reason: null,
          correlation_id: event.correlationId,
          operation_id: null,
        })
        .execute();
      received.push({ handler: 'recorder', event });
    });
    registry.on(Pinged.type, 'flaky', async (event) => {
      received.push({ handler: 'flaky', event });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('transient failure');
      }
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('validates payloads against the event definition and rolls back with the transaction', async () => {
    await expect(
      uow.run((ctx) =>
        outbox.enqueue(ctx.trx, Pinged, {
          organizationId: t.organizationId,
          aggregateType: 'ping',
          aggregateId: 'bad',
          payload: { n: 'x' } as never,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      uow.run(async (ctx) => {
        await outbox.enqueue(ctx.trx, Pinged, {
          organizationId: t.organizationId,
          aggregateType: 'ping',
          aggregateId: 'rolled-back',
          payload: { n: 0 },
        });
        throw new Error('business failure after enqueue');
      }),
    ).rejects.toThrow(/business failure/);
    const rows = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('aggregate_id', '=', 'rolled-back')
      .execute();
    expect(rows).toEqual([]);
  });

  it('dispatches each event to every handler exactly once, even when redelivered', async () => {
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Pinged, {
        organizationId: t.organizationId,
        aggregateType: 'ping',
        aggregateId: 'p1',
        payload: { n: 1 },
        correlationId: 'corr-p1',
      }),
    );
    const summary = await dispatcher.runOnce();
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(
      received
        .filter((r) => r.event.id === event.id)
        .map((r) => r.handler)
        .sort(),
    ).toEqual(['flaky', 'recorder']);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('id', '=', event.id)
      .execute();
    expect(audit).toHaveLength(1);

    // Simulate a lost acknowledgement: the event is marked pending again (redelivery).
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null })
      .where('id', '=', event.id)
      .execute();
    const again = await dispatcher.runOnce();
    expect(again).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(received.filter((r) => r.event.id === event.id)).toHaveLength(2);
    const attempts = await t.db
      .selectFrom('job_attempts')
      .select(['handler', 'outcome'])
      .where('source_id', '=', event.id)
      .orderBy('attempt_number')
      .execute();
    expect(attempts.filter((a) => a.outcome === 'skipped')).toHaveLength(2);
  });

  it('retries a failing handler with backoff without re-running handlers that succeeded', async () => {
    failuresLeft = 1;
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Pinged, {
        organizationId: t.organizationId,
        aggregateType: 'ping',
        aggregateId: 'p2',
        payload: { n: 2 },
      }),
    );
    const first = await dispatcher.runOnce();
    expect(first).toMatchObject({ claimed: 1, retried: 1 });
    const row = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/flaky: Error: transient failure/);
    expect(new Date(row.available_at).getTime()).toBe(t.clock.now().getTime() + retryDelayMs(1));

    const tooEarly = await dispatcher.runOnce();
    expect(tooEarly.claimed).toBe(0);

    t.clock.advance(retryDelayMs(1) + 1);
    const second = await dispatcher.runOnce();
    expect(second).toMatchObject({ claimed: 1, dispatched: 1 });
    const recorderRuns = received.filter(
      (r) => r.event.id === event.id && r.handler === 'recorder',
    );
    const flakyRuns = received.filter((r) => r.event.id === event.id && r.handler === 'flaky');
    expect(recorderRuns).toHaveLength(1);
    expect(flakyRuns).toHaveLength(2);
  });

  it('dead-letters after max attempts and raises an owned operational exception', async () => {
    failuresLeft = 99;
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Pinged, {
        organizationId: t.organizationId,
        aggregateType: 'ping',
        aggregateId: 'p3',
        payload: { n: 3 },
        maxAttempts: 2,
      }),
    );
    expect(await dispatcher.runOnce()).toMatchObject({ retried: 1 });
    t.clock.advance(retryDelayMs(1) + 1);
    expect(await dispatcher.runOnce()).toMatchObject({ dead: 1 });
    const row = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'dead', failure_owner: 'system_administrator' });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('dedupe_key', '=', `outbox:${event.id}`)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'reliability.outbox_dead_letter',
      severity: 'high',
      owner_queue: 'system_administrator',
      status: 'open',
    });
    failuresLeft = 0;
  });

  it('reclaims events whose worker died (expired lease)', async () => {
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Pinged, {
        organizationId: t.organizationId,
        aggregateType: 'ping',
        aggregateId: 'p4',
        payload: { n: 4 },
      }),
    );
    // another worker claimed it and crashed
    await t.db
      .updateTable('outbox_events')
      .set({ locked_by: 'dead-worker', locked_until: new Date(t.clock.now().getTime() + 5000) })
      .where('id', '=', event.id)
      .execute();
    expect((await dispatcher.runOnce()).claimed).toBe(0);
    t.clock.advance(6000);
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, dispatched: 1 });
  });

  it('§4.12: handlers run in the transaction context, so ports and the reader see their own writes', async () => {
    const Probe = defineEvent('test.context_probe', z.object({ slug: z.string() }));
    const seen: Array<Record<string, boolean>> = [];
    let continuation: Promise<{ current: boolean; reader: boolean; readOk: boolean }> | null = null;
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    registry.on(Probe.type, 'context_probe', async (event, ctx) => {
      const { slug } = event.payload as { slug: string };
      await ctx.trx
        .insertInto('organizations')
        .values({ id: event.id, slug, name: 'probe' })
        .execute();
      const own = await uow
        .reader()
        .selectFrom('organizations')
        .select('id')
        .where('slug', '=', slug)
        .executeTakeFirst();
      seen.push({
        current: currentTransaction() === ctx.trx,
        reader: uow.reader() === ctx.trx,
        ownWrite: own !== undefined,
      });
      // Work that outlives the handler (a worker nudge) must not use its finished transaction.
      continuation = resumed.then(async () => {
        const reader = uow.reader();
        const row = await reader
          .selectFrom('organizations')
          .select('id')
          .where('slug', '=', slug)
          .executeTakeFirst();
        return {
          current: currentTransaction() !== undefined,
          reader: reader === t.db,
          readOk: !!row,
        };
      });
    });
    await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Probe, {
        organizationId: t.organizationId,
        aggregateType: 'probe',
        aggregateId: 'ctx',
        payload: { slug: 'outbox-ctx-probe' },
      }),
    );
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(seen).toEqual([{ current: true, reader: true, ownWrite: true }]);
    resume();
    expect(await continuation).toEqual({ current: false, reader: true, readOk: true });
  });

  it('§4.12: after-commit hooks run only after the handler committed, never on a failed attempt or a replay', async () => {
    const Hooked = defineEvent('test.hooked', z.object({ n: z.number() }));
    const hooks: string[] = [];
    let failNext = true;
    registry.on(Hooked.type, 'hooked', async (_event, ctx) => {
      ctx.afterCommit(() => {
        hooks.push(`attempt-${ctx.attempt}`);
      });
      if (failNext) {
        failNext = false;
        throw new Error('transient');
      }
    });
    const event = await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, Hooked, {
        organizationId: t.organizationId,
        aggregateType: 'hooked',
        aggregateId: 'h1',
        payload: { n: 1 },
      }),
    );
    expect(await dispatcher.runOnce()).toMatchObject({ retried: 1 });
    expect(hooks).toEqual([]);
    t.clock.advance(retryDelayMs(1) + 1);
    expect(await dispatcher.runOnce()).toMatchObject({ dispatched: 1 });
    expect(hooks).toEqual(['attempt-2']);
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null })
      .where('id', '=', event.id)
      .execute();
    expect(await dispatcher.runOnce()).toMatchObject({ dispatched: 1 });
    expect(hooks).toEqual(['attempt-2']);
  });

  it('events without handlers are dispatched (facts are recorded even before consumers exist)', async () => {
    await uow.run((ctx) =>
      outbox.enqueue(ctx.trx, 'test.unhandled', {
        organizationId: t.organizationId,
        aggregateType: 'x',
        aggregateId: 'y',
        payload: {},
      }),
    );
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, dispatched: 1 });
  });

  describe('§4.12: status writes are fenced on the claim lease', () => {
    const Leased = defineEvent('test.leased', z.object({ n: z.number() }));
    const enqueueLeased = (n: number, maxAttempts = 10) =>
      uow.run((ctx) =>
        outbox.enqueue(ctx.trx, Leased, {
          organizationId: t.organizationId,
          aggregateType: 'leased',
          aggregateId: `l${n}`,
          payload: { n },
          maxAttempts,
        }),
      );
    // Stands in for worker B, which re-claimed the event after this run's lease lapsed.
    const takeOver = (id: string, set: { status?: 'pending' | 'dispatched'; attempts?: number }) =>
      t.db
        .updateTable('outbox_events')
        .set({
          locked_by: 'worker-b:claim',
          locked_until: new Date(t.clock.now().getTime() + 60_000),
          ...set,
        })
        .where('id', '=', id)
        .execute();
    beforeAll(() => {
      registry.on(Leased.type, 'leased', async () => undefined);
    });
    const rowOf = (id: string) =>
      t.db.selectFrom('outbox_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    it('a run whose lease lapsed cannot dead-letter an event another worker dispatched', async () => {
      const event = await enqueueLeased(1, 1);
      const spy = vi
        .spyOn(dispatcher as unknown as { runHandler: () => Promise<string | null> }, 'runHandler')
        .mockImplementationOnce(async () => {
          // the handler failed here while worker B handled the event and dispatched it
          await takeOver(event.id, { status: 'dispatched' });
          return 'transient failure';
        });
      expect(await dispatcher.runOnce()).toMatchObject({ claimed: 1, dead: 0, superseded: 1 });
      spy.mockRestore();
      expect(await rowOf(event.id)).toMatchObject({ status: 'dispatched', failure_owner: null });
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('dedupe_key', '=', `outbox:${event.id}`)
        .executeTakeFirst();
      expect(exception).toBeUndefined();
    });

    it('a run whose lease lapsed cannot overwrite the attempts and lease of the new owner', async () => {
      const event = await enqueueLeased(2);
      const spy = vi
        .spyOn(dispatcher as unknown as { runHandler: () => Promise<string | null> }, 'runHandler')
        .mockImplementationOnce(async () => {
          await takeOver(event.id, { attempts: 4 });
          return null;
        });
      expect(await dispatcher.runOnce()).toMatchObject({
        claimed: 1,
        dispatched: 0,
        superseded: 1,
      });
      spy.mockRestore();
      expect(await rowOf(event.id)).toMatchObject({
        status: 'pending',
        attempts: 4,
        locked_by: 'worker-b:claim',
      });
    });

    it('skips claimed events another worker took over before this run reached them', async () => {
      const first = await enqueueLeased(3);
      const second = await enqueueLeased(4);
      const calls: string[] = [];
      const spy = vi
        .spyOn(
          dispatcher as unknown as { runHandler: (e: DomainEvent) => Promise<string | null> },
          'runHandler',
        )
        .mockImplementation(async (e: DomainEvent) => {
          calls.push(e.id);
          // the batch is slow: while the first event runs, worker B re-claims the tail
          if (e.id === first.id) await takeOver(second.id, {});
          return null;
        });
      const summary = await dispatcher.runOnce();
      spy.mockRestore();
      expect(summary).toMatchObject({ claimed: 2, dispatched: 1, superseded: 1 });
      expect(calls).toEqual([first.id]);
      expect(await rowOf(second.id)).toMatchObject({
        status: 'pending',
        locked_by: 'worker-b:claim',
      });
    });
  });
});
