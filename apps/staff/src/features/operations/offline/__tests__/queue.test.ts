/**
 * The device's offline queue (§4.15, SPK-AT-018 "synchronize once", SCR-S-31): every prepared
 * batch is sent in one run (at most 500 items each), tabs sharing the browser storage never write
 * over each other's queued observations, and a batch the API refuses outright is kept for review
 * with its reason instead of being replayed for ever and blocking every later batch.
 */
import { ApiError, networkError, type Schema } from '@sportspark/api-client';
import { describe, expect, it } from 'vitest';
import { syncBatch } from '../../testing';
import {
  MAX_BATCH_ITEMS,
  OFFLINE_QUEUE_STORAGE_KEY,
  OfflineQueueStore,
  OfflineSyncRunner,
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
