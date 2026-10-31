/**
 * Keeps what the user is reading steady while a background refresh brings newer data (SCR-S-03
 * "stale version: published revision changed: refresh banner"). The first data for a key is shown;
 * a later response with the same `signature` (for events: id, revision, status, published revision)
 * replaces it silently, so the age shown stays true; a response that differs sets `changed` and the
 * screen offers to show the latest. A new key (another range or facility) always shows fresh data.
 * `pin` adopts a value the user asked for explicitly (a Refresh). `extend` announces that the user
 * asked for more of the same list (Load more): the next data is adopted silently when it only
 * appends to what is shown (its signature starts with the shown one), and is a change otherwise.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** `next` keeps every shown entry, in order, and adds more after them. */
function appends(shown: string, next: string): boolean {
  return shown !== '' && next.length > shown.length && next.startsWith(`${shown}|`);
}

export function usePinnedData<T>(
  data: T | undefined,
  updatedAt: Date | null,
  key: string,
  signature: (value: T) => string,
) {
  const [pinned, setPinned] = useState<{ key: string; data: T; at: Date | null } | null>(null);
  const extending = useRef(false);
  const current = pinned !== null && pinned.key === key ? pinned : null;

  useEffect(() => {
    if (data === undefined) return;
    if (pinned === null || pinned.key !== key) {
      setPinned({ key, data, at: updatedAt });
      return;
    }
    if (pinned.data === data) return;
    const shown = signature(pinned.data);
    const next = signature(data);
    if (shown === next) {
      setPinned({ key, data, at: updatedAt });
    } else if (extending.current) {
      extending.current = false;
      if (appends(shown, next)) setPinned({ key, data, at: updatedAt });
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
  const extend = useCallback(() => {
    extending.current = true;
  }, []);

  return {
    data: current ? current.data : data,
    updatedAt: current ? current.at : updatedAt,
    changed,
    showLatest,
    pin,
    extend,
  };
}
