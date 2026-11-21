/**
 * SegmentedControl (redesign handoff: Day / Week, Decide later / Pick a date now): a radio group
 * on a sunk track, the chosen segment raised. Arrow keys move and choose (roving tab index), as
 * the ARIA radio group pattern does (SPK-UX-009).
 */
import { useId, useRef, type KeyboardEvent } from 'react';
import './primitives.css';

export interface Segment<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export function SegmentedControl<V extends string>({
  label,
  segments,
  value,
  onChange,
  size = 'md',
}: {
  /** Accessible name of the group. */
  label: string;
  segments: readonly Segment<V>[];
  value: V;
  onChange: (value: V) => void;
  /** `lg`: 52 px segments for the desk tablet (scan-time controls). */
  size?: 'md' | 'lg';
}) {
  const name = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = segments.filter((s) => !s.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0 || enabled.length === 0) return;
    event.preventDefault();
    const at = enabled.findIndex((s) => s.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length]!;
    onChange(next.value);
    refs.current[segments.indexOf(next)]?.focus();
  };

  return (
    <div className="ui-segmented" role="radiogroup" aria-label={label} data-size={size}>
      {segments.map((segment, i) => {
        const checked = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            name={name}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={segment.disabled}
            className="ui-segment"
            onClick={() => onChange(segment.value)}
            onKeyDown={onKeyDown}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
