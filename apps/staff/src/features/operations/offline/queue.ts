/**
 * Offline queue of arrival and attendance observations on a staff device (§4.15, SPK-AT-018,
 * SCR-S-31, SCR-W-10).
 *
 * - Each queued item carries the §4.15 fields: a unique client observation id, the actor (the
 *   account that queued it), the event, the observed time and the roster snapshot reference; the
 *   API stamps the received time.
 * - Only identifiers, states and times are stored, never names or other personal details, so the
 *   device keeps no readable roster at rest. Encrypted roster storage and device approval are not
 *   implemented by the API (entry module "Known gaps"; DEC-032 pending), so the screens say so.
 * - Synchronisation happens once: items are assigned to a batch with a client batch id before the
 *   upload, and that id is kept until the API answers, so a retry after a lost response is
 *   recognised by the API (device + client batch id) and never applied twice.
 * - Items another account queued on this device stay queued until that account signs in, so the
 *   recorded actor is always the person who observed (§4.15 "actor").
 * - Conflicting and rejected items are kept for review with the API's reason (SPK-AT-018). A batch
 *   the API refuses outright (a definitive 4xx: nothing in it was recorded) moves all its items to
 *   review as `refused` with the API's code and message, where they can be queued again under a
 *   new batch or discarded; the run goes on with the other batches. Only an unknown outcome (no
 *   answer, a 5xx, the same key still running) stops the run and keeps the batch and its key.
 * - The server's batch id and counts of the latest synchronisations are kept (ids and numbers
 *   only), so the stored per-item outcome can be read again with `GET /v1/offline-sync/{id}`
 *   (ENT-01) after the response was shown.
 * - Several dashboard tabs share one queue in this browser profile: every change is applied to the
 *   queue as last stored (read again before each write), so a tab never writes back a stale copy
 *   over observations another tab queued, and a `storage` event from another tab refreshes this
 *   tab's view. Where the browser has Web Locks, one tab at a time synchronises.
 */
import { ApiError, keepsIntentAfterFailure, type Schema } from '@sportspark/api-client';

export type OfflineItem = Schema<'OfflineItem'>;
export type OfflineSyncBatch = Schema<'OfflineSyncBatch'>;
export type OfflineItemResult = Schema<'OfflineItemResult'>;

export interface RosterSnapshot {
  reference: string;
  takenAt: string;
}

export interface QueuedItem {
  item: OfflineItem;
  facilityId: string;
  snapshot: RosterSnapshot;
  /** The account that observed and queued it (the §4.15 actor). */
  queuedBy: string;
  queuedAt: string;
  /** Non-personal context for the review list, e.g. the activity title. */
  context: string | null;
  /** Set when a synchronisation attempt included the item; reused on every retry. */
  batchId: string | null;
}

export interface ReviewItem {
  queued: QueuedItem;
  /**
   * `accepted_with_conflict` and `rejected` are the API's per-item outcomes; `refused` means the
   * API refused the whole batch before recording anything (`code` and `reason` say why).
   */
  outcome: 'accepted_with_conflict' | 'rejected' | 'refused';
  reason: string | null;
  flags: string[];
  /** The client batch id the item was sent in. */
  batchId: string;
  /** The API's id of the stored batch (`GET /v1/offline-sync/{id}`); absent in older queues. */
  serverBatchId?: string;
  /** For `refused`: the API's error code and `details.code`, e.g. `VALIDATION_FAILED (snapshot_in_future)`. */
  code?: string;
  reviewedAt: string;
}

/** The API's own limit on items per offline batch. */
export const MAX_BATCH_ITEMS = 500;

/** A batch the API answered, by its ids and counts only (no personal data). */
export interface SyncedBatch {
  id: string;
  clientBatchId: string;
  facilityId: string;
  receivedAt: string;
  items: number;
  accepted: number;
  conflicts: number;
  rejected: number;
  duplicates: number;
  stale: number;
}

/** How many synchronised batches this device remembers. */
export const SYNCED_BATCHES_KEPT = 20;

export interface SyncSummary {
  at: string;
  synchronised: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  stale: number;
  /** Items of batches the API refused outright (kept for review); absent in older queues. */
  refused?: number;
  /** The maximum roster age the API applied (minutes), from its policy. */
  maxRosterAgeMinutes: number | null;
}

export interface OfflineQueueState {
  deviceId: string;
  pending: QueuedItem[];
  review: ReviewItem[];
  lastSync: SyncSummary | null;
  /** Newest first, at most SYNCED_BATCHES_KEPT. */
  synced?: SyncedBatch[];
}

export interface PendingBatch {
  batchId: string;
  facilityId: string;
  snapshot: RosterSnapshot;
  items: QueuedItem[];
}

/** The part of `Storage` the queue uses; `null` keeps the queue in memory only. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where another tab's writes are announced (the window's `storage` event). */
export interface StorageEvents {
  addEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
  removeEventListener(type: 'storage', listener: (event: { key: string | null }) => void): void;
}

export const OFFLINE_QUEUE_STORAGE_KEY = 'sportspark.staff.offline-queue.v1';

function isState(value: unknown): value is OfflineQueueState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<OfflineQueueState>;
  return typeof v.deviceId === 'string' && Array.isArray(v.pending) && Array.isArray(v.review);
}

export class OfflineQueueStore {
  private state: OfflineQueueState;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly generateKey: () => string,
  ) {
    this.state = this.load() ?? {
      deviceId: `staff-web-${generateKey()}`,
      pending: [],
      review: [],
      lastSync: null,
    };
    this.persist();
  }

  private load(): OfflineQueueState | null {
    try {
      const raw = this.storage?.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Storage full or blocked: the queue stays in memory for this tab.
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Applies one change to the queue as last stored, not to this tab's copy: another tab sharing
   * the storage may have queued, synchronised or dismissed items since this tab last read it
   * (R2-CLIENTS-2-04). The change and the write happen in one synchronous step.
   */
  private mutate(change: (current: OfflineQueueState) => OfflineQueueState): OfflineQueueState {
    const stored = this.load();
    const current = stored ?? this.state;
    this.state = change(current);
    this.persist();
    this.notify();
    return this.state;
  }

  /** Reads the stored queue again (another tab wrote it) and tells the screens. */
  refresh = (): void => {
    const stored = this.load();
    if (!stored) return;
    this.state = stored;
    this.notify();
  };

  /** Follows another tab's writes of the shared queue; returns the way to stop. */
  watch(events: StorageEvents): () => void {
    const onStorage = (event: { key: string | null }) => {
      if (event.key === null || event.key === OFFLINE_QUEUE_STORAGE_KEY) this.refresh();
    };
    events.addEventListener('storage', onStorage);
    return () => events.removeEventListener('storage', onStorage);
  }

  getState = (): OfflineQueueState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A fresh client observation id (a UUID from the secure key source). */
  newObservationId(): string {
    return this.generateKey();
  }

  enqueue(items: readonly QueuedItem[]): void {
    if (items.length === 0) return;
    this.mutate((current) => {
      const known = new Set(current.pending.map((q) => q.item.clientObservationId));
      const added = items.filter((q) => !known.has(q.item.clientObservationId));
      return { ...current, pending: [...current.pending, ...added] };
    });
  }

  /**
   * Groups this account's pending items into batches (one facility and snapshot each, at most
   * MAX_BATCH_ITEMS, the API's limit), keeping the batch id of items already sent once. Every
   * prepared batch is returned, a full one included (R2-CLIENTS-2-11).
   */
  prepareBatches(accountId: string): PendingBatch[] {
    const batches: PendingBatch[] = [];
    this.mutate((current) => {
      /** Batches already sent once, by their client batch id (kept across retries). */
      const sent = new Map<string, PendingBatch>();
      /** The batch new items of one facility and snapshot are still added to. */
      const open = new Map<string, PendingBatch>();
      const pending = current.pending.map((q) => {
        if (q.queuedBy !== accountId) return q;
        let batch: PendingBatch | undefined;
        if (q.batchId !== null) {
          batch = sent.get(q.batchId);
          if (!batch) {
            batch = {
              batchId: q.batchId,
              facilityId: q.facilityId,
              snapshot: q.snapshot,
              items: [],
            };
            sent.set(q.batchId, batch);
            batches.push(batch);
          }
        } else {
          const key = `${q.facilityId}|${q.snapshot.reference}`;
          batch = open.get(key);
          if (!batch || batch.items.length >= MAX_BATCH_ITEMS) {
            batch = {
              batchId: this.generateKey(),
              facilityId: q.facilityId,
              snapshot: q.snapshot,
              items: [],
            };
            open.set(key, batch);
            batches.push(batch);
          }
        }
        const assigned = { ...q, batchId: batch.batchId };
        batch.items.push(assigned);
        return assigned;
      });
      return { ...current, pending };
    });
    return batches;
  }

  /** Applies the API's per-item outcomes: synchronised items leave the queue, others go to review. */
  applyResult(batch: PendingBatch, result: OfflineSyncBatch, now: Date): void {
    const outcomes = new Map(result.items.map((r) => [r.clientObservationId, r]));
    const review: ReviewItem[] = [];
    for (const queued of batch.items) {
      const r = outcomes.get(queued.item.clientObservationId);
      if (r && (r.outcome === 'accepted_with_conflict' || r.outcome === 'rejected')) {
        review.push({
          queued,
          outcome: r.outcome,
          reason: r.reason,
          flags: r.flags,
          batchId: batch.batchId,
          serverBatchId: result.id,
          reviewedAt: now.toISOString(),
        });
      }
    }
    const sent = new Set(batch.items.map((q) => q.item.clientObservationId));
    const synced: SyncedBatch = {
      id: result.id,
      clientBatchId: result.clientBatchId,
      facilityId: result.facilityId,
      receivedAt: result.receivedAt,
      items: result.counts.items,
      accepted: result.counts.accepted,
      conflicts: result.counts.acceptedWithConflict,
      rejected: result.counts.rejected,
      duplicates: result.counts.duplicate,
      stale: result.counts.stale,
    };
    this.mutate((current) => ({
      ...current,
      pending: current.pending.filter((q) => !sent.has(q.item.clientObservationId)),
      review: [...withoutIds(current.review, sent), ...review],
      synced: [synced, ...(current.synced ?? []).filter((b) => b.id !== result.id)].slice(
        0,
        SYNCED_BATCHES_KEPT,
      ),
    }));
  }

  /**
   * The API refused the whole batch (R2-CLIENTS-2-03): nothing in it was recorded, and the same
   * key would only get the same refusal again. Its items leave the pending queue for review with
   * the API's code and message, so the next run is not blocked by them.
   */
  refuseBatch(batch: PendingBatch, error: ApiError, now: Date): void {
    const detail = detailCodeOf(error.details);
    const code = detail ? `${error.code} (${detail})` : error.code;
    const ids = new Set(batch.items.map((q) => q.item.clientObservationId));
    const review: ReviewItem[] = batch.items.map((queued) => ({
      queued,
      outcome: 'refused',
      reason: error.message,
      flags: detail ? [detail] : [],
      batchId: batch.batchId,
      code,
      reviewedAt: now.toISOString(),
    }));
    this.mutate((current) => ({
      ...current,
      pending: current.pending.filter((q) => !ids.has(q.item.clientObservationId)),
      review: [...withoutIds(current.review, ids), ...review],
    }));
  }

  /**
   * Puts a refused item back in the queue under a new batch (a new client batch id and key), for
   * example once the device clock is right or the role is back. Items the API recorded (a
   * conflict, a rejection) are not queued again.
   */
  requeue(clientObservationId: string): void {
    this.mutate((current) => {
      const kept = current.review.find(
        (r) => r.outcome === 'refused' && r.queued.item.clientObservationId === clientObservationId,
      );
      if (!kept) return current;
      return {
        ...current,
        pending: [
          ...current.pending.filter((q) => q.item.clientObservationId !== clientObservationId),
          { ...kept.queued, batchId: null },
        ],
        review: current.review.filter((r) => r !== kept),
      };
    });
  }

  /** Records the summary of one synchronisation run (all its batches). */
  recordSync(summary: SyncSummary): void {
    this.mutate((current) => ({ ...current, lastSync: summary }));
  }

  /**
   * The reviewer has looked at a kept item; the API keeps the record and its exception. A refused
   * item was never recorded, so dismissing it discards the observation.
   */
  dismissReview(clientObservationId: string): void {
    this.mutate((current) => ({
      ...current,
      review: current.review.filter(
        (r) => r.queued.item.clientObservationId !== clientObservationId,
      ),
    }));
  }
}

function withoutIds(review: readonly ReviewItem[], ids: ReadonlySet<string>): ReviewItem[] {
  return review.filter((r) => !ids.has(r.queued.item.clientObservationId));
}

function detailCodeOf(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The API refused the batch outright: a definitive domain answer (4xx) that it stores and would
 * replay for the same key, so nothing in the batch was recorded and retrying cannot help. Not a
 * signed-out session (the items wait for sign-in), not a turned-off capability (organization-wide,
 * the items wait), not an update-required answer, and never an unknown outcome
 * (`keepsIntentAfterFailure`: no answer, a 5xx, the same key running, a lost stored answer).
 */
export function isBatchRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.kind === 'api' &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    !keepsIntentAfterFailure(error) &&
    !error.isAuthenticationRequired &&
    !error.isCapabilityDisabled
  );
}

/** Sends one batch; resolves with the API's batch outcome or rejects with an ApiError. */
export type SendBatch = (batch: PendingBatch, deviceId: string) => Promise<OfflineSyncBatch>;

export interface SyncRuntime {
  syncing: boolean;
  error: unknown;
}

/** Runs `task` while holding the device's synchronisation lock (Web Locks), where available. */
export type SyncLock = <T>(task: () => Promise<T>) => Promise<T>;

/** One tab of this browser profile synchronises at a time (navigator.locks), where supported. */
export const browserSyncLock: SyncLock = (task) => {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks || typeof locks.request !== 'function') return task();
  return locks.request('sportspark.staff.offline-sync', () => task()) as Promise<
    Awaited<ReturnType<typeof task>>
  >;
};

/**
 * Runs one synchronisation of this account's pending items (SPK-AT-018 "synchronize once"): one
 * run at a time per device queue (and per browser profile where Web Locks exist); every batch
 * keeps its client batch id across retries. A batch the API refuses outright goes to review and
 * the run goes on (`isBatchRefusal`); any other failure stops the run and keeps the remaining
 * items queued.
 */
export class OfflineSyncRunner {
  private runtime: SyncRuntime = { syncing: false, error: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: OfflineQueueStore,
    private readonly lock: SyncLock = (task) => task(),
  ) {}

  getRuntime = (): SyncRuntime => this.runtime;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: SyncRuntime): void {
    this.runtime = next;
    for (const listener of this.listeners) listener();
  }

  async run(accountId: string, send: SendBatch, now: () => Date): Promise<SyncSummary | null> {
    if (this.runtime.syncing) return null;
    this.set({ syncing: true, error: null });
    try {
      return await this.lock(() => this.runLocked(accountId, send, now));
    } catch (cause) {
      this.set({ syncing: false, error: cause });
      return null;
    }
  }

  private async runLocked(
    accountId: string,
    send: SendBatch,
    now: () => Date,
  ): Promise<SyncSummary | null> {
    // Prepared under the lock, from the queue as last stored: another tab may just have sent it.
    const batches = this.store.prepareBatches(accountId);
    const at = now().toISOString();
    const summary: SyncSummary = {
      at,
      synchronised: 0,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
      stale: 0,
      refused: 0,
      maxRosterAgeMinutes: null,
    };
    let error: unknown = null;
    let answered = 0;
    for (const batch of batches) {
      try {
        const result = await send(batch, this.store.getState().deviceId);
        this.store.applyResult(batch, result, now());
        answered += 1;
        summary.synchronised += result.counts.accepted;
        summary.duplicates += result.counts.duplicate;
        summary.conflicts += result.counts.acceptedWithConflict;
        summary.rejected += result.counts.rejected;
        summary.stale += result.counts.stale;
        summary.maxRosterAgeMinutes = result.maxRosterAgeMinutes;
      } catch (cause) {
        if (isBatchRefusal(cause)) {
          // Nothing of it was recorded: kept for review, and the other batches still go.
          this.store.refuseBatch(batch, cause, now());
          answered += 1;
          summary.refused = (summary.refused ?? 0) + batch.items.length;
          continue;
        }
        error = cause;
        break;
      }
    }
    if (answered > 0) this.store.recordSync(summary);
    this.set({ syncing: false, error });
    return answered > 0 ? summary : null;
  }
}

export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${OFFLINE_QUEUE_STORAGE_KEY}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
