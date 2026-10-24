/**
 * Keeps what the user is reading steady while a background refresh brings newer data (SCR-S-03
 * "stale version: published revision changed: refresh banner"). The first data for a key is shown;
 * a later response with the same `signature` (for events: id, revision, status, published revision)
 * replaces it silently, so the age shown stays true; a response that differs sets `changed` and the
 * screen offers to show the latest. A new key (another range or facility) always shows fresh data.
 * `pin` adopts a value the user asked for explicitly (a Refresh).
 */
import { useCallback, useEffect, useState } from 'react';

export function usePinnedData<T>(
  data: T | undefined,
  updatedAt: Date | null,
  key: string,
  signature: (value: T) => string,
) {
  const [pinned, setPinned] = useState<{ key: string; data: T; at: Date | null } | null>(null);
  const current = pinned !== null && pinned.key === key ? pinned : null;

  useEffect(() => {
    if (data === undefined) return;
    if (pinned === null || pinned.key !== key) {
      setPinned({ key, data, at: updatedAt });
    } else if (pinned.data !== data && signature(pinned.data) === signature(data)) {
      setPinned({ key, data, at: updatedAt });
    }
  }, [data, updatedAt, key, pinned, signature]);

  const changed =
    current !== null && data !== undefined && signature(current.data) !== signature(data);
  const showLatest = useCallback(() => {
    if (data !== undefined) setPinned({ key, data, at: updatedAt });
  }, [data, updatedAt, key]);
  const pin = useCallback(
    (value: T, at: Date | null) => setPinned({ key, data: value, at }),
    [key],
  );

  return {
    data: current ? current.data : data,
    updatedAt: current ? current.at : updatedAt,
    changed,
    showLatest,
    pin,
  };
}
