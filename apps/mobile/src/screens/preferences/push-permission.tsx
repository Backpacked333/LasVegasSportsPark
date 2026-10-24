/**
 * SCR-C-36 push permission on this device (SPK-UX-001 "Push notification registration and
 * preferences", §4.13 "Native permission explanations", DEC-061, DEC-020).
 *
 * This build contains no push module: the messaging provider is DEC-020, push setup and the
 * permission explanation are DEC-061, and the API has no endpoint to register a device. The
 * reader is therefore "unavailable" by default; a build that adds push supplies a reader through
 * `PushPermissionProvider`, and tests supply "denied" or "granted".
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export interface PushPermissionReader {
  status(): Promise<PushPermissionStatus>;
}

export const unavailablePushPermission: PushPermissionReader = {
  status: async () => 'unavailable',
};

const PushPermissionContext = createContext<PushPermissionReader>(unavailablePushPermission);

export function PushPermissionProvider({
  reader,
  children,
}: {
  reader: PushPermissionReader;
  children: ReactNode;
}) {
  return <PushPermissionContext.Provider value={reader}>{children}</PushPermissionContext.Provider>;
}

/** `null` until read; re-read whenever the screen mounts (returning from device settings). */
export function usePushPermissionStatus(): PushPermissionStatus | null {
  const reader = useContext(PushPermissionContext);
  const [status, setStatus] = useState<PushPermissionStatus | null>(null);
  useEffect(() => {
    let active = true;
    reader
      .status()
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {
        if (active) setStatus('unavailable');
      });
    return () => {
      active = false;
    };
  }, [reader]);
  return status;
}
