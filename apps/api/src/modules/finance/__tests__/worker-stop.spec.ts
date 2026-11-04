import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import type { FinanceWorkerSummary } from '../services/finance-worker';
import { financeTestApp, worker } from './support';

const SUMMARY: FinanceWorkerSummary = {
  refundsExecuted: 0,
  refundsReconciled: 0,
  paymentsCanceled: 0,
  paymentsReconciled: 0,
  installmentsCollected: 0,
};

/**
 * R3-OPERATIONS-10 (§4.12, §5.8): stopping the finance provider worker starts no further pass and
 * resolves only once the pass in flight has recorded its outcomes, so the kernel's bounded
 * shutdown waits for a provider call instead of cutting it off.
 */
describe('finance worker stop waits for the pass in flight (R3-OPERATIONS-10)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await financeTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.12: stop resolves after the pass in hand finishes', async () => {
    const finance = worker(t);
    let release!: (summary: FinanceWorkerSummary) => void;
    const inHand = new Promise<FinanceWorkerSummary>((resolve) => {
      release = resolve;
    });
    const runOnce = vi
      .spyOn(finance, 'runOnce')
      .mockImplementationOnce(() => inHand)
      .mockResolvedValue(SUMMARY);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      finance.start();
      vi.advanceTimersToNextTimer();
      expect(runOnce).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = finance.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);
      release(SUMMARY);
      await stopping;
      expect(stopped).toBe(true);
      vi.advanceTimersToNextTimer();
      expect(runOnce).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      runOnce.mockRestore();
      await finance.stop();
    }
  });
});
