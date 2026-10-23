import { defineEvent, z, type DomainEvent } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
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
});
