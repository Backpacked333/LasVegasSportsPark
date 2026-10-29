/**
 * The one piece of registration progress the device keeps (SPK-UX-001 "Foreground refresh after
 * interrupted registration or payment", SPK-PAY-007, SPK-AT-023; SCR-C-14, SCR-C-15): the quote
 * whose checkout request was sent but whose answer never arrived.
 *
 * Everything else is read from the API, so it survives a reinstall or a second device: the
 * customer's baskets (`GET /v1/me/baskets`), registration checkouts, including one that needs
 * recovery (`GET /v1/me/registration-checkouts`), and waitlist entries with their open offers
 * (`GET /v1/me/waitlist-entries`); see `in-progress.ts`. A sent checkout request may never have
 * reached the API, so no list can show it: re-posting `{quoteId}` with the same idempotency
 * semantics returns the existing checkout for that quote, or creates none twice (§4.9, §4.11).
 *
 * Only that opaque quote id is kept, scoped to the signed-in account, in the platform secure store
 * (expo-secure-store, readable only while unlocked, never restored to another device). A value
 * written by an earlier build (basket, checkout and waitlist ids) is ignored.
 */
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useApp } from '../../providers/AppProviders';

export interface RegistrationProgress {
  /**
   * The quote whose checkout was sent but whose answer has not arrived yet (saved before sending,
   * cleared once the API reports the checkout). After a restart mid-payment it leads back to the
   * checkout screen, which asks again for that quote and never charges twice.
   */
  pendingCheckoutQuoteId: string | null;
}

export const EMPTY_PROGRESS: RegistrationProgress = Object.freeze({
  pendingCheckoutQuoteId: null,
}) as RegistrationProgress;

export const PROGRESS_STORAGE_KEY = 'sportspark.registration-progress';

/** Where the serialized progress lives: the secure store on devices, memory in tests. */
export interface ProgressBackend {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureProgressBackend: ProgressBackend = {
  read: () => SecureStore.getItemAsync(PROGRESS_STORAGE_KEY, SECURE_OPTIONS),
  write: (value) => SecureStore.setItemAsync(PROGRESS_STORAGE_KEY, value, SECURE_OPTIONS),
};

export function memoryProgressBackend(initial: string | null = null): ProgressBackend & {
  value: string | null;
} {
  const backend = {
    value: initial,
    read: async () => backend.value,
    write: async (value: string) => {
      backend.value = value;
    },
  };
  return backend;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Parses the stored value; anything malformed or another account's counts as nothing. */
export function parseProgress(raw: string | null, accountId: string | null): RegistrationProgress {
  if (!raw || !accountId) return EMPTY_PROGRESS;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.accountId !== accountId) return EMPTY_PROGRESS;
    return { pendingCheckoutQuoteId: idOrNull(value.pendingCheckoutQuoteId) };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export type ProgressPatch = Partial<RegistrationProgress>;

/** Holds the progress of the signed-in account and persists every change. */
export class RegistrationProgressStore {
  private accountId: string | null = null;
  private state: RegistrationProgress = EMPTY_PROGRESS;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly backend: ProgressBackend) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.state;
  isLoaded = () => this.loaded;

  /** Loads the progress of `accountId` (a different account never sees another's ids). */
  ensureLoaded(accountId: string | null): Promise<void> {
    if (this.loaded && this.accountId === accountId) return Promise.resolve();
    if (this.loading && this.accountId === accountId) return this.loading;
    this.accountId = accountId;
    this.loaded = false;
    this.loading = this.backend
      .read()
      .catch(() => null)
      .then((raw) => {
        if (this.accountId !== accountId) return;
        this.state = parseProgress(raw, accountId);
        this.loaded = true;
        this.loading = null;
        this.emit();
      });
    return this.loading;
  }

  async update(patch: ProgressPatch): Promise<void> {
    if (this.loading) await this.loading;
    const next = { ...this.state, ...patch };
    if (next.pendingCheckoutQuoteId === this.state.pendingCheckoutQuoteId) return;
    this.state = next;
    this.emit();
    if (!this.accountId) return;
    try {
      await this.backend.write(JSON.stringify({ accountId: this.accountId, ...this.state }));
    } catch {
      // Remembering progress is a convenience; the API keeps the records either way.
    }
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

let deviceStore: RegistrationProgressStore | null = null;
function defaultStore(): RegistrationProgressStore {
  deviceStore ??= new RegistrationProgressStore(secureProgressBackend);
  return deviceStore;
}

const ProgressContext = createContext<RegistrationProgressStore | null>(null);

/** Tests (and any future root wiring) pass their own store; the device store is the default. */
export function RegistrationProgressProvider({
  store,
  children,
}: {
  store: RegistrationProgressStore;
  children: ReactNode;
}) {
  return <ProgressContext.Provider value={store}>{children}</ProgressContext.Provider>;
}

export function useRegistrationProgress() {
  const store = useContext(ProgressContext) ?? defaultStore();
  const { session } = useApp();
  const accountId = session.status === 'signed_in' ? (session.session?.accountId ?? null) : null;
  useEffect(() => {
    if (session.status !== 'loading') void store.ensureLoaded(accountId);
  }, [store, accountId, session.status]);
  const progress = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const update = useCallback((patch: ProgressPatch) => store.update(patch), [store]);
  return useMemo(
    () => ({ progress: accountId ? progress : EMPTY_PROGRESS, update }),
    [progress, update, accountId],
  );
}
