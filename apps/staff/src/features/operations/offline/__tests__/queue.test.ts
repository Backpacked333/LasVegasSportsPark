/**
 * The device's offline queue (§4.15, SPK-AT-018 "synchronize once", SCR-S-31): every prepared
 * batch is sent in one run (at most 500 items each), tabs sharing the browser storage never write
 * over each other's queued observations, and a batch the API refuses outright is kept for review
 * with its reason instead of being replayed for ever and blocking every later batch.
 */
import {
  ApiError,
  createCommandIntent,
  networkError,
  type CommandIntent,
  type Schema,
} from '@sportspark/api-client';
import { describe, expect, it } from 'vitest';
import { syncBatch } from '../../testing';
import { serviceClockOf } from '../clock';
import {
  MAX_BATCH_ITEMS,
  OFFLINE_QUEUE_STORAGE_KEY,
  OfflineQueueStore,
  OfflineSyncRunner,
  batchSender,
  type KeyValueStorage,
  type PendingBatch,
  type QueuedItem,
  type StorageEvents,
} from '../queue';

const ACCOUNT = 'account-1';
const NOW = () => new Date('2026-10-24T12:00:00.000Z');

function sharedStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function keys(prefix = 'k'): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, '0')}`;
}

let observation = 0;
function queued(facilityId: string, snapshot = 'roster-1'): QueuedItem {
  observation += 1;
  return {
    item: {
      kind: 'arrival',
      clientObservationId: `obs-${String(observation).padStart(6, '0')}`,
      personId: '0192f1a0-0000-7000-8000-00000000a001',
      visitorCategory: 'participant',
      observedAt: '2026-10-24T11:00:00.000Z',
    } as Schema<'OfflineItem'>,
    facilityId,
    snapshot: { reference: snapshot, takenAt: '2026-10-24T10:59:00.000Z' },
    queuedBy: ACCOUNT,
    queuedAt: '2026-10-24T11:00:00.000Z',
    context: null,
    batchId: null,
  };
}

function accepted(batch: PendingBatch) {
  return syncBatch(
    batch.items.map((q) => ({
      clientObservationId: q.item.clientObservationId,
      kind: q.item.kind,
      outcome: 'accepted',
    })),
  ) as unknown as Schema<'OfflineSyncBatch'>;
}

function refusal(code: string, status: number, details?: unknown): ApiError {
  return new ApiError({
    kind: 'api',
    status,
    code,
    message: `Safe message for ${code}.`,
    nextAction: 'correct_input',
    correlationId: 'corr-1',
    details,
  });
}

describe('offline queue batches (SPK-AT-018)', () => {
  it('SPK-AT-018: more than 500 items of one facility and snapshot are all returned and sent in one run', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue(Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => queued('f1')));
    const batches = store.prepareBatches(ACCOUNT);
    expect(batches.map((b) => b.items.length)).toEqual([MAX_BATCH_ITEMS, 1]);
    expect(new Set(batches.map((b) => b.batchId)).size).toBe(2);

    const sent: PendingBatch[] = [];
    const runner = new OfflineSyncRunner(store);
    const summary = await runner.run(
      ACCOUNT,
      (batch) => {
        sent.push(batch);
        return Promise.resolve(accepted(batch));
      },
      NOW,
    );
    expect(sent.map((b) => b.items.length)).toEqual([MAX_BATCH_ITEMS, 1]);
    expect(store.getState().pending).toHaveLength(0);
    expect(summary?.synchronised).toBe(MAX_BATCH_ITEMS + 1);
  });

  it('keeps the client batch id of items already sent once, apart from new items', () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1'), queued('f1')]);
    const [first] = store.prepareBatches(ACCOUNT);
    store.enqueue([queued('f1')]);
    const again = store.prepareBatches(ACCOUNT);
    expect(again).toHaveLength(2);
    expect(again[0]?.batchId).toBe(first?.batchId);
    expect(again[0]?.items).toHaveLength(2);
    expect(again[1]?.batchId).not.toBe(first?.batchId);
  });
});

describe('one queue shared by the tabs of a browser profile (§4.15)', () => {
  it('§4.15: observations queued in two tabs both survive a reload', () => {
    const storage = sharedStorage();
    const tabA = new OfflineQueueStore(storage, keys('a'));
    const tabB = new OfflineQueueStore(storage, keys('b'));
    tabA.enqueue([queued('f1'), queued('f1')]);
    tabB.enqueue([queued('f2')]);
    const reloaded = new OfflineQueueStore(storage, keys('c'));
    expect(reloaded.getState().pending).toHaveLength(3);
    // One device: every tab keeps the device id the first one stored.
    expect(reloaded.getState().deviceId).toBe(tabA.getState().deviceId);
    expect(tabB.getState().deviceId).toBe(tabA.getState().deviceId);
  });

  it('§4.15: a synchronisation in one tab removes only what it sent, never what another tab queued meanwhile', async () => {
    const storage = sharedStorage();
    const tabA = new OfflineQueueStore(storage, keys('a'));
    const tabB = new OfflineQueueStore(storage, keys('b'));
    tabA.enqueue([queued('f1')]);
    const runner = new OfflineSyncRunner(tabA);
    await runner.run(
      ACCOUNT,
      (batch) => {
        // Tab B queues while tab A's upload is in flight.
        tabB.enqueue([queued('f1')]);
        return Promise.resolve(accepted(batch));
      },
      NOW,
    );
    const reloaded = new OfflineQueueStore(storage, keys('c'));
    expect(reloaded.getState().pending).toHaveLength(1);
    expect(reloaded.getState().pending[0]?.batchId).toBeNull();
  });

  it("follows another tab's writes through the storage event", () => {
    const storage = sharedStorage();
    const tabA = new OfflineQueueStore(storage, keys('a'));
    const tabB = new OfflineQueueStore(storage, keys('b'));
    let listener: ((event: { key: string | null }) => void) | null = null;
    const events: StorageEvents = {
      addEventListener: (_type, fn) => void (listener = fn),
      removeEventListener: () => void (listener = null),
    };
    const stop = tabA.watch(events);
    let notified = 0;
    tabA.subscribe(() => (notified += 1));
    tabB.enqueue([queued('f1')]);
    expect(tabA.getState().pending).toHaveLength(0);
    listener!({ key: OFFLINE_QUEUE_STORAGE_KEY });
    expect(tabA.getState().pending).toHaveLength(1);
    expect(notified).toBe(1);
    stop();
    expect(listener).toBeNull();
  });
});

describe('a batch the API refuses (§4.15 "preserve conflicting observations for review")', () => {
  it('§4.15: a refused batch goes to review with the API code and the other batches are still sent', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1'), queued('f1'), queued('f2')]);
    const sent: string[] = [];
    const runner = new OfflineSyncRunner(store);
    const send = (batch: PendingBatch) => {
      sent.push(batch.facilityId);
      if (batch.facilityId === 'f1') {
        return Promise.reject(refusal('VALIDATION_FAILED', 400, { code: 'snapshot_in_future' }));
      }
      return Promise.resolve(accepted(batch));
    };
    const summary = await runner.run(ACCOUNT, send, NOW);
    expect(sent).toEqual(['f1', 'f2']);
    const state = store.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.review).toHaveLength(2);
    expect(state.review[0]).toMatchObject({
      outcome: 'refused',
      code: 'VALIDATION_FAILED (snapshot_in_future)',
      reason: 'Safe message for VALIDATION_FAILED.',
      flags: ['snapshot_in_future'],
    });
    expect(summary).toMatchObject({ synchronised: 1, refused: 2 });
    expect(runner.getRuntime().error).toBeNull();

    // The next run is not stuck on the refused batch.
    sent.length = 0;
    await runner.run(ACCOUNT, send, NOW);
    expect(sent).toEqual([]);

    // Queued again: a new batch (new client batch id, so a new key), sent on the next run.
    const refusedBatch = state.review[0]!.batchId;
    store.requeue(state.review[0]!.queued.item.clientObservationId);
    const [again] = store.prepareBatches(ACCOUNT);
    expect(again?.items).toHaveLength(1);
    expect(again?.batchId).not.toBe(refusedBatch);
    expect(store.getState().review).toHaveLength(1);
  });

  it('ACCESS_DENIED after a role ended is kept for review too; discarding it removes it from the device', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1')]);
    const runner = new OfflineSyncRunner(store);
    await runner.run(
      ACCOUNT,
      () => Promise.reject(refusal('ACCESS_DENIED', 403, { action: 'entry.offline_sync' })),
      NOW,
    );
    const [kept] = store.getState().review;
    expect(kept).toMatchObject({ outcome: 'refused', code: 'ACCESS_DENIED' });
    store.dismissReview(kept!.queued.item.clientObservationId);
    expect(store.getState().review).toHaveLength(0);
    expect(store.getState().pending).toHaveLength(0);
  });

  it('§4.9: an unknown outcome stops the run and keeps the batch and its client batch id for the retry', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1'), queued('f2')]);
    const sent: string[] = [];
    const runner = new OfflineSyncRunner(store);
    await runner.run(
      ACCOUNT,
      (batch) => {
        sent.push(batch.batchId);
        return Promise.reject(networkError(new TypeError('Failed to fetch')));
      },
      NOW,
    );
    expect(sent).toHaveLength(1);
    const state = store.getState();
    expect(state.review).toHaveLength(0);
    expect(state.pending).toHaveLength(2);
    expect(state.pending[0]?.batchId).toBe(sent[0]);
    expect(runner.getRuntime().error).toBeInstanceOf(ApiError);
  });

  it('a signed-out session keeps the items queued for sign-in, not for review', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1')]);
    const runner = new OfflineSyncRunner(store);
    await runner.run(ACCOUNT, () => Promise.reject(refusal('AUTHENTICATION_REQUIRED', 401)), NOW);
    expect(store.getState().pending).toHaveLength(1);
    expect(store.getState().review).toHaveLength(0);
  });
});

describe('a batch whose answer was lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE, §4.9)', () => {
  const outcomeLost = () =>
    new ApiError({
      kind: 'api',
      status: 409,
      code: 'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
      message: 'An earlier attempt with this key changed data; its response was not recorded.',
      nextAction: 'reload_current_state',
      correlationId: 'corr-lost',
    });

  it('SPK-AT-018: the batch is sent again under a new key with the same client batch id, its stored outcome is applied and later batches still go', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1'), queued('f1'), queued('f2')]);
    // The fake API: the f1 batch committed under its first key, whose answer was never recorded;
    // the batch is stored by device and client batch id, so a new key gets the stored batch.
    const lostKeys = new Set<string>();
    const stored = new Map<string, Schema<'OfflineSyncBatch'>>();
    const posts: { clientBatchId: string; key: string }[] = [];
    let n = 0;
    const newIntent = (): CommandIntent =>
      createCommandIntent(() => `intent-${String(++n).padStart(4, '0')}`);
    const post = (batch: PendingBatch, _deviceId: string, intent: CommandIntent) => {
      posts.push({ clientBatchId: batch.batchId, key: intent.key });
      if (lostKeys.has(intent.key)) return Promise.reject(outcomeLost());
      const known = stored.get(batch.batchId);
      if (known) return Promise.resolve(known);
      const result = accepted(batch);
      stored.set(batch.batchId, result);
      if (batch.facilityId === 'f1' && lostKeys.size === 0) {
        lostKeys.add(intent.key);
        return Promise.reject(outcomeLost());
      }
      return Promise.resolve(result);
    };
    const runner = new OfflineSyncRunner(store);
    const summary = await runner.run(ACCOUNT, batchSender(post, newIntent), NOW);

    const f1 = posts.filter((p) => p.clientBatchId === posts[0]?.clientBatchId);
    expect(f1).toHaveLength(2);
    expect(f1[1]?.key).not.toBe(f1[0]?.key);
    // Every item left the queue; nothing is kept for review and nothing stops the run.
    expect(store.getState().pending).toHaveLength(0);
    expect(store.getState().review).toHaveLength(0);
    expect(posts.map((p) => p.clientBatchId)).toHaveLength(3);
    expect(summary).toMatchObject({ synchronised: 3 });
    expect(runner.getRuntime().error).toBeNull();
  });

  it('§4.9: if the second send gets no answer, the run stops and the next run reuses the new key, never the lost one', async () => {
    const store = new OfflineQueueStore(null, keys());
    store.enqueue([queued('f1')]);
    const keysSent: string[] = [];
    let n = 0;
    const newIntent = () => createCommandIntent(() => `intent-${String(++n).padStart(4, '0')}`);
    let calls = 0;
    const post = (batch: PendingBatch, _deviceId: string, intent: CommandIntent) => {
      keysSent.push(intent.key);
      calls += 1;
      if (calls === 1) return Promise.reject(outcomeLost());
      if (calls === 2) return Promise.reject(networkError(new TypeError('Failed to fetch')));
      return Promise.resolve(accepted(batch));
    };
    const runner = new OfflineSyncRunner(store);
    const send = batchSender(post, newIntent);
    await runner.run(ACCOUNT, send, NOW);
    expect(store.getState().pending).toHaveLength(1);
    expect(runner.getRuntime().error).toBeInstanceOf(ApiError);
    await runner.run(ACCOUNT, send, NOW);
    expect(keysSent).toEqual(['intent-0001', 'intent-0002', 'intent-0002']);
    expect(store.getState().pending).toHaveLength(0);
  });
});

describe('the service clock of a roster (§4.15)', () => {
  const receipt = new Date('2026-10-24T11:50:00.000Z');

  it('dates the snapshot and later observations on the service clock, whichever way the device is off', () => {
    // Device 10 minutes slow: the service answered at 12:00 when the device read 11:50.
    const slow = serviceClockOf(new Date('2026-10-24T12:00:00.000Z'), receipt);
    expect(slow.offsetMs).toBe(10 * 60_000);
    expect(slow.at(receipt)).toBe('2026-10-24T12:00:00.000Z');
    expect(slow.at(new Date('2026-10-24T11:52:00.000Z'))).toBe('2026-10-24T12:02:00.000Z');
    // Device 10 minutes fast.
    const fast = serviceClockOf('2026-10-24T11:40:00.000Z', receipt);
    expect(fast.at(new Date('2026-10-24T11:52:00.000Z'))).toBe('2026-10-24T11:42:00.000Z');
  });

  it('without a readable service time both stay on the device clock', () => {
    for (const unknown of [null, undefined, 'not a date']) {
      const clock = serviceClockOf(unknown, receipt);
      expect(clock.offsetMs).toBe(0);
      expect(clock.at(receipt)).toBe(receipt.toISOString());
    }
  });
});
