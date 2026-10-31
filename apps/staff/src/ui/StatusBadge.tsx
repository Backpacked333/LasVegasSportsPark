/**
 * StatusBadge: glyph plus text, never colour alone (SPK-UX-009, SPK-UX-004). The text is the full
 * status phrase (docs/package-a/journeys.md section 3; staff labels use machine state names) and is
 * what screen readers read; the glyph is decorative.
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'pending';

/** One distinct shape per tone, so tones differ in greyscale and for colour-blind users. */
export const STATUS_GLYPHS: Record<StatusTone, string> = {
  success: '✓',
  warning: '▲',
  danger: '✕',
  info: 'ℹ',
  neutral: '●',
  pending: '◷',
};

export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={`badge tone-${tone}`} data-tone={tone}>
      <span aria-hidden="true">{STATUS_GLYPHS[tone]}</span>
      <span className="badge-label">{label}</span>
    </span>
  );
}
