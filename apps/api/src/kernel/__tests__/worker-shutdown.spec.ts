import { Test } from '@nestjs/testing';
import type { Db } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import { loadConfig } from '../config';
import { UnitOfWork } from '../database/unit-of-work';
import { Inbox } from '../inbox/inbox';
import { PeriodicJobRegistry, PeriodicJobRunner } from '../jobs/periodic-jobs';
import { KernelModule } from '../kernel.module';
import { EventHandlerRegistry } from '../outbox/event-handler.registry';
import { Outbox } from '../outbox/outbox';
import { OutboxDispatcher } from '../outbox/outbox-dispatcher';
import { BackgroundWorkers } from '../workers/background-workers';
import { DATABASE } from '../tokens';

/** A promise the test resolves by hand, to hold a handler or a job pass in flight. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * R3-OPERATIONS-10 (recovery runbook §4 "stop workers cleanly", §4.12 workers tolerate
 * interruption): stopping the worker claims nothing more, waits for the work in hand to finish
 * and record its outcome, and hands claimed work it has not started back at once instead of
 * leaving it leased.
 */
describe('worker shutdown (R3-OPERATIONS-10)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('R3-OPERATIONS-10: the outbox dispatcher finishes the event in hand, hands the rest of its batch back and resolves stop() only then', async () => {
    const held = gate();
    const handled: string[] = [];
    let entered = false;
    t.app.get(EventHandlerRegistry).on('test.shutdown_probe', 'test.slow', async (event) => {
      entered = true;
      await held.opened;
      handled.push(event.id);
    });
    const outbox = t.app.get(Outbox);
    const uow = t.app.get(UnitOfWork);
    for (let i = 0; i < 3; i += 1) {
      await uow.run((ctx) =>
        outbox.enqueue(ctx.trx, 'test.shutdown_probe', {
          organizationId: t.organizationId,
          aggregateType: 'probe',
          aggregateId: `p${i}`,
          payload: {},
        }),
      );
    }
    const dispatcher = t.app.get(OutboxDispatcher);
    dispatcher.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The handler in hand is still running: stop() has not resolved.
    expect(stopped).toBe(false);
    held.open();
    await stopping;
    expect(handled).toHaveLength(1);
    const rows = await t.db
      .selectFrom('outbox_events')
      .select(['id', 'status', 'locked_by', 'locked_until'])
      .where('event_type', '=', 'test.shutdown_probe')
      .execute();
    expect(rows.filter((r) => r.status === 'dispatched').map((r) => r.id)).toEqual(handled);
    // The two not started are back in the queue at once, not leased until a timeout.
    expect(rows.filter((r) => r.status === 'pending')).toEqual([
      expect.objectContaining({ locked_by: null, locked_until: null }),
      expect.objectContaining({ locked_by: null, locked_until: null }),
    ]);
    // Nothing more is claimed after stop().
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(handled).toHaveLength(1);
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 2, dispatched: 2 });
  });

  it('R3-OPERATIONS-10: the inbox hands back the events it claimed but did not start once the worker stops', async () => {
    const inbox = t.app.get(Inbox);
    let stop = false;
    const seen: string[] = [];
    inbox.on('fake-shutdown', 'probe', async (event) => {
      seen.push(event.providerEventId);
      stop = true;
    });
    for (const n of [1, 2, 3]) {
      await inbox.record({
        provider: 'fake-shutdown',
        providerEventId: `sd_${n}`,
        eventType: 'probe',
        payload: {},
        organizationId: t.organizationId,
        signatureVerified: true,
      });
    }
    const summary = await inbox.runOnce(10, { shouldStop: () => stop });
    expect(summary).toMatchObject({ processed: 1, released: 2 });
    expect(seen).toHaveLength(1);
    const waiting = await t.db
      .selectFrom('inbox_events')
      .select(['status', 'locked_by'])
      .where('provider', '=', 'fake-shutdown')
      .where('status', '=', 'received')
      .execute();
    expect(waiting).toEqual([
      { status: 'received', locked_by: null },
      { status: 'received', locked_by: null },
    ]);
    expect(await inbox.runOnce(10, { shouldStop: () => true })).toMatchObject({ processed: 0 });
  });

  it('R3-OPERATIONS-10: the periodic job runner finishes the pass in flight, records it, starts no other job and resolves stop() after', async () => {
    const held = gate();
    let entered = false;
    const ran: string[] = [];
    const registry = t.app.get(PeriodicJobRegistry);
    registry.register({
      name: 'test.a_blocking',
      intervalSeconds: 60,
      failureOwner: 'system_administrator',
      run: async () => {
        entered = true;
        await held.opened;
        ran.push('a');
        return { processed: 1, remaining: 5 };
      },
    });
    registry.register({
      name: 'test.b_after',
      intervalSeconds: 60,
      failureOwner: 'system_administrator',
      run: async () => {
        ran.push('b');
        return { processed: 0, remaining: 0 };
      },
    });
    const workers = t.app.get(BackgroundWorkers);
    workers.startAll();
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stopping = workers.stopAll().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    held.open();
    await stopping;
    // One pass of the job in hand (it reported more remaining, but no second pass started), and
    // no further job was claimed.
    expect(ran).toEqual(['a']);
    const lease = await t.db
      .selectFrom('periodic_job_leases')
      .selectAll()
      .where('job_name', '=', 'test.a_blocking')
      .executeTakeFirstOrThrow();
    expect(lease).toMatchObject({ locked_by: null, locked_until: null, consecutive_failures: 0 });
    expect(lease.last_finished_at).not.toBeNull();
    const other = await t.db
      .selectFrom('periodic_job_leases')
      .select('job_name')
      .where('job_name', '=', 'test.b_after')
      .executeTakeFirst();
    expect(other).toBeUndefined();
    // Direct runs (tests, a later process) are not affected by an earlier stop.
    expect(
      (await t.app.get(PeriodicJobRunner).runOnce(['test.b_after'], { ignoreInterval: true }))[0],
    ).toMatchObject({ ran: true });
  });

  it('R3-OPERATIONS-10: closing the application closes the database the kernel opened', async () => {
    const config = loadConfig({ ...TEST_CONFIG_ENV });
    const moduleRef = await Test.createTestingModule({
      imports: [KernelModule.forRoot({ config })],
    }).compile();
    const app = await moduleRef.init();
    const db = app.get<Db>(DATABASE);
    await expect(db.selectFrom('organizations').select('id').execute()).resolves.toBeDefined();
    await app.close();
    await expect(db.selectFrom('organizations').select('id').execute()).rejects.toThrow();
  }, 60_000);
});
