import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackgroundWorkers } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { CommunicationsModule } from '../../communications/communications.module';
import { DeliveryWorker } from '../../communications/services/delivery-worker';
import { FinanceModule } from '../finance.module';
import { FinanceWorker } from '../services/finance-worker';

/**
 * §4.1, §4.12: the provider-facing refund, installment and message delivery loops belong to the
 * worker process. An API process (here: a development configuration, where they used to start)
 * registers them but never starts them; `worker.ts` starts every registered background worker.
 */
describe('provider-facing pollers run in the worker process only (§4.1, §4.12)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FinanceModule, CommunicationsModule],
      principalResolver: 'module',
      env: { NODE_ENV: 'development' },
    });
  });
  afterAll(async () => {
    t.app.get(BackgroundWorkers).stopAll();
    await t.close();
  });

  const finance = () => t.app.get(FinanceWorker) as unknown as { timer: unknown };
  const delivery = () => t.app.get(DeliveryWorker) as unknown as { started: boolean };

  it('§4.1: an API process registers the provider pollers without starting them', () => {
    const workers = t.app.get(BackgroundWorkers);
    expect(workers.names()).toEqual(
      expect.arrayContaining(['finance.provider_worker', 'communications.delivery_worker']),
    );
    expect(workers.isStarted()).toBe(false);
    expect(finance().timer).toBeNull();
    expect(delivery().started).toBe(false);
  });

  it('§4.12: the worker process starts and stops them through the registry', () => {
    const workers = t.app.get(BackgroundWorkers);
    workers.startAll();
    expect(finance().timer).not.toBeNull();
    expect(delivery().started).toBe(true);
    workers.stopAll();
    expect(finance().timer).toBeNull();
    expect(delivery().started).toBe(false);
  });
});
