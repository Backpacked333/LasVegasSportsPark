/**
 * Modal focus handling shared by the Drawer, the BottomSheet and the lock screen (SPK-UX-009,
 * handoff "Sheets": focus moves into the surface and returns to the control that opened it).
 *
 * While `active`: focus moves to the first focusable element inside `ref` (or the surface itself),
 * Tab and Shift+Tab stay inside, Escape calls `onEscape`. When it ends, focus goes back to the
 * element that had it before.
 */
import { useEffect, useRef, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.closest('[inert]'),
  );
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(root)[0];
    (first ?? root).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escape.current) {
        event.preventDefault();
        event.stopPropagation();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
      } else if (event.shiftKey && index === 0) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        head.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, ref]);
}
