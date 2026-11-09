import { defineEvent, z } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import { EventHandlerRegistry } from '../outbox/event-handler.registry';
import { Outbox } from '../outbox/outbox';
import { startInlineWorker } from '../workers/inline-worker';

const InlinePinged = defineEvent('kerneltest.inline_pinged', z.object({ n: z.number() }));

describe('inline worker loops (§4.12)', () => {
  let t: TestApp;
  const seen: number[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    t.app
      .get(EventHandlerRegistry)
      .on(InlinePinged.type, 'kerneltest.inline_recorder', async (event) => {
        seen.push((event.payload as { n: number }).n);
      });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.12: an event committed while the inline worker runs is dispatched; stop() waits for the pass in flight', async () => {
    const worker = startInlineWorker(t.app, t.config);
    try {
      await t.app.get(UnitOfWork).run((ctx) =>
        t.app.get(Outbox).enqueue(ctx.trx, InlinePinged, {
          organizationId: t.organizationId,
          aggregateType: 'ping',
          aggregateId: 'inline-1',
          payload: { n: 42 },
        }),
      );
      const deadline = Date.now() + 10_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen).toEqual([42]);
    } finally {
      await worker.stop();
    }
    const row = await t.db
      .selectFrom('outbox_events')
      .select('status')
      .where('aggregate_id', '=', 'inline-1')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('dispatched');
  });
});
