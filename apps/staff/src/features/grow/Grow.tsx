/**
 * Small presentational pieces shared by the "Grow" screens (SPK-UX-010 redesign): a capacity
 * meter whose numbers are always written (the bar only accompanies them, SPK-UX-009), initials
 * avatars (decorative: the name is always written beside them), segmented filter buttons with
 * `aria-pressed`, and a readiness checklist row whose glyph and text carry the state.
 */
import type { ReactNode } from 'react';
import { STATUS_GLYPHS, type StatusTone } from '../../ui/StatusBadge';
import './grow.css';

/** Whole-number percent of `part` in `whole`, clamped to 0..100; 0 when there is no whole. */
export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * Committed (and held) places against a capacity. The text says the numbers; the bar is hidden
 * from assistive technology because it repeats them.
 */
export function CapacityMeter({
  capacity,
  committed,
  held = 0,
  unit,
  note,
}: {
  capacity: number;
  committed: number;
  held?: number;
  /** What a place is, e.g. "seats"; written after the numbers. */
  unit?: string;
  /** Right-hand text; defaults to the places left, or "Full". */
  note?: ReactNode;
}) {
  const left = Math.max(0, capacity - committed - held);
  const full = capacity > 0 && left === 0;
  return (
    <div className="meter" data-full={full}>
      <span className="meter-bar" aria-hidden="true">
        <span className="meter-committed" style={{ width: `${percent(committed, capacity)}%` }} />
        {held > 0 ? (
          <span className="meter-held" style={{ width: `${percent(held, capacity)}%` }} />
        ) : null}
      </span>
      <span className="meter-text">
        <strong>
          {committed} / {capacity}
          {unit ? ` ${unit}` : ''}
          {held > 0 ? ` · ${held} held` : ''}
        </strong>
        <span className="meter-note">
          {note ?? (full ? 'Full' : `${left} ${left === 1 ? 'place' : 'places'} left`)}
        </span>
      </span>
    </div>
  );
}

const AVATAR_COLOURS = ['#0b6b3a', '#2d5bd8', '#b0306b', '#c4541c', '#5b3fa8', '#0e7c74'];

/** Up to two initials of a written name. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** A stable colour per id, so the same person keeps the same avatar colour. */
function colourOf(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length] ?? AVATAR_COLOURS[0]!;
}

export function Avatar({
  name,
  seed,
  size = 'md',
}: {
  name: string;
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      className="grow-avatar"
      data-size={size}
      aria-hidden="true"
      style={size === 'sm' ? undefined : { ['--avatar' as string]: colourOf(seed ?? name) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Segmented filter: one choice pressed; every choice is a real button (keyboard, SPK-UX-009). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One readiness line: glyph and label carry the state together. */
export function CheckRow({
  tone,
  label,
  value,
}: {
  tone: StatusTone;
  label: ReactNode;
  value?: ReactNode;
}) {
  return (
    <li>
      <span className="check-glyph" data-tone={tone} aria-hidden="true">
        {STATUS_GLYPHS[tone]}
      </span>
      <span className="check-label">{label}</span>
      {value !== undefined ? <span className="check-value">{value}</span> : null}
    </li>
  );
}
