/**
 * Browser connectivity behind an interface (SPK-UX-008 offline state, SCR-W-10): `navigator.onLine`
 * and the `online`/`offline` events. Tests drive `createManualConnectivity()`.
 */
export interface ConnectivitySource {
  current(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export const browserConnectivity: ConnectivitySource = {
  current: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  subscribe(listener) {
    const on = () => listener(true);
    const off = () => listener(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  },
};

export function createManualConnectivity(initial = true) {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  return {
    source: {
      current: () => online,
      subscribe(listener: (online: boolean) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } satisfies ConnectivitySource,
    set(next: boolean) {
      online = next;
      for (const l of listeners) l(next);
    },
  };
}
