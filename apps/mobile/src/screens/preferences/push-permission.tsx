/**
 * SCR-C-36 push permission and token on this device (SPK-UX-001 "Push notification registration
 * and preferences", §4.13 "Native permission explanations", DEC-061, DEC-020).
 *
 * This build contains no push module: the messaging provider is DEC-020, push setup and the
 * permission explanation are DEC-061 (no vendor SDK is added, §5.2). The reader is therefore
 * "unavailable" by default and has no device token, so the app cannot register this install with
 * `POST /v1/me/push-devices`. A build that adds push supplies a reader through
 * `PushPermissionProvider` (its status and this install's platform token); tests supply "denied"
 * or "granted" and a fake token. The token is passed to the API only and never stored or logged.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export interface PushPermissionReader {
  status(): Promise<PushPermissionStatus>;
  /**
   * This install's platform push token, or null when there is none (permission not granted, or no
   * push module in the build). Absent in this build (DEC-061, DEC-020).
   */
  deviceToken?(): Promise<string | null>;
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

/** The reader the build supplies (for the device token). */
export function usePushPermissionReader(): PushPermissionReader {
  return useContext(PushPermissionContext);
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
