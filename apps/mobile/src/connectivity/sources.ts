/**
 * Device signals behind interfaces (SCR-C-40, SPK-UX-001 "Clear connectivity and stale-data
 * states", "Foreground refresh after interrupted registration or payment"). The real sources use
 * expo-network and React Native's AppState; tests inject `createManualSources()`.
 */
import * as Network from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

/** `null` means not yet known: never shown as offline. */
export type Reachability = boolean | null;

export interface ConnectivitySource {
  current(): Promise<Reachability>;
  subscribe(listener: (reachable: Reachability) => void): () => void;
}

export interface AppStateSource {
  /** Called with `true` when the app comes to the foreground, `false` when it leaves it. */
  subscribe(listener: (active: boolean) => void): () => void;
}

function reachabilityOf(state: Network.NetworkState): Reachability {
  if (state.isInternetReachable !== undefined) return state.isInternetReachable;
  if (state.isConnected !== undefined) return state.isConnected;
  return null;
}

export const expoNetworkSource: ConnectivitySource = {
  async current() {
    try {
      return reachabilityOf(await Network.getNetworkStateAsync());
    } catch {
      return null;
    }
  },
  subscribe(listener) {
    const subscription = Network.addNetworkStateListener((event) =>
      listener(reachabilityOf(event)),
    );
    return () => subscription.remove();
  },
};

export const reactNativeAppStateSource: AppStateSource = {
  subscribe(listener) {
    let last: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === last) return;
      last = next;
      listener(next === 'active');
    });
    return () => subscription.remove();
  },
};

/** Test double: drive reachability and foreground transitions by hand. */
export function createManualSources(initial: Reachability = true) {
  let reachable = initial;
  const networkListeners = new Set<(r: Reachability) => void>();
  const appListeners = new Set<(active: boolean) => void>();
  return {
    connectivity: {
      current: async () => reachable,
      subscribe(listener: (r: Reachability) => void) {
        networkListeners.add(listener);
        return () => networkListeners.delete(listener);
      },
    } satisfies ConnectivitySource,
    appState: {
      subscribe(listener: (active: boolean) => void) {
        appListeners.add(listener);
        return () => appListeners.delete(listener);
      },
    } satisfies AppStateSource,
    setReachable(next: Reachability) {
      reachable = next;
      for (const l of networkListeners) l(next);
    },
    setForeground(active: boolean) {
      for (const l of appListeners) l(active);
    },
  };
}
