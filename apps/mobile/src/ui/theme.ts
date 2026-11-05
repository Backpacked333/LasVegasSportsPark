/**
 * Design tokens (SPK-UX-010: clear hierarchy, strong readability in busy facilities, restrained
 * animation). Colour supports a status but never carries it alone (SPK-UX-009): every tone also has
 * a distinct glyph and a text label (see StatusBadge). Text sizes are base sizes; the OS text-size
 * setting scales them (no `allowFontScaling={false}` anywhere).
 *
 * The soccer-specific visual identity is not designed yet; these are neutral, accessible defaults.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#F4F6F5',
  text: '#101814',
  textMuted: '#4A5651',
  border: '#C9D1CD',
  primary: '#0B6B3A',
  primaryText: '#FFFFFF',
  focus: '#1A4FD6',
  success: '#0B6B3A',
  warning: '#8A5300',
  danger: '#B3261E',
  info: '#1A4FD6',
  neutral: '#4A5651',
  pending: '#5B3FA8',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, lineHeight: 28 },
  heading: { fontSize: 18, fontWeight: '600' as const, lineHeight: 24 },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 22 },
  caption: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
} as const;

/** Minimum touch target (44 pt, iOS HIG; 48 dp on Android is met with padding). */
export const MIN_TOUCH_SIZE = 44;
