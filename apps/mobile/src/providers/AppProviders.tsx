/**
 * Root providers: session (§4.13), the typed API client (§4.8 to §4.10), connectivity and
 * foreground refresh (SPK-UX-001, SCR-C-40), and the TanStack Query data layer.
 */
import {
  ApiError,
  PERMISSIONS_QUERY_PREFIX,
  createApiClient,
  type ApiClient,
  type Session,
  type UpdateRequiredError,
} from '@sportspark/api-client';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Reachability } from '../connectivity/sources';
import type { AppServices } from './services';

export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

export interface SessionState {
  status: SessionStatus;
  session: Session | null;
  /** The API rejected the stored session (expired or revoked); the user must sign in again. */
  expired: boolean;
}

export interface AppContextValue {
  services: AppServices;
  api: ApiClient;
  session: SessionState;
  signIn(session: Session): Promise<void>;
  signOut(): Promise<void>;
  /** Set when the API says this build is below the minimum supported version (SCR-C-39). */
  updateRequired: UpdateRequiredError | null;
}

export interface ConnectivityState {
  /** `null` until the first reading; never shown as offline. */
  reachable: Reachability;
}

const AppContext = createContext<AppContextValue | null>(null);
const ConnectivityContext = createContext<ConnectivityState>({ reachable: null });

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry only what the error contract says is retryable; never retry a denial or a 404.
        retry: (failureCount, error) =>
          error instanceof ApiError && error.retryable && failureCount < 2,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

export interface AppProvidersProps {
  services: AppServices;
  queryClient?: QueryClient;
  children: ReactNode;
}

export function AppProviders({ services, queryClient, children }: AppProvidersProps) {
  const client = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  const [session, setSession] = useState<SessionState>({
    status: 'loading',
    session: null,
    expired: false,
  });
  const [updateRequired, setUpdateRequired] = useState<UpdateRequiredError | null>(null);
  const [reachable, setReachable] = useState<Reachability>(null);

  useEffect(() => {
    let active = true;
    services.sessionStore
      .load()
      .then((loaded) => {
        if (!active) return;
        setSession({
          status: loaded ? 'signed_in' : 'signed_out',
          session: loaded,
          expired: false,
        });
      })
      .catch(() => {
        if (active) setSession({ status: 'signed_out', session: null, expired: false });
      });
    return () => {
      active = false;
    };
  }, [services.sessionStore]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: services.config.apiBaseUrl,
        session: services.sessionStore,
        clientInfo: {
          app: 'mobile',
          platform: services.config.platform,
          version: services.config.appVersion,
        },
        fetch: services.fetch,
        generateKey: services.generateKey,
        now: services.now,
        onUpdateRequired: (error) => setUpdateRequired(error),
        onAuthenticationRequired: () => {
          // Session expiry and recovery (§4.13): drop the secret, keep nothing cached for the user.
          void services.sessionStore.clear().finally(() => {
            client.clear();
            setSession({ status: 'signed_out', session: null, expired: true });
          });
        },
        // A command refused because its capability is turned off (K-12): re-read the switches so
        // every CapabilityGate shows them as they are now (DEC-016).
        onCapabilityDisabled: () => {
          void client.invalidateQueries({ queryKey: PERMISSIONS_QUERY_PREFIX });
        },
      }),
    [services, client],
  );

  // Connectivity drives the banner and pauses queries while offline (TanStack onlineManager); a
  // query paused offline resumes on reconnect and keeps showing its last data meanwhile.
  useEffect(() => {
    let active = true;
    const apply = (r: Reachability) => {
      if (!active) return;
      setReachable(r);
      onlineManager.setOnline(r !== false);
    };
    void services.connectivity.current().then(apply);
    const unsubscribe = services.connectivity.subscribe(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [services.connectivity]);

  // Foreground refresh (SPK-UX-001): coming back to the app refetches what is on screen, which is
  // how an interrupted registration or payment is found and shown in its current state.
  useEffect(() => {
    focusManager.setEventListener((handleFocus) => services.appState.subscribe(handleFocus));
  }, [services.appState]);

  const signIn = useCallback(
    async (next: Session) => {
      await services.sessionStore.save(next);
      client.clear();
      setSession({ status: 'signed_in', session: next, expired: false });
    },
    [services.sessionStore, client],
  );

  const signOut = useCallback(async () => {
    await services.sessionStore.clear();
    client.clear();
    setSession({ status: 'signed_out', session: null, expired: false });
  }, [services.sessionStore, client]);

  const value = useMemo<AppContextValue>(
    () => ({ services, api, session, signIn, signOut, updateRequired }),
    [services, api, session, signIn, signOut, updateRequired],
  );

  return (
    <QueryClientProvider client={client}>
      <AppContext.Provider value={value}>
        <ConnectivityContext.Provider value={{ reachable }}>
          {children}
        </ConnectivityContext.Provider>
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProviders>');
  return value;
}

export function useApi(): ApiClient {
  return useApp().api;
}

export function useConnectivity(): ConnectivityState {
  return useContext(ConnectivityContext);
}

/**
 * The injected clock, read on every render and re-read every `refreshMs`, so "updated <time>"
 * stays current on screen and is deterministic in tests.
 */
export function useNow(refreshMs = 30_000): Date {
  const { services } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return services.now();
}
