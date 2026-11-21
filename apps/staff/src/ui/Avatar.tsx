/**
 * Avatar (redesign handoff, Phase 0): the person's uploaded photo, or their initials on their
 * person colour when there is none (or it fails to load), with an optional ring in that colour.
 * Decorative when the name is written next to it (`decorative`); otherwise it is an image named
 * after the person (SPK-UX-009).
 *
 * The person colour is steady for a person: `personColour(id)` picks one of the five handoff
 * colours (`--person-1` to `--person-5` in styles.css) from the id, so a child keeps the same
 * colour on every screen without the API storing one.
 */
import { useState, type CSSProperties } from 'react';
import './primitives.css';

export const PERSON_COLOURS = 5;

/** A stable person colour index (1 to 5) for an id or a name. */
export function personColour(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return (hash % PERSON_COLOURS) + 1;
}

/** "Maya Ortiz" → "MO"; "T. Nguyen" → "TN"; one word → its first letter. */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({
  name,
  personKey,
  photoUrl,
  size = 34,
  ring = false,
  decorative = false,
  className,
}: {
  name: string;
  /** What the colour follows (the person id); the name when absent. */
  personKey?: string;
  photoUrl?: string | null;
  size?: number;
  /** A ring in the person colour (the selected child, a checked-in face). */
  ring?: boolean;
  /** The name is written beside it: hide the avatar from assistive technology. */
  decorative?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const colour = personColour(personKey ?? name);
  const style = {
    '--avatar-size': `${size}px`,
    '--avatar-bg': `var(--person-${colour}-bg)`,
    '--avatar-ink': `var(--person-${colour}-ink)`,
    '--avatar-ring': `var(--person-${colour})`,
  } as CSSProperties;
  const showPhoto = Boolean(photoUrl) && !failed;
  return (
    <span
      className={['ui-avatar', className].filter(Boolean).join(' ')}
      data-ring={ring || undefined}
      data-colour={colour}
      style={style}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {showPhoto ? (
        <img src={photoUrl as string} alt="" onError={() => setFailed(true)} />
      ) : (
        <span className="ui-avatar-initials">{initialsOf(name)}</span>
      )}
    </span>
  );
}
