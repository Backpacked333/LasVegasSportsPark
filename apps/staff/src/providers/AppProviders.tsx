/**
 * Root providers for the staff dashboard: session (§4.13), the typed API client (§4.8 to §4.10),
 * connectivity (SPK-UX-008 offline state), the TanStack Query data layer, and the selected
 * facility. The client never decides authorization: the facility choices are the principal's
 * scope as `GET /v1/me` returns it, and every screen renders what the API answers.
 */
import {
  ApiError,
  PERMISSIONS_QUERY_PREFIX,
  createApiClient,
  type ApiClient,
  type Session,
  type UpdateRequiredError,
} from '@sportspark/api-client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { StaffServices } from './services';

export type SessionStatus = 'loading' | 'signed_out' | 'signed_in';

export interface SessionState {
  status: SessionStatus;
  session: Session | null;
  /** The API rejected the stored session (expired or revoked). */
  expired: boolean;
}

export interface AppContextValue {
  services: StaffServices;
  api: ApiClient;
  session: SessionState;
  signIn(session: Session): Promise<void>;
  signOut(): Promise<void>;
  updateRequired: UpdateRequiredError | null;
  online: boolean;
  /** The facility the viewer is working in, or null for every facility in their scope. */
  facilityId: string | null;
  setFacilityId(id: string | null): void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          error instanceof ApiError && error.retryable && failureCount < 2,
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({
  services,
  queryClient,
  children,
}: {
  services: StaffServices;
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const client = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  const [session, setSession] = useState<SessionState>({
    status: 'loading',
    session: null,
    expired: false,
  });
  const [updateRequired, setUpdateRequired] = useState<UpdateRequiredError | null>(null);
  const [online, setOnline] = useState(() => services.connectivity.current());
  const [facilityId, setFacilityId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    services.sessionStore
      .load()
      .then((loaded) => {
        if (active) {
          setSession({
            status: loaded ? 'signed_in' : 'signed_out',
            session: loaded,
            expired: false,
          });
        }
      })
      .catch(() => {
        if (active) setSession({ status: 'signed_out', session: null, expired: false });
      });
    return () => {
      active = false;
    };
  }, [services.sessionStore]);

  useEffect(() => {
    const apply = (next: boolean) => {
      setOnline(next);
      onlineManager.setOnline(next);
    };
    apply(services.connectivity.current());
    return services.connectivity.subscribe(apply);
  }, [services.connectivity]);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: services.config.apiBaseUrl,
        session: services.sessionStore,
        clientInfo: { app: 'staff', platform: 'web', version: services.config.appVersion },
        fetch: services.fetch,
        generateKey: services.generateKey,
        now: services.now,
        onUpdateRequired: (error) => setUpdateRequired(error),
        onAuthenticationRequired: () => {
          void services.sessionStore.clear().finally(() => {
            client.clear();
            setSession({ status: 'signed_out', session: null, expired: true });
          });
        },
        // A command refused because its capability is turned off (K-12): re-read the switches so
        // every CapabilityGate and the navigation show them as they are now (DEC-016).
        onCapabilityDisabled: () => {
          void client.invalidateQueries({ queryKey: PERMISSIONS_QUERY_PREFIX });
        },
      }),
    [services, client],
  );

  const signIn = useCallback(
    async (next: Session) => {
      await services.sessionStore.save(next);
      client.clear();
      setFacilityId(null);
      setSession({ status: 'signed_in', session: next, expired: false });
    },
    [services.sessionStore, client],
  );

  const signOut = useCallback(async () => {
    await services.sessionStore.clear();
    client.clear();
    setFacilityId(null);
    setSession({ status: 'signed_out', session: null, expired: false });
  }, [services.sessionStore, client]);

  const value = useMemo<AppContextValue>(
    () => ({
      services,
      api,
      session,
      signIn,
      signOut,
      updateRequired,
      online,
      facilityId,
      setFacilityId,
    }),
    [services, api, session, signIn, signOut, updateRequired, online, facilityId],
  );

  return (
    <QueryClientProvider client={client}>
      <AppContext.Provider value={value}>{children}</AppContext.Provider>
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

/** The injected clock, read on every render and re-read every `refreshMs`. */
export function useNow(refreshMs = 30_000): Date {
  const { services } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);
  return services.now();
}
