/**
 * A live number that flashes floodlight for 1 s when it changes (redesign handoff S 1a "Screen
 * states": a changed number flashes so desk staff notice it). Not on the first render; reduced
 * motion removes the animation and leaves the number.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './primitives.css';

export const FLASH_MS = 1_000;

export function Flash({
  value,
  children,
  className,
}: {
  /** What is compared between renders. */
  value: string | number;
  children: ReactNode;
  className?: string;
}) {
  const previous = useRef(value);
  const [flashes, setFlashes] = useState(0);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlashes((n) => n + 1);
    const id = setTimeout(() => setFlashes(0), FLASH_MS);
    return () => clearTimeout(id);
  }, [value]);
  return (
    <span
      key={flashes}
      className={[flashes > 0 ? 'ui-flash' : null, className].filter(Boolean).join(' ')}
      data-flash={flashes > 0 || undefined}
    >
      {children}
    </span>
  );
}
