/**
 * Keyboard "go to" (redesign handoff, staff shell row 2): G then T, S, R or A opens Today,
 * Schedule, Registrations or Arrival. The second key must follow within 1.5 s. Disabled while
 * typing in a field (and with a modifier held), so it never steals a letter from a form or a
 * browser shortcut. An area the viewer may not use is not offered (`allowed`).
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

export const GO_KEYS: Readonly<Record<string, { path: string; area: string }>> = {
  t: { path: '/today', area: 'today' },
  s: { path: '/schedule', area: 'schedule' },
  r: { path: '/registrations', area: 'registrations' },
  a: { path: '/arrival', area: 'arrival' },
};

export const GO_WINDOW_MS = 1_500;

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function useGoShortcuts(allowed: (area: string) => boolean, enabled = true): void {
  const navigate = useNavigate();
  const armedAt = useRef<number | null>(null);
  const allow = useRef(allowed);
  allow.current = allowed;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) {
        armedAt.current = null;
        return;
      }
      const key = event.key.toLowerCase();
      const armed = armedAt.current !== null && event.timeStamp - armedAt.current <= GO_WINDOW_MS;
      if (armed) {
        armedAt.current = null;
        const target = GO_KEYS[key];
        if (target && allow.current(target.area)) {
          event.preventDefault();
          navigate(target.path);
        }
        return;
      }
      armedAt.current = key === 'g' ? event.timeStamp : null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, enabled]);
}
