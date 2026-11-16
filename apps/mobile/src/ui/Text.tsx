/**
 * Text of the visual system v2 (ADR-008, **Proposed**): one component for every line of words, in
 * the type scale of `theme.ts` and a tone that follows the theme. It is to replace the feature
 * kits' Body, Caption, Paragraph and Detail as screens are rebuilt.
 *
 * - `variant` picks the type style (below). Sizes are base sizes: the OS text-size setting scales
 *   them (no `allowFontScaling={false}`), and nothing is set in capitals.
 * - `tone` picks the colour token. Tones for filled surfaces (`onMedia`, `onMediaMuted` over the
 *   artwork scrim, `onTonal` on a tonal fill, `inverse` on a night surface) are only for text on
 *   that surface: their contrast is checked against it (`__tests__/theme.test.tsx`).
 * - `heading` exposes the line as a header to VoiceOver and TalkBack (SPK-UX-009), so people can
 *   move between the sections of a screen. The variant alone never makes a header.
 * - `tabular` sets fixed-width figures (times, scores, amounts), so digits do not shift.
 */
import {
  Text as NativeText,
  type TextProps as NativeTextProps,
  type TextStyle,
} from 'react-native';
import { makeStyles, tabularFigures, type, type ThemeColors } from './theme';

/** Variant names and the type style each one draws with. */
export const TEXT_VARIANTS = {
  /** The big title at the top of a tab (34/41). */
  largeTitle: type.largeTitle,
  /** A hero or sheet title (26/32). */
  title1: type.title1,
  /** Card and page titles (22/28). */
  title2: type.title,
  /** A card title in a list (19/24). */
  title3: type.title3,
  /** A row title or a short emphasised line (17/24, semibold). */
  headline: type.heading,
  /** Running text (16/23). */
  body: type.body,
  /** Secondary lines next to body text (15/21). */
  callout: type.callout,
  /** Supporting text under a title (14/20). */
  caption: type.caption,
  /** Notes under a control or a card (13/18). */
  footnote: type.footnote,
  /** A quiet label above the content it names (13/18, semibold). */
  label: type.eyebrow,
  /** Badges and tab labels only (12/16): never body text. */
  micro: type.micro,
} as const satisfies Record<string, TextStyle>;

export type TextVariant = keyof typeof TEXT_VARIANTS;

/** Tone names and the colour token each one draws with. */
export const TEXT_TONES = {
  default: 'text',
  muted: 'textMuted',
  accent: 'primary',
  danger: 'danger',
  /** Over the artwork scrim only. */
  onMedia: 'onMedia',
  /** Over the artwork scrim only. */
  onMediaMuted: 'onMediaMuted',
  /** On a tonal fill only. */
  onTonal: 'onTonal',
  /** On a night surface (hero cards, the pass) only. */
  inverse: 'onNight',
} as const satisfies Record<string, keyof ThemeColors>;

export type TextTone = keyof typeof TEXT_TONES;

export interface TextProps extends NativeTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  /** A header for screen readers (section and screen titles). */
  heading?: boolean;
  /** Fixed-width figures. */
  tabular?: boolean;
}

const useStyles = makeStyles(({ colors }) => ({
  ...TEXT_VARIANTS,
  tabular: tabularFigures,
  // Tones under their own keys, so they never clash with a variant name.
  tone_default: { color: colors[TEXT_TONES.default] },
  tone_muted: { color: colors[TEXT_TONES.muted] },
  tone_accent: { color: colors[TEXT_TONES.accent] },
  tone_danger: { color: colors[TEXT_TONES.danger] },
  tone_onMedia: { color: colors[TEXT_TONES.onMedia] },
  tone_onMediaMuted: { color: colors[TEXT_TONES.onMediaMuted] },
  tone_onTonal: { color: colors[TEXT_TONES.onTonal] },
  tone_inverse: { color: colors[TEXT_TONES.inverse] },
}));

export function Text({
  variant = 'body',
  tone = 'default',
  heading = false,
  tabular = false,
  style,
  accessibilityRole,
  ...text
}: TextProps) {
  const styles = useStyles();
  return (
    <NativeText
      {...text}
      accessibilityRole={heading ? 'header' : accessibilityRole}
      style={[styles[variant], styles[`tone_${tone}`], tabular && styles.tabular, style]}
    />
  );
}
