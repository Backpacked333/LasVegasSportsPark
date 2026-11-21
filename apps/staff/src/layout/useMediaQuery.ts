/**
 * Whether a media query matches, kept current. False where `matchMedia` is missing (jsdom).
 */
import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    setValue(list.matches);
    const onChange = (event: MediaQueryListEvent) => setValue(event.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return value;
}

/** Desk tablets (601-1279 px): the rail collapses to icons (redesign handoff S 1b, S 2a). */
export const TABLET_QUERY = '(min-width: 601px) and (max-width: 1279px)';
/** Phones: the rail becomes the floating tab bar and a menu drawer (S 1d). */
export const PHONE_QUERY = '(max-width: 600px)';
