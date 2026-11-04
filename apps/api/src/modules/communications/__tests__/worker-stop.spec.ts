import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { CommunicationsModule } from '../communications.module';
import { DeliveryWorker, type DeliverySummary } from '../services/delivery-worker';
import { withDeclaredPortDoubles } from './support';

const EMPTY: DeliverySummary = {
  claimed: 0,
  accepted: 0,
  failed: 0,
  unknown: 0,
  revoked: 0,
  skipped: 0,
};

/**
 * R3-OPERATIONS-10 (§4.12, §5.8): stopping the delivery worker claims nothing more and resolves
 * only once the drain in flight has recorded its outcomes, so the kernel's bounded shutdown
 * (WORKER_SHUTDOWN_TIMEOUT_MS) waits for a hand-off instead of cutting it off and leaving it to be
 * settled `unknown` later.
 */
describe('delivery worker stop waits for the drain in flight (R3-OPERATIONS-10)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      clockStart: '2026-10-23T12:00:00Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.12: stop resolves after the batch in hand finishes and starts no further batch', async () => {
    const worker = t.app.get(DeliveryWorker);
    let release!: (summary: DeliverySummary) => void;
    const inHand = new Promise<DeliverySummary>((resolve) => {
      release = resolve;
    });
    const runOnce = vi
      .spyOn(worker, 'runOnce')
      .mockImplementationOnce(() => inHand)
      .mockResolvedValue(EMPTY);
    try {
      worker.start();
      await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(1));
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);
      // the batch in hand claimed one attempt: a running worker would drain again
      release({ ...EMPTY, claimed: 1, accepted: 1 });
      await stopping;
      expect(stopped).toBe(true);
      expect(runOnce).toHaveBeenCalledTimes(1);
    } finally {
      runOnce.mockRestore();
      await worker.stop();
    }
  });
});
