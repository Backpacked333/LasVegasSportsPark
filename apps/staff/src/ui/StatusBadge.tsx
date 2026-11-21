/**
 * StatusBadge: glyph plus text, never colour alone (SPK-UX-009, SPK-UX-004). The text is the full
 * status phrase (docs/package-a/journeys.md section 3; staff labels use machine state names) and is
 * what screen readers read; the glyph is decorative.
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'pending';

/**
 * The six tones of the redesign handoff (README "Status tones"): success, warning, error, info,
 * neutral and pending (proposed). `error` is the handoff's name for `danger`; both are accepted.
 */
export type HandoffTone = StatusTone | 'error';

export function toneOf(tone: HandoffTone): StatusTone {
  return tone === 'error' ? 'danger' : tone;
}

/** One distinct shape per tone, so tones differ in greyscale and for colour-blind users. */
export const STATUS_GLYPHS: Record<StatusTone, string> = {
  success: '✓',
  warning: '▲',
  danger: '✕',
  info: 'ℹ',
  neutral: '●',
  pending: '◷',
};

/**
 * A lifecycle's state name as plain words: "in_service" reads "in service" (SPK-UX-010 clear,
 * consistent wording). Only names written in lower case with underscores change; a reference or
 * code in capitals (DEC-018, ACCESS_DENIED), an action id (entry.sync_offline) and a file name
 * (daily_schedule-2026-10-24.csv) are left as written.
 */
export function plainWords(label: string): string {
  return label.replace(/(?<![\w.\-/])[a-z]+(?:_[a-z]+)+(?![\w\-/]|\.\w)/g, (name) =>
    name.replace(/_/g, ' '),
  );
}

export function StatusBadge({
  tone: given,
  label,
  size,
}: {
  tone: HandoffTone;
  label: string;
  /** `sm`: the 20 px chip of dense cards (issue tags, check chips). */
  size?: 'sm';
}) {
  const tone = toneOf(given);
  return (
    <span
      className={['badge', `tone-${tone}`, size === 'sm' ? 'badge-sm' : null]
        .filter(Boolean)
        .join(' ')}
      data-tone={tone}
    >
      <span aria-hidden="true">{STATUS_GLYPHS[tone]}</span>
      <span className="badge-label">{plainWords(label)}</span>
    </span>
  );
}
