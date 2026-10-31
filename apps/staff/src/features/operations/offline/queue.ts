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
 * - Conflicting and rejected items are kept for review with the API's reason (SPK-AT-018).
 * - The server's batch id and counts of the latest synchronisations are kept (ids and numbers
 *   only), so the stored per-item outcome can be read again with `GET /v1/offline-sync/{id}`
 *   (ENT-01) after the response was shown.
 */
import type { Schema } from '@sportspark/api-client';

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
  outcome: 'accepted_with_conflict' | 'rejected';
  reason: string | null;
  flags: string[];
  /** The client batch id the item was sent in. */
  batchId: string;
  /** The API's id of the stored batch (`GET /v1/offline-sync/{id}`); absent in older queues. */
  serverBatchId?: string;
  reviewedAt: string;
}

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

  private update(next: OfflineQueueState): void {
    this.state = next;
    this.persist();
    for (const listener of this.listeners) listener();
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
    this.update({ ...this.state, pending: [...this.state.pending, ...items] });
  }

  /**
   * Groups this account's pending items into batches (one facility and snapshot each, at most 500
   * items, the API's limit), keeping the batch id of items already sent once.
   */
  prepareBatches(accountId: string): PendingBatch[] {
    const byKey = new Map<string, PendingBatch>();
    const pending = this.state.pending.map((q) => {
      if (q.queuedBy !== accountId) return q;
      const key = q.batchId ?? `${q.facilityId}|${q.snapshot.reference}`;
      let batch = byKey.get(key);
      if (!batch || (q.batchId === null && batch.items.length >= 500)) {
        batch = {
          batchId: q.batchId ?? this.generateKey(),
          facilityId: q.facilityId,
          snapshot: q.snapshot,
          items: [],
        };
        byKey.set(key, batch);
      }
      const assigned = { ...q, batchId: batch.batchId };
      batch.items.push(assigned);
      return assigned;
    });
    this.update({ ...this.state, pending });
    return [...byKey.values()];
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
    this.update({
      ...this.state,
      pending: this.state.pending.filter((q) => !sent.has(q.item.clientObservationId)),
      review: [...this.state.review, ...review],
      synced: [synced, ...(this.state.synced ?? []).filter((b) => b.id !== result.id)].slice(
        0,
        SYNCED_BATCHES_KEPT,
      ),
    });
  }

  /** Records the summary of one synchronisation run (all its batches). */
  recordSync(summary: SyncSummary): void {
    this.update({ ...this.state, lastSync: summary });
  }

  /** The reviewer has looked at a kept item; the API keeps the record and its exception. */
  dismissReview(clientObservationId: string): void {
    this.update({
      ...this.state,
      review: this.state.review.filter(
        (r) => r.queued.item.clientObservationId !== clientObservationId,
      ),
    });
  }
}

/** Sends one batch; resolves with the API's batch outcome or rejects with an ApiError. */
export type SendBatch = (batch: PendingBatch, deviceId: string) => Promise<OfflineSyncBatch>;

export interface SyncRuntime {
  syncing: boolean;
  error: unknown;
}

/**
 * Runs one synchronisation of this account's pending items (SPK-AT-018 "synchronize once"): one
 * run at a time per device queue; every batch keeps its client batch id across retries. Stops at
 * the first failure and keeps the remaining items queued.
 */
export class OfflineSyncRunner {
  private runtime: SyncRuntime = { syncing: false, error: null };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: OfflineQueueStore) {}

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
    const batches = this.store.prepareBatches(accountId);
    const at = now().toISOString();
    const summary: SyncSummary = {
      at,
      synchronised: 0,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
      stale: 0,
      maxRosterAgeMinutes: null,
    };
    let error: unknown = null;
    let applied = 0;
    for (const batch of batches) {
      try {
        const result = await send(batch, this.store.getState().deviceId);
        this.store.applyResult(batch, result, now());
        applied += 1;
        summary.synchronised += result.counts.accepted;
        summary.duplicates += result.counts.duplicate;
        summary.conflicts += result.counts.acceptedWithConflict;
        summary.rejected += result.counts.rejected;
        summary.stale += result.counts.stale;
        summary.maxRosterAgeMinutes = result.maxRosterAgeMinutes;
      } catch (cause) {
        error = cause;
        break;
      }
    }
    if (applied > 0) this.store.recordSync(summary);
    this.set({ syncing: false, error });
    return applied > 0 ? summary : null;
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
