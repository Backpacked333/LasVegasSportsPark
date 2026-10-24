/**
 * Offline queue context for the arrival, attendance and workspace screens (§4.15, SPK-AT-018,
 * SCR-S-31, SCR-W-10). One queue per device (browser profile), shared by every screen that queues
 * observations; it synchronises once when the connection returns, and on request.
 *
 * Upload: `POST /v1/offline-sync` with the device id, the batch's client id, the facility, the
 * roster snapshot (reference and time) and the items. The idempotency key belongs to the batch
 * intent and is reused when the same batch is retried in this tab; after a reload the API still
 * recognises the batch by device and client batch id and returns its stored outcome.
 */
import { ApiError, type CommandIntent, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useApi, useApp } from '../../../providers/AppProviders';
import type { StaffServices } from '../../../providers/services';
import { useOperatingFacility } from '../context';
import {
  OfflineQueueStore,
  OfflineSyncRunner,
  browserStorage,
  type OfflineQueueState,
  type PendingBatch,
  type QueuedItem,
  type RosterSnapshot,
  type SyncSummary,
} from './queue';

interface Device {
  store: OfflineQueueStore;
  runner: OfflineSyncRunner;
}

const devices = new WeakMap<StaffServices, Device>();

/** One queue per running dashboard (per injected services), persisted in this browser profile. */
export function deviceFor(services: StaffServices): Device {
  let device = devices.get(services);
  if (!device) {
    const store = new OfflineQueueStore(browserStorage(), services.generateKey);
    device = { store, runner: new OfflineSyncRunner(store) };
    devices.set(services, device);
  }
  return device;
}

export interface OfflineQueueValue {
  state: OfflineQueueState;
  /** Items of the signed-in account waiting to be synchronised. */
  mine: QueuedItem[];
  /** Items another account queued on this device (synchronised when that account signs in). */
  others: QueuedItem[];
  syncing: boolean;
  syncError: ApiError | null;
  accountId: string | null;
  enqueue(items: Omit<QueuedItem, 'queuedBy' | 'queuedAt' | 'batchId'>[]): void;
  newObservationId(): string;
  /** A roster snapshot reference for data received at `takenAt`. */
  newSnapshot(takenAt: Date | string): RosterSnapshot;
  sync(): Promise<SyncSummary | null>;
  dismissReview(clientObservationId: string): void;
}

const OfflineQueueContext = createContext<OfflineQueueValue | null>(null);

type SyncBody = Schema<'OfflineSyncRequest'>;

export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const { services, online } = useApp();
  const api = useApi();
  const queryClient = useQueryClient();
  const { accountId } = useOperatingFacility();
  const { store, runner } = deviceFor(services);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const runtime = useSyncExternalStore(runner.subscribe, runner.getRuntime);
  const intents = useRef(new Map<string, CommandIntent>());

  const mine = useMemo(
    () => state.pending.filter((q) => q.queuedBy === accountId),
    [state.pending, accountId],
  );
  const others = useMemo(
    () => state.pending.filter((q) => q.queuedBy !== accountId),
    [state.pending, accountId],
  );

  const sync = useCallback(async () => {
    if (!accountId) return null;
    const send = async (batch: PendingBatch, deviceId: string) => {
      const intent = intents.current.get(batch.batchId) ?? api.newIntent();
      intents.current.set(batch.batchId, intent);
      const body: SyncBody = {
        deviceId,
        clientBatchId: batch.batchId,
        facilityId: batch.facilityId,
        snapshot: batch.snapshot,
        items: batch.items.map((q) => q.item),
      };
      const result = await api.post('/offline-sync', { body, intent });
      intents.current.delete(batch.batchId);
      return result;
    };
    const summary = await runner.run(accountId, send, services.now);
    if (summary) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['api', '/attendance'] }),
        queryClient.invalidateQueries({ queryKey: ['api', '/visits'] }),
      ]);
    }
    return summary;
  }, [accountId, api, runner, services.now, queryClient]);

  // §4.15 / SPK-AT-018: synchronise once when the connection returns.
  const wasOnline = useRef(online);
  useEffect(() => {
    const reconnected = online && !wasOnline.current;
    wasOnline.current = online;
    if (reconnected && mine.length > 0) void sync();
  }, [online, mine.length, sync]);

  const value = useMemo<OfflineQueueValue>(
    () => ({
      state,
      mine,
      others,
      syncing: runtime.syncing,
      syncError: runtime.error instanceof ApiError ? runtime.error : null,
      accountId,
      enqueue: (items) => {
        if (!accountId) return;
        const queuedAt = services.now().toISOString();
        store.enqueue(items.map((i) => ({ ...i, queuedBy: accountId, queuedAt, batchId: null })));
      },
      newObservationId: () => store.newObservationId(),
      newSnapshot: (takenAt) => ({
        reference: `roster-${store.newObservationId()}`,
        takenAt: typeof takenAt === 'string' ? takenAt : takenAt.toISOString(),
      }),
      sync,
      dismissReview: (id) => store.dismissReview(id),
    }),
    [state, mine, others, runtime, accountId, services, store, sync],
  );

  return <OfflineQueueContext.Provider value={value}>{children}</OfflineQueueContext.Provider>;
}

export function useOfflineQueue(): OfflineQueueValue {
  const value = useContext(OfflineQueueContext);
  if (!value) throw new Error('useOfflineQueue must be used inside <OfflineQueueProvider>');
  return value;
}
